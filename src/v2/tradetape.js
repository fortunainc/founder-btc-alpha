/**
 * BTC Alpha V2.1 — rolling trade tape (order-flow substrate).
 *
 * Aggregates public-exchange TRADES (not quotes): each print carries a price, a
 * size, and the AGGRESSOR side (the taker — 'buy' lifted the offer, 'sell' hit
 * the bid). From this it derives signed delta / CVD, aggressor imbalance, trade
 * rate, and a volume-weighted price. This is the substrate the order-flow and
 * VWAP factors read. Pure and deterministic; no I/O, no clock reads.
 */

const DEFAULT_MAX_AGE_MS = 5 * 60_000;

export class TradeTape {
  constructor({ maxAgeMs = DEFAULT_MAX_AGE_MS } = {}) {
    this.maxAgeMs = maxAgeMs;
    /** @type {{ts:number, price:number, size:number, dir:1|-1}[]} ascending by ts */
    this.trades = [];
  }

  /** Ingest one trade. dir from aggressor: 'buy' → +1 (up pressure), 'sell' → -1. */
  add(ts, price, size, aggressor) {
    if (!Number.isFinite(ts) || !Number.isFinite(price) || price <= 0) return;
    if (!Number.isFinite(size) || size <= 0) return;
    const dir = aggressor === 'buy' ? 1 : aggressor === 'sell' ? -1 : 0;
    if (dir === 0) return;
    const last = this.trades[this.trades.length - 1];
    if (last && ts < last.ts) ts = last.ts; // never accept a backwards clock; clamp
    this.trades.push({ ts, price, size, dir });
    this._evict(ts);
  }

  _evict(now) {
    const cutoff = now - this.maxAgeMs;
    let i = 0;
    while (i < this.trades.length && this.trades[i].ts < cutoff) i += 1;
    if (i > 0) this.trades.splice(0, i);
  }

  _slice(windowMs, now) {
    const start = now - windowMs;
    return this.trades.filter((t) => t.ts >= start && t.ts <= now);
  }

  /** Signed aggressor volume (buy − sell) over the trailing window. */
  delta(windowMs, now) {
    let d = 0;
    for (const t of this._slice(windowMs, now)) d += t.dir * t.size;
    return d;
  }

  /** Total aggressor volume over the window. */
  volume(windowMs, now) {
    let v = 0;
    for (const t of this._slice(windowMs, now)) v += t.size;
    return v;
  }

  /** Aggressor imbalance in [-1,1]: delta / volume. 0 when no trades. */
  imbalance(windowMs, now) {
    const s = this._slice(windowMs, now);
    let d = 0, v = 0;
    for (const t of s) { d += t.dir * t.size; v += t.size; }
    return v > 0 ? d / v : 0;
  }

  /** Trades per second over the window (activity gauge). */
  rate(windowMs, now) {
    const n = this._slice(windowMs, now).length;
    return windowMs > 0 ? n / (windowMs / 1000) : 0;
  }

  /** Volume-weighted average price over the window (the VWAP factor reads this). null if empty. */
  vwap(windowMs, now) {
    let pv = 0, v = 0;
    for (const t of this._slice(windowMs, now)) { pv += t.price * t.size; v += t.size; }
    return v > 0 ? pv / v : null;
  }

  /** Net price change across the window (last − first), for absorption checks. */
  priceChange(windowMs, now) {
    const s = this._slice(windowMs, now);
    if (s.length < 2) return null;
    return s[s.length - 1].price - s[0].price;
  }

  count(windowMs, now) { return this._slice(windowMs, now).length; }
  get size() { return this.trades.length; }
}

export default TradeTape;
