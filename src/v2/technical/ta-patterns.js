/**
 * v2.4 TA patterns — STRAT, fair-value gaps, ICT-style structure/liquidity
 * (founder technical lock §C.1–C.3, 2026-07-26). PURE + deterministic: every
 * concept below is calculable, testable, replayable. Concepts that cannot be
 * defined reproducibly from an index price feed are NOT here (order blocks
 * need footprint/volume — declared unsupported upstream, never invented).
 */

// ---------- 1. THE STRAT ----------
// Candle typing vs PRIOR candle: 1 = inside, 2U = broke prior high only,
// 2D = broke prior low only, 3 = outside (broke both).
export function stratType(prev, c) {
  if (!prev || !c) return null;
  const brokeHigh = c.high > prev.high, brokeLow = c.low < prev.low;
  if (brokeHigh && brokeLow) return '3';
  if (brokeHigh) return '2U';
  if (brokeLow) return '2D';
  return '1';
}

/** Type a candle series (index i typed vs i-1). Last candle may be incomplete → developing. */
export function stratSeries(candles) {
  const out = [];
  for (let i = 1; i < candles.length; i++) {
    out.push({ t0: candles[i].t0, type: stratType(candles[i - 1], candles[i]), complete: !!candles[i].complete, close: candles[i].close, dir: candles[i].close >= candles[i].open ? 'up' : 'down' });
  }
  return out;
}

/** Actionable STRAT combos on COMPLETED candles (developing candle reported separately). */
export function stratSignals(candles) {
  const s = stratSeries(candles);
  const done = s.filter((x) => x.complete);
  const last3 = done.slice(-3).map((x) => x.type).join('-');
  const last2 = done.slice(-2).map((x) => x.type).join('-');
  const signals = [];
  if (/^2D-2U$/.test(last2)) signals.push({ name: '2D-2U reversal', side: 'up' });
  if (/^2U-2D$/.test(last2)) signals.push({ name: '2U-2D reversal', side: 'down' });
  if (/^1-2U$/.test(last2)) signals.push({ name: '1-2U inside-bar breakout', side: 'up' });
  if (/^1-2D$/.test(last2)) signals.push({ name: '1-2D inside-bar breakdown', side: 'down' });
  if (/^2U-1-2U$/.test(last3)) signals.push({ name: '2U-1-2U continuation', side: 'up' });
  if (/^2D-1-2D$/.test(last3)) signals.push({ name: '2D-1-2D continuation', side: 'down' });
  if (/^3-/.test(last2) && done.length >= 2) signals.push({ name: `outside bar then ${done[done.length - 1].type}`, side: done[done.length - 1].type === '2U' ? 'up' : done[done.length - 1].type === '2D' ? 'down' : 'neutral' });
  const developing = s.length && !s[s.length - 1].complete ? s[s.length - 1] : null;
  return { sequence: done.slice(-5).map((x) => x.type), signals, developing: developing ? { type: developing.type, note: 'candle NOT confirmed — acts as scenario, not signal' } : null };
}

/** Timeframe continuity: do the given frames' current candles agree in direction (close vs open)? */
export function timeframeContinuity(frames) {
  const dirs = Object.entries(frames).map(([tf, candles]) => {
    const c = candles[candles.length - 1];
    return { tf, dir: !c ? null : c.close > c.open ? 'up' : c.close < c.open ? 'down' : 'flat' };
  });
  const known = dirs.filter((d) => d.dir === 'up' || d.dir === 'down');
  const allUp = known.length > 1 && known.every((d) => d.dir === 'up');
  const allDown = known.length > 1 && known.every((d) => d.dir === 'down');
  return { dirs, state: allUp ? 'full_up' : allDown ? 'full_down' : 'mixed' };
}

/** Broadening formation: strictly higher highs AND lower lows across last n completed candles. */
export function broadening(candles, n = 4) {
  const done = candles.filter((c) => c.complete).slice(-n);
  if (done.length < n) return { detected: false, reason: 'insufficient candles' };
  let hh = true, ll = true;
  for (let i = 1; i < done.length; i++) { if (done[i].high <= done[i - 1].high) hh = false; if (done[i].low >= done[i - 1].low) ll = false; }
  return { detected: hh && ll, note: hh && ll ? 'expanding two-sided range — signals inside it degrade' : null };
}

// ---------- 2. FAIR-VALUE GAPS ----------
// 3-candle imbalance on COMPLETED candles: bullish when c1.high < c3.low (gap =
// [c1.high, c3.low]); bearish when c1.low > c3.high. State tracked vs later price.
export function detectFvgs(candles, { maxAgeMs = 60 * 60_000, now } = {}) {
  const done = candles.filter((c) => c.complete);
  const gaps = [];
  for (let i = 2; i < done.length; i++) {
    const c1 = done[i - 2], c3 = done[i];
    if (c1.high < c3.low) gaps.push({ side: 'bullish', top: c3.low, bottom: c1.high, created_at: c3.t1 });
    if (c1.low > c3.high) gaps.push({ side: 'bearish', top: c1.low, bottom: c3.high, created_at: c3.t1 });
  }
  // state vs subsequent price action
  for (const g of gaps) {
    const later = done.filter((c) => c.t0 >= g.created_at);
    let touched = false, filled = false;
    for (const c of later) {
      if (g.side === 'bullish') { if (c.low <= g.top) touched = true; if (c.low <= g.bottom) filled = true; }
      else { if (c.high >= g.bottom) touched = true; if (c.high >= g.top) filled = true; }
    }
    g.state = filled ? 'filled' : touched ? 'partially_filled' : 'untouched';
    g.stale = now != null ? now - g.created_at > maxAgeMs : false;
  }
  const px = done.length ? done[done.length - 1].close : null;
  const active = gaps.filter((g) => !g.stale && g.state !== 'filled');
  for (const g of active) g.distance = px == null ? null : (g.side === 'bullish' ? px - g.top : g.bottom - px);
  return { all: gaps, active };
}

// ---------- 3. STRUCTURE + LIQUIDITY ----------
/** Fractal swings: high with k lower highs each side (and inverse for lows). Completed candles only. */
export function swings(candles, k = 2) {
  const done = candles.filter((c) => c.complete);
  const highs = [], lows = [];
  for (let i = k; i < done.length - k; i++) {
    if (done.slice(i - k, i).every((c) => c.high < done[i].high) && done.slice(i + 1, i + 1 + k).every((c) => c.high < done[i].high)) highs.push({ price: done[i].high, t0: done[i].t0 });
    if (done.slice(i - k, i).every((c) => c.low > done[i].low) && done.slice(i + 1, i + 1 + k).every((c) => c.low > done[i].low)) lows.push({ price: done[i].low, t0: done[i].t0 });
  }
  return { highs, lows };
}

/**
 * Structure read: BOS/CHoCH vs last swings, liquidity sweep (wick beyond a swing
 * with close back inside), displacement (range > dispMult × ATR), dealing range
 * with premium/discount/equilibrium, prior-period levels.
 */
export function structureRead(candles, { k = 2, atrValue = null, dispMult = 1.8 } = {}) {
  const done = candles.filter((c) => c.complete);
  if (done.length < 2 * k + 3) return { ok: false, reason: 'insufficient candles for structure' };
  const { highs, lows } = swings(candles, k);
  const lastHigh = highs[highs.length - 1] ?? null;
  const lastLow = lows[lows.length - 1] ?? null;
  const last = done[done.length - 1];

  let event = null;
  if (lastHigh && last.close > lastHigh.price) event = { type: 'BOS_up', level: lastHigh.price };
  else if (lastLow && last.close < lastLow.price) event = { type: 'BOS_down', level: lastLow.price };

  let sweep = null;
  if (lastHigh && last.high > lastHigh.price && last.close < lastHigh.price) sweep = { side: 'buyside_swept', level: lastHigh.price, note: 'wick above swing high, close back inside — liquidity taken then rejected' };
  if (lastLow && last.low < lastLow.price && last.close > lastLow.price) sweep = { side: 'sellside_swept', level: lastLow.price, note: 'wick below swing low, close back inside' };

  const displacement = atrValue != null ? (last.high - last.low) > dispMult * atrValue : null;

  // dealing range = last swing low → last swing high; when one side has no
  // fractal swing yet (young/monotonic tape), fall back to the period extremes —
  // a defined range beats a null read for premium/discount location.
  let range = null;
  const hi = lastHigh?.price ?? Math.max(...done.map((c) => c.high));
  const lo = lastLow?.price ?? Math.min(...done.map((c) => c.low));
  if (Number.isFinite(hi) && Number.isFinite(lo) && hi !== lo) {
    const top = Math.max(hi, lo), bottom = Math.min(hi, lo);
    const eq = (top + bottom) / 2;
    const pos = (last.close - bottom) / (top - bottom);
    range = { top, bottom, equilibrium: eq, position: Number(pos.toFixed(3)), zone: pos > 0.62 ? 'premium' : pos < 0.38 ? 'discount' : 'equilibrium', basis: lastHigh && lastLow ? 'swings' : 'period_extremes_fallback' };
  }
  const period = { prior_high: Math.max(...done.slice(0, -1).map((c) => c.high)), prior_low: Math.min(...done.slice(0, -1).map((c) => c.low)), open: done[0].open };
  return { ok: true, swings: { lastHigh, lastLow }, event, sweep, displacement, range, period };
}
