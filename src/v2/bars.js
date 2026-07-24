/**
 * BTC Alpha V2 — continuous rolling price/bar layer.
 *
 * Window-independent: BTC price is continuous, so the 15-minute Kalshi boundary
 * is NOT a price discontinuity. This buffer keeps a rolling tick history and
 * derives OHLC bars + returns + realized vol on demand, so at minute 3 of any
 * window the higher-timeframe lookback is already available (given >=15 min of
 * warm history).
 *
 * Pure, deterministic, testable: feed it (tsMs, price) ticks, ask for returns,
 * closes, OHLC, or realized vol. No I/O, no clock reads.
 */

const DEFAULT_MAX_AGE_MS = 20 * 60_000; // keep ~20 min so 15m lookback is warm

export class BarBuilder {
  /** @param {{maxAgeMs?:number}} [opts] */
  constructor({ maxAgeMs = DEFAULT_MAX_AGE_MS } = {}) {
    this.maxAgeMs = maxAgeMs;
    /** @type {{ts:number, price:number}[]} ascending by ts */
    this.ticks = [];
  }

  /** Ingest one price tick. Ignores non-finite prices and out-of-order/stale ts. */
  add(ts, price) {
    if (!Number.isFinite(ts) || !Number.isFinite(price) || price <= 0) return;
    const last = this.ticks[this.ticks.length - 1];
    if (last && ts < last.ts) return; // never accept out-of-order
    this.ticks.push({ ts, price });
    this._evict(ts);
  }

  _evict(now) {
    const cutoff = now - this.maxAgeMs;
    let i = 0;
    while (i < this.ticks.length && this.ticks[i].ts < cutoff) i += 1;
    if (i > 0) this.ticks.splice(0, i);
  }

  /** How much continuous history we hold, in ms. */
  historyMs(now = this._lastTs()) {
    if (this.ticks.length < 2) return 0;
    return now - this.ticks[0].ts;
  }

  /** True once we hold >= minMs of continuous history (warm-up gate). */
  isWarm(minMs, now = this._lastTs()) {
    return this.ticks.length >= 2 && this.historyMs(now) >= minMs;
  }

  _lastTs() {
    return this.ticks.length ? this.ticks[this.ticks.length - 1].ts : NaN;
  }

  /** Most recent price at or before tsTarget (nearest earlier tick). null if none. */
  priceAt(tsTarget) {
    let lo = 0;
    let hi = this.ticks.length - 1;
    let ans = null;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (this.ticks[mid].ts <= tsTarget) {
        ans = this.ticks[mid].price;
        lo = mid + 1;
      } else {
        hi = mid - 1;
      }
    }
    return ans;
  }

  /** Current (latest) price, or null. */
  last() {
    return this.ticks.length ? this.ticks[this.ticks.length - 1].price : null;
  }

  /**
   * Log return over the last `ms` milliseconds ending at `now`.
   * null if either endpoint is unavailable (insufficient history).
   */
  returnOver(ms, now = this._lastTs()) {
    if (!Number.isFinite(now)) return null;
    const p1 = this.priceAt(now);
    const p0 = this.priceAt(now - ms);
    if (p0 == null || p1 == null || p0 <= 0 || p1 <= 0) return null;
    // require the lookback endpoint to be genuinely that old, not just the first tick
    if (this.ticks[0].ts > now - ms) return null;
    return Math.log(p1 / p0);
  }

  /**
   * Close prices sampled every `intervalMs`, most recent `count` closes ascending.
   * A close is the last tick at or before each grid boundary.
   */
  closes(intervalMs, count, now = this._lastTs()) {
    if (!Number.isFinite(now) || intervalMs <= 0) return [];
    const out = [];
    for (let i = count - 1; i >= 0; i -= 1) {
      const boundary = now - i * intervalMs;
      const p = this.priceAt(boundary);
      if (p != null) out.push(p);
    }
    return out;
  }

  /**
   * OHLC bars of width `intervalMs`, most recent `count` bars ascending.
   * Each bar aggregates the ticks that fall in [start, start+intervalMs).
   */
  ohlc(intervalMs, count, now = this._lastTs()) {
    if (!Number.isFinite(now) || intervalMs <= 0 || !this.ticks.length) return [];
    const bars = [];
    for (let i = count - 1; i >= 0; i -= 1) {
      const end = now - i * intervalMs;
      const start = end - intervalMs;
      const inBar = this.ticks.filter((t) => t.ts >= start && t.ts < end);
      if (!inBar.length) continue;
      const prices = inBar.map((t) => t.price);
      bars.push({
        start, end,
        open: prices[0],
        high: Math.max(...prices),
        low: Math.min(...prices),
        close: prices[prices.length - 1],
        n: prices.length,
      });
    }
    return bars;
  }

  /**
   * Realized volatility as the std-dev of log returns between consecutive
   * `stepMs`-spaced closes over the trailing `windowMs`, expressed PER SECOND
   * (so `sigmaPerSec * sqrt(tauSec)` is a coherent horizon move). null if thin.
   */
  realizedVolPerSec(windowMs, stepMs, now = this._lastTs()) {
    if (!Number.isFinite(now) || stepMs <= 0) return null;
    const steps = Math.floor(windowMs / stepMs);
    if (steps < 3) return null;
    const px = [];
    for (let i = steps; i >= 0; i -= 1) {
      const p = this.priceAt(now - i * stepMs);
      if (p == null) return null;
      px.push(p);
    }
    if (this.ticks[0].ts > now - windowMs) return null; // not enough true history
    const rets = [];
    for (let i = 1; i < px.length; i += 1) rets.push(Math.log(px[i] / px[i - 1]));
    const mean = rets.reduce((s, r) => s + r, 0) / rets.length;
    const varr = rets.reduce((s, r) => s + (r - mean) ** 2, 0) / (rets.length - 1);
    const sigmaPerStep = Math.sqrt(varr);
    return sigmaPerStep / Math.sqrt(stepMs / 1000); // -> per-second
  }
}

export default BarBuilder;
