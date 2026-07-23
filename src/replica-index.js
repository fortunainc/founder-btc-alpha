/**
 * BTC replica index — a documented APPROXIMATION of CF Benchmarks' BRTI.
 *
 * Kalshi settles KXBTC15M against CF Benchmarks' BRTI. BRTI's exact
 * construction is proprietary; this module re-implements a public-data
 * approximation of it and is explicitly labelled as such everywhere it is
 * persisted. The whole point of Phase 0 is to measure how large the replica
 * error is, so this must never be presented as the real index.
 *
 * Formula (v1) — see docs/replica-methodology-v1.md for the full write-up:
 *
 *   For each venue v with a fresh, uncrossed top-of-book:
 *     mid_v    = (bid_v + ask_v) / 2
 *     spread_v = ask_v - bid_v
 *     depth_v  = bid_size_v + ask_size_v          (top of book only)
 *     w_v      = (1 / max(spread_v, tick)) * sqrt(max(depth_v, eps))
 *
 *   Outlier rejection: drop any venue whose mid deviates from the cross-venue
 *   MEDIAN by more than OUTLIER_BPS basis points.
 *
 *   index = sum(w_v * mid_v) / sum(w_v)      over surviving venues
 *
 * Inverse-spread weighting is the key BRTI-like property: it lets the venue
 * with the tightest, most liquid market dominate, which is what a real-time
 * consolidated index should do. Published at 1 Hz.
 *
 * NO API KEYS: every feed here is a public market-data WebSocket.
 */

import WebSocket from 'ws';
import { EventEmitter } from 'node:events';

export const REPLICA_METHODOLOGY_VERSION = 'replica-methodology-v1';

const STALE_MS = 10_000; // a venue quote older than this is excluded
const OUTLIER_BPS = 50; // 0.50% from the median -> excluded
const MIN_VENUES = 2; // fewer than this -> index is null, not guessed
const TICK_FLOOR = 0.01; // guards divide-by-zero on a zero spread

// ---------------------------------------------------------------------
// Venue adapters. Each normalises its feed to {bid, ask, bidSize, askSize}.
// ---------------------------------------------------------------------

const VENUES = {
  coinbase: {
    url: 'wss://ws-feed.exchange.coinbase.com',
    subscribe: () =>
      JSON.stringify({
        type: 'subscribe',
        product_ids: ['BTC-USD'],
        channels: ['ticker'],
      }),
    parse: (msg) => {
      if (msg.type !== 'ticker' || msg.product_id !== 'BTC-USD') return null;
      const bid = Number(msg.best_bid);
      const ask = Number(msg.best_ask);
      if (!Number.isFinite(bid) || !Number.isFinite(ask)) return null;
      return {
        bid,
        ask,
        bidSize: Number(msg.best_bid_size) || 0,
        askSize: Number(msg.best_ask_size) || 0,
      };
    },
  },

  kraken: {
    url: 'wss://ws.kraken.com/v2',
    subscribe: () =>
      JSON.stringify({
        method: 'subscribe',
        params: { channel: 'ticker', symbol: ['BTC/USD'] },
      }),
    parse: (msg) => {
      if (msg.channel !== 'ticker' || !Array.isArray(msg.data)) return null;
      const d = msg.data[0];
      if (!d) return null;
      const bid = Number(d.bid);
      const ask = Number(d.ask);
      if (!Number.isFinite(bid) || !Number.isFinite(ask)) return null;
      return {
        bid,
        ask,
        bidSize: Number(d.bid_qty) || 0,
        askSize: Number(d.ask_qty) || 0,
      };
    },
  },

  bitstamp: {
    url: 'wss://ws.bitstamp.net',
    subscribe: () =>
      JSON.stringify({
        event: 'bts:subscribe',
        data: { channel: 'order_book_btcusd' },
      }),
    parse: (msg) => {
      if (msg.event !== 'data' || !msg.data?.bids?.length || !msg.data?.asks?.length) {
        return null;
      }
      const [bidPx, bidSz] = msg.data.bids[0];
      const [askPx, askSz] = msg.data.asks[0];
      const bid = Number(bidPx);
      const ask = Number(askPx);
      if (!Number.isFinite(bid) || !Number.isFinite(ask)) return null;
      return { bid, ask, bidSize: Number(bidSz) || 0, askSize: Number(askSz) || 0 };
    },
  },

  gemini: {
    // v2 marketdata: explicit l2 subscription, snapshot then deltas.
    url: 'wss://api.gemini.com/v2/marketdata',
    subscribe: () =>
      JSON.stringify({ type: 'subscribe', subscriptions: [{ name: 'l2', symbols: ['BTCUSD'] }] }),
    // Gemini needs local book state to derive top-of-book from deltas.
    stateful: true,
    parse: (msg, state) => {
      if (msg.type === 'l2_updates' && msg.symbol === 'BTCUSD') {
        if (!state.bids) {
          state.bids = new Map();
          state.asks = new Map();
        }
        for (const [side, priceStr, qtyStr] of msg.changes || []) {
          const price = Number(priceStr);
          const qty = Number(qtyStr);
          const book = side === 'buy' ? state.bids : state.asks;
          if (qty === 0) book.delete(price);
          else book.set(price, qty);
        }
        if (!state.bids.size || !state.asks.size) return null;
        let bid = -Infinity;
        let ask = Infinity;
        for (const p of state.bids.keys()) if (p > bid) bid = p;
        for (const p of state.asks.keys()) if (p < ask) ask = p;
        if (!Number.isFinite(bid) || !Number.isFinite(ask)) return null;
        return {
          bid,
          ask,
          bidSize: state.bids.get(bid) || 0,
          askSize: state.asks.get(ask) || 0,
        };
      }
      return null;
    },
  },
};

// ---------------------------------------------------------------------

/** Median of a numeric array. */
export function median(values) {
  if (!values.length) return null;
  const s = [...values].sort((a, b) => a - b);
  const mid = Math.floor(s.length / 2);
  return s.length % 2 ? s[mid] : (s[mid - 1] + s[mid]) / 2;
}

/**
 * Pure index computation — separated from all I/O so it can be unit-tested
 * against fixed venue quotes.
 *
 * @param {Object<string,{bid:number,ask:number,bidSize:number,askSize:number,ts:number}>} quotes
 * @param {number} now epoch ms
 */
export function computeIndex(quotes, now = Date.now()) {
  const usable = [];
  const excluded = {};

  for (const [venue, q] of Object.entries(quotes)) {
    if (!q) {
      excluded[venue] = 'no_quote';
      continue;
    }
    if (now - q.ts > STALE_MS) {
      excluded[venue] = 'stale';
      continue;
    }
    if (!(q.ask > q.bid)) {
      excluded[venue] = 'crossed_or_locked';
      continue;
    }
    if (!Number.isFinite(q.bid) || !Number.isFinite(q.ask) || q.bid <= 0) {
      excluded[venue] = 'invalid';
      continue;
    }
    usable.push({ venue, mid: (q.bid + q.ask) / 2, spread: q.ask - q.bid, depth: (q.bidSize || 0) + (q.askSize || 0) });
  }

  if (usable.length < MIN_VENUES) {
    return {
      index: null,
      venues_used: usable.map((u) => u.venue),
      venues_excluded: excluded,
      reason: `only ${usable.length} usable venue(s), minimum ${MIN_VENUES}`,
    };
  }

  // Outlier rejection against the cross-venue median.
  const med = median(usable.map((u) => u.mid));
  const survivors = [];
  for (const u of usable) {
    const devBps = Math.abs(u.mid - med) / med * 10_000;
    if (devBps > OUTLIER_BPS) {
      excluded[u.venue] = `outlier_${devBps.toFixed(1)}bps`;
    } else {
      survivors.push(u);
    }
  }

  if (survivors.length < MIN_VENUES) {
    return {
      index: null,
      venues_used: [],
      venues_excluded: excluded,
      reason: `only ${survivors.length} venue(s) survived outlier rejection`,
    };
  }

  let num = 0;
  let den = 0;
  const weights = {};
  for (const u of survivors) {
    const w = (1 / Math.max(u.spread, TICK_FLOOR)) * Math.sqrt(Math.max(u.depth, 1e-9));
    weights[u.venue] = w;
    num += w * u.mid;
    den += w;
  }

  const index = den > 0 ? num / den : null;
  const totalW = den || 1;
  const weightShare = {};
  for (const [v, w] of Object.entries(weights)) weightShare[v] = Number((w / totalW).toFixed(6));

  return {
    index: index === null ? null : Number(index.toFixed(2)),
    median_mid: Number(med.toFixed(2)),
    venues_used: survivors.map((u) => u.venue),
    venues_excluded: excluded,
    weight_share: weightShare,
    venue_count: survivors.length,
  };
}

/**
 * Fixed-size ring buffer of 1 Hz index prints, for trailing averages.
 * Sized generously so a 60s window is always available.
 */
export class TrailingWindow {
  constructor(capacitySeconds = 3600) {
    this.capacity = capacitySeconds;
    this.buf = [];
  }

  push(ts, value) {
    if (value === null || !Number.isFinite(value)) return;
    this.buf.push({ ts, value });
    const cutoff = ts - this.capacity * 1000;
    while (this.buf.length && this.buf[0].ts < cutoff) this.buf.shift();
  }

  /** Simple mean of prints in the trailing `seconds` window ending at `endTs`. */
  average(seconds, endTs = Date.now()) {
    const start = endTs - seconds * 1000;
    const vals = this.buf.filter((p) => p.ts > start && p.ts <= endTs).map((p) => p.value);
    if (!vals.length) return { avg: null, n: 0 };
    const avg = vals.reduce((a, b) => a + b, 0) / vals.length;
    return { avg: Number(avg.toFixed(2)), n: vals.length };
  }

  /**
   * Annualisation-free realized volatility over `minutes`, computed from
   * log returns of consecutive 1 Hz prints, expressed as a standard deviation
   * in decimal (not %). Returns null when the sample is too small to mean
   * anything.
   */
  realizedVol(minutes, endTs = Date.now()) {
    const start = endTs - minutes * 60_000;
    const pts = this.buf.filter((p) => p.ts > start && p.ts <= endTs);
    if (pts.length < 10) return null;
    const rets = [];
    for (let i = 1; i < pts.length; i += 1) {
      const prev = pts[i - 1].value;
      const cur = pts[i].value;
      if (prev > 0 && cur > 0) rets.push(Math.log(cur / prev));
    }
    if (rets.length < 5) return null;
    const mean = rets.reduce((a, b) => a + b, 0) / rets.length;
    const variance = rets.reduce((a, r) => a + (r - mean) ** 2, 0) / (rets.length - 1);
    return Number(Math.sqrt(variance).toExponential(6));
  }

  get size() {
    return this.buf.length;
  }
}

/**
 * Live replica index. Emits `tick` once per second with the current value.
 * Every socket reconnects with exponential backoff and full jitter.
 */
export class ReplicaIndex extends EventEmitter {
  constructor({ venues = Object.keys(VENUES), logger = console } = {}) {
    super();
    this.logger = logger;
    this.venueNames = venues;
    /** @type {Object<string, object>} latest normalised quote per venue */
    this.quotes = {};
    this.sockets = {};
    this.states = {};
    this.backoff = {};
    this.window = new TrailingWindow(3600);
    this.lastTick = null;
    this._timer = null;
    this._stopped = false;
    this.stats = { reconnects: 0, messages: 0, ticks: 0 };
  }

  start() {
    for (const name of this.venueNames) this._connect(name);
    this._timer = setInterval(() => this._tick(), 1000);
    return this;
  }

  stop() {
    this._stopped = true;
    if (this._timer) clearInterval(this._timer);
    for (const ws of Object.values(this.sockets)) {
      try {
        ws.close();
      } catch {
        /* already closed */
      }
    }
  }

  _connect(name) {
    if (this._stopped) return;
    const cfg = VENUES[name];
    if (!cfg) return;

    let ws;
    try {
      ws = new WebSocket(cfg.url, { handshakeTimeout: 10_000 });
    } catch (err) {
      this._scheduleReconnect(name, err.message);
      return;
    }
    this.sockets[name] = ws;
    if (cfg.stateful) this.states[name] = {};

    ws.on('open', () => {
      this.backoff[name] = 0;
      try {
        ws.send(cfg.subscribe());
      } catch (err) {
        this.logger.warn?.(`[replica] ${name} subscribe failed: ${err.message}`);
      }
      this.emit('venue-open', name);
    });

    ws.on('message', (raw) => {
      this.stats.messages += 1;
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      let q;
      try {
        q = cfg.parse(msg, this.states[name]);
      } catch {
        return;
      }
      if (q) this.quotes[name] = { ...q, ts: Date.now() };
    });

    ws.on('error', (err) => {
      this.emit('venue-error', name, err.message);
    });

    ws.on('close', () => {
      delete this.sockets[name];
      if (cfg.stateful) this.states[name] = {};
      this._scheduleReconnect(name, 'socket closed');
    });

    // Keep NAT/proxies from silently dropping an idle feed.
    ws.on('ping', () => {
      try {
        ws.pong();
      } catch {
        /* noop */
      }
    });
  }

  _scheduleReconnect(name, reason) {
    if (this._stopped) return;
    const n = (this.backoff[name] = (this.backoff[name] || 0) + 1);
    this.stats.reconnects += 1;
    // Exponential backoff with full jitter, capped at 30s.
    const cap = Math.min(30_000, 500 * 2 ** Math.min(n, 6));
    const delay = Math.random() * cap;
    this.emit('venue-reconnect', name, reason, Math.round(delay));
    setTimeout(() => this._connect(name), delay);
  }

  _tick() {
    const now = Date.now();
    const result = computeIndex(this.quotes, now);
    this.window.push(now, result.index);
    this.lastTick = { ts: now, ...result };
    this.stats.ticks += 1;
    this.emit('tick', this.lastTick);
  }

  /** Current trailing 60s average — the quantity Kalshi settles on. */
  trailing60s(endTs = Date.now()) {
    return this.window.average(60, endTs);
  }

  /** Vol snapshot at 1/5/15 minutes. */
  volSnapshot(endTs = Date.now()) {
    return {
      rv_1m: this.window.realizedVol(1, endTs),
      rv_5m: this.window.realizedVol(5, endTs),
      rv_15m: this.window.realizedVol(15, endTs),
    };
  }

  /** Which venues are currently contributing. */
  health() {
    const now = Date.now();
    const venues = {};
    for (const name of this.venueNames) {
      const q = this.quotes[name];
      venues[name] = {
        connected: Boolean(this.sockets[name] && this.sockets[name].readyState === 1),
        last_quote_age_ms: q ? now - q.ts : null,
        fresh: q ? now - q.ts <= STALE_MS : false,
      };
    }
    return { venues, stats: this.stats, window_size: this.window.size };
  }
}

export { VENUES, STALE_MS, OUTLIER_BPS, MIN_VENUES };
