/**
 * BTC Alpha V2.1 — market structure (F2), from the rolling bar buffer only.
 *
 * Detects swing highs/lows on sampled closes, classifies trend (higher-highs +
 * higher-lows = up; lower-highs + lower-lows = down; else range), and flags a
 * fresh breakout of the most recent swing. No new data source — it reads the
 * BarBuilder already fed by replica ticks. Pure and deterministic.
 *
 * Emits the arbiter's evidence shape:
 *   { key:'F2_structure', side:'yes'|'no'|'flat', strength:0..1, trend:bool,
 *     breakout:{active,side}|null, reading, detail }
 * where side 'yes' favors BTC finishing ABOVE the strike (an up-structure).
 */

const SAMPLE_MS = 20_000;   // sample a close every 20s
const SAMPLES = 33;         // ~11 min of structure lookback
const PIVOT_W = 2;          // a swing needs to be the extreme of ±2 neighbours

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

/** Swing pivots on a close series. Returns {highs:[{i,v}], lows:[{i,v}]} in time order. */
function pivots(px) {
  const highs = [], lows = [];
  for (let i = PIVOT_W; i < px.length - PIVOT_W; i += 1) {
    let isHigh = true, isLow = true;
    for (let j = i - PIVOT_W; j <= i + PIVOT_W; j += 1) {
      if (j === i) continue;
      if (px[j] >= px[i]) isHigh = false;
      if (px[j] <= px[i]) isLow = false;
    }
    if (isHigh) highs.push({ i, v: px[i] });
    if (isLow) lows.push({ i, v: px[i] });
  }
  return { highs, lows };
}

export function f2Structure(ctx) {
  const { bars, now } = ctx;
  const flat = (reading, detail = {}) => ({ key: 'F2_structure', side: 'flat', strength: 0, trend: false, breakout: null, reading, detail });
  if (!bars || typeof bars.closes !== 'function') return flat('structure: no data');

  const px = bars.closes(SAMPLE_MS, SAMPLES, now);
  if (px.length < 2 * PIVOT_W + 3) return flat('structure: not enough history', { n: px.length });

  const { highs, lows } = pivots(px);
  const last = px[px.length - 1];

  let side = 'flat', trend = false, strength = 0, label = 'balanced / no clear structure';
  if (highs.length >= 2 && lows.length >= 2) {
    const h1 = highs[highs.length - 2].v, h2 = highs[highs.length - 1].v;
    const l1 = lows[lows.length - 2].v, l2 = lows[lows.length - 1].v;
    const up = h2 > h1 && l2 > l1;        // higher-high + higher-low
    const down = h2 < h1 && l2 < l1;      // lower-high + lower-low
    if (up || down) {
      trend = true;
      side = up ? 'yes' : 'no';
      // strength from how decisively the structure has shifted, relative to price
      const move = (Math.abs(h2 - h1) + Math.abs(l2 - l1)) / 2;
      strength = clamp01((move / last) * 400); // ~0.25% shift => full strength
      label = up ? 'uptrend (higher highs + higher lows)' : 'downtrend (lower highs + lower lows)';
    }
  }

  // Fresh breakout: current price beyond the most recent opposing swing.
  let breakout = null;
  if (highs.length) {
    const lastHigh = highs[highs.length - 1].v;
    if (last > lastHigh) breakout = { active: true, side: 'yes' };
  }
  if (!breakout && lows.length) {
    const lastLow = lows[lows.length - 1].v;
    if (last < lastLow) breakout = { active: true, side: 'no' };
  }
  if (breakout && strength < 0.3) strength = 0.3; // a break is at least modest evidence

  return {
    key: 'F2_structure', side, strength: Number(strength.toFixed(3)), trend, breakout,
    reading: `structure: ${label}${breakout ? ` · fresh ${breakout.side === 'yes' ? 'up' : 'down'}-break` : ''}`,
    detail: { n: px.length, highs: highs.length, lows: lows.length, last },
  };
}

export default f2Structure;
