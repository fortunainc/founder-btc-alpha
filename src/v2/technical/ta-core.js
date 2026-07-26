/**
 * v2.4 TA core — candles + trend + volatility (founder technical lock §C.4/C.6, 2026-07-26).
 * PURE. Input = raw {ts, price} ticks (index feed — NO volume: volume-dependent
 * concepts are UNSUPPORTED here and labeled so upstream, never faked).
 */

/** Aggregate ticks into fixed candles ascending. Candle = {t0,t1,open,high,low,close,complete}. */
export function buildCandles(ticks, intervalMs, now) {
  if (!Array.isArray(ticks) || !ticks.length || intervalMs <= 0) return [];
  const out = new Map();
  for (const { ts, price } of ticks) {
    const bucket = Math.floor(ts / intervalMs) * intervalMs;
    let c = out.get(bucket);
    if (!c) { c = { t0: bucket, t1: bucket + intervalMs, open: price, high: price, low: price, close: price }; out.set(bucket, c); }
    else { c.high = Math.max(c.high, price); c.low = Math.min(c.low, price); c.close = price; }
  }
  const arr = [...out.values()].sort((a, b) => a.t0 - b.t0);
  for (const c of arr) c.complete = c.t1 <= now;
  return arr;
}

export function ema(values, period) {
  if (!values.length || period <= 0) return [];
  const k = 2 / (period + 1);
  const out = [values[0]];
  for (let i = 1; i < values.length; i++) out.push(values[i] * k + out[i - 1] * (1 - k));
  return out;
}

/** ATR over completed candles (simple mean of true ranges; prev-close aware). */
export function atr(candles, period = 14) {
  const done = candles.filter((c) => c.complete);
  if (done.length < 2) return null;
  const trs = [];
  for (let i = 1; i < done.length; i++) {
    const c = done[i], p = done[i - 1];
    trs.push(Math.max(c.high - c.low, Math.abs(c.high - p.close), Math.abs(c.low - p.close)));
  }
  const w = trs.slice(-period);
  return w.length ? w.reduce((a, b) => a + b, 0) / w.length : null;
}

/** Trend read from EMAs of closes: 'up' | 'down' | 'flat' + slope info. */
export function emaTrend(candles, fast = 9, slow = 21) {
  const closes = candles.filter((c) => c.complete).map((c) => c.close);
  if (closes.length < slow) return { state: 'insufficient', fast: null, slow: null };
  const f = ema(closes, fast), s = ema(closes, slow);
  const fl = f[f.length - 1], sl = s[s.length - 1];
  const sep = (fl - sl) / sl;
  return { state: Math.abs(sep) < 0.0003 ? 'flat' : (fl > sl ? 'up' : 'down'), fast: fl, slow: sl, separation: sep };
}

/**
 * Volatility block: short realized vol (per-second), range state, expected move
 * over remaining seconds, strike reachability. sigmaPerSec injected (existing
 * pipeline computes it); candles supply ATR + expansion read.
 */
export function volatilityRead({ candles1m, sigmaPerSec, spot, strike, secondsLeft }) {
  const a = atr(candles1m, 14);
  const recent = candles1m.filter((c) => c.complete).slice(-3);
  const prior = candles1m.filter((c) => c.complete).slice(-10, -3);
  const avg = (xs) => (xs.length ? xs.reduce((s, c) => s + (c.high - c.low), 0) / xs.length : null);
  const rRecent = avg(recent), rPrior = avg(prior);
  const rangeState = rRecent == null || rPrior == null ? 'unknown'
    : rRecent > rPrior * 1.3 ? 'expanding' : rRecent < rPrior * 0.7 ? 'contracting' : 'steady';
  const expMove = (Number.isFinite(sigmaPerSec) && Number.isFinite(spot) && Number.isFinite(secondsLeft) && secondsLeft > 0)
    ? sigmaPerSec * Math.sqrt(secondsLeft) * spot : null;
  const dist = (Number.isFinite(spot) && Number.isFinite(strike)) ? Math.abs(spot - strike) : null;
  const reachability = (expMove != null && dist != null && expMove > 0) ? dist / expMove : null; // in expected-move units
  return {
    atr_1m: a, range_state: rangeState,
    expected_move_usd: expMove, distance_usd: dist,
    strike_reachability_sigma: reachability,
    strike_realistically_reachable: reachability == null ? null : reachability <= 2.0,
    note_time_awareness: 'same setup ≠ same trade: reachability is measured in remaining-time expected-move units',
  };
}
