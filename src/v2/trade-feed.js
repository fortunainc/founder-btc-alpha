/**
 * BTC Alpha V2.1 — live trade feed (order-flow source).
 *
 * Subscribes to PUBLIC trade channels (no API keys) and pushes each aggressor-
 * tagged trade into a shared TradeTape. Reuses the same resilient WebSocket + backoff
 * pattern as the replica index. Venue parsers are exported and unit-tested; the
 * aggressor convention is normalised to the TAKER side:
 *   - Coinbase 'matches': `side` is the MAKER side ⇒ aggressor is the opposite.
 *   - Kraken v2 'trade':  `side` IS the aggressor/taker side.
 *
 * Degrades gracefully: if a feed is down or a message is misparsed, the tape
 * simply stays thin and the order-flow factor returns 'flat' — the engine is
 * never worse than momentum+structure alone.
 */

import WebSocket from 'ws';

export const TRADE_VENUES = {
  coinbase: {
    url: 'wss://ws-feed.exchange.coinbase.com',
    subscribe: () => JSON.stringify({ type: 'subscribe', product_ids: ['BTC-USD'], channels: ['matches'] }),
    parse: (msg) => {
      if ((msg.type === 'match' || msg.type === 'last_match') && msg.product_id === 'BTC-USD') {
        const price = Number(msg.price), size = Number(msg.size);
        if (!(price > 0) || !(size > 0)) return null;
        // Coinbase `side` = maker side; taker aggressor is the opposite.
        const aggressor = msg.side === 'sell' ? 'buy' : msg.side === 'buy' ? 'sell' : null;
        return aggressor ? { price, size, aggressor } : null;
      }
      return null;
    },
  },
  kraken: {
    url: 'wss://ws.kraken.com/v2',
    subscribe: () => JSON.stringify({ method: 'subscribe', params: { channel: 'trade', symbol: ['BTC/USD'] } }),
    parse: (msg) => {
      if (msg.channel === 'trade' && Array.isArray(msg.data)) {
        const out = [];
        for (const d of msg.data) {
          const price = Number(d.price), size = Number(d.qty);
          const aggressor = d.side === 'buy' || d.side === 'sell' ? d.side : null; // Kraken side = taker
          if (price > 0 && size > 0 && aggressor) out.push({ price, size, aggressor });
        }
        return out.length ? out : null;
      }
      return null;
    },
  },
};

export class TradeFeed {
  constructor({ tape, venues = Object.keys(TRADE_VENUES), logger = console, now = () => Date.now() } = {}) {
    this.tape = tape;
    this.venueNames = venues;
    this.logger = logger;
    this._now = now;
    this.sockets = {};
    this.backoff = {};
    this._stopped = false;
    this.stats = { messages: 0, trades: 0, reconnects: 0 };
  }

  start() {
    for (const name of this.venueNames) this._connect(name);
    return this;
  }

  stop() {
    this._stopped = true;
    for (const ws of Object.values(this.sockets)) { try { ws.close(); } catch { /* closed */ } }
  }

  _ingest(parsed) {
    const rows = Array.isArray(parsed) ? parsed : [parsed];
    const ts = this._now();
    for (const r of rows) { this.tape.add(ts, r.price, r.size, r.aggressor); this.stats.trades += 1; }
  }

  _connect(name) {
    if (this._stopped) return;
    const cfg = TRADE_VENUES[name];
    if (!cfg) return;
    let ws;
    try { ws = new WebSocket(cfg.url, { handshakeTimeout: 10_000 }); }
    catch (err) { this._reconnect(name, err.message); return; }
    this.sockets[name] = ws;

    ws.on('open', () => {
      this.backoff[name] = 0;
      try { ws.send(cfg.subscribe()); } catch (err) { this.logger.warn?.(`[trades] ${name} subscribe: ${err.message}`); }
    });
    ws.on('message', (raw) => {
      this.stats.messages += 1;
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }
      let parsed;
      try { parsed = cfg.parse(msg); } catch { return; }
      if (parsed) this._ingest(parsed);
    });
    ws.on('error', (err) => this.logger.warn?.(`[trades] ${name} error: ${err.message}`));
    ws.on('close', () => { delete this.sockets[name]; this._reconnect(name, 'closed'); });
    ws.on('ping', () => { try { ws.pong(); } catch { /* noop */ } });
  }

  _reconnect(name, reason) {
    if (this._stopped) return;
    const n = (this.backoff[name] = (this.backoff[name] || 0) + 1);
    this.stats.reconnects += 1;
    const cap = Math.min(30_000, 500 * 2 ** Math.min(n, 6));
    const delay = Math.random() * cap;
    this.logger.warn?.(`[trades] ${name} reconnect in ${Math.round(delay)}ms (${reason})`);
    setTimeout(() => this._connect(name), delay);
  }
}

export default TradeFeed;
