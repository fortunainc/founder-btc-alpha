/**
 * BTC Alpha V2 — Phase A evidence families (reuse-heavy).
 *
 * Each family is a PURE function of the sealed context and returns:
 *   { key, vote: 'long'|'short'|'neutral', confidence: 0..1, reading: string, detail }
 * where LONG favors YES (BTC finishes ABOVE strike) and SHORT favors NO.
 *
 * Phase A covers F1 distance, F3 momentum, F4 volatility, F7 distance-vs-time
 * (the hard gate), and F8 Kalshi pricing (last). F2 structure, F5 order flow,
 * and F6 multi-timeframe arrive in Phases B/C. All numeric params below are
 * FROZEN at pre-registration (spec v2.0.0) — no tuning to backtests.
 */

/** FROZEN v0 params (spec btc-alpha-v2-scalp v2.0.0). */
export const PARAMS = Object.freeze({
  Z_BAND: 1.0,            // F7 plausibility band = 1 sigma of projected move
  F7_TOL: 1.10,           // 10% grace on the band before a side is called implausible
  COST_ASK_CEILING: 0.95, // F8: paying above this leaves too little payoff to bother
  MAX_HALF_SPREAD: 0.03,  // F8: wider than this and the round-trip cost is prohibitive
  // F3 momentum horizon weights (short-horizon tilt = responsiveness)
  MOM_W: { r30: 0.35, r60: 0.30, r180: 0.20, r300: 0.15 },
});

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const usd = (v) => (v == null || Number.isNaN(v) ? '—' : `$${Math.round(v).toLocaleString('en-US')}`);
const signed$ = (v) => `${v >= 0 ? '+' : '−'}$${Math.abs(Math.round(v)).toLocaleString('en-US')}`;
const mins = (s) => `${Math.round(s / 60)} min`;

/** F1 — distance to strike. Context family (neutral vote); drives F7. */
export function f1Distance(ctx) {
  const { S, K, tauSec } = ctx;
  const above = S - K;                    // >0 => currently above strike (YES in the money)
  const pct = K ? above / K : 0;
  const cross = K - S;                    // signed move needed to reach the strike line
  const perMin = tauSec > 0 ? Math.abs(cross) / (tauSec / 60) : Infinity;
  const perSec = tauSec > 0 ? Math.abs(cross) / tauSec : Infinity;
  const side = above >= 0 ? 'above' : 'below';
  return {
    key: 'F1_distance', vote: 'neutral',
    confidence: clamp01(Math.abs(pct) * 25), // ~4% away => full context confidence
    reading: `BTC ${usd(S)} is ${signed$(above)} ${side} the ${usd(K)} strike`,
    detail: { above, pct, cross, reqMovePerMin: perMin, reqMovePerSec: perSec, side },
  };
}

/** F3 — momentum across 30s/1m/3m/5m + acceleration. LONG = rising (favors YES). */
export function f3Momentum(ctx) {
  const { bars, now } = ctx;
  const r = {
    r30: bars.returnOver(30_000, now),
    r60: bars.returnOver(60_000, now),
    r180: bars.returnOver(180_000, now),
    r300: bars.returnOver(300_000, now),
  };
  const horizonSec = { r30: 30, r60: 60, r180: 180, r300: 300 };
  const avail = Object.keys(r).filter((k) => r[k] != null);
  if (avail.length < 2) {
    return { key: 'F3_momentum', vote: 'neutral', confidence: 0,
      reading: 'momentum: not enough history yet', detail: { ...r, insufficient: true } };
  }
  // per-second rates make horizons comparable; short horizons weighted for acceleration
  let blended = 0; let wsum = 0;
  for (const k of avail) {
    const rate = r[k] / horizonSec[k];
    const w = PARAMS.MOM_W[k];
    blended += w * rate; wsum += w;
  }
  blended /= wsum || 1;
  const signs = avail.map((k) => Math.sign(r[k]));
  const consistency = Math.abs(signs.reduce((s, x) => s + x, 0)) / signs.length; // 0..1
  const rate30 = r.r30 != null ? r.r30 / 30 : null;
  const rate300 = r.r300 != null ? r.r300 / 300 : null;
  const accelerating = rate30 != null && rate300 != null
    && Math.sign(rate30) === Math.sign(rate300) && Math.abs(rate30) > Math.abs(rate300);
  const dir = blended > 0 ? 'long' : blended < 0 ? 'short' : 'neutral';
  const mag = clamp01(Math.abs(blended) * 1.2e4); // scale per-second log-rate to 0..1
  const confidence = clamp01(consistency * (0.5 + 0.5 * mag));
  const word = dir === 'neutral' ? 'flat'
    : `${dir === 'long' ? 'rising' : 'falling'}${accelerating ? ' and accelerating' : consistency < 0.5 ? ' but choppy' : ''}`;
  return {
    key: 'F3_momentum', vote: dir, confidence,
    reading: `momentum is ${word}`,
    detail: { ...r, blended, consistency, accelerating },
  };
}

/** F4 — volatility: expected move to settlement + expansion/contraction regime. */
export function f4Volatility(ctx) {
  const { S, tauSec, sigmaPerSec, bars, now } = ctx;
  const projected = sigmaPerSec != null && sigmaPerSec > 0
    ? S * sigmaPerSec * Math.sqrt(tauSec) : null;
  // regime: short-window vs long-window realized vol
  const fast = bars.realizedVolPerSec(120_000, 10_000, now);
  const slow = bars.realizedVolPerSec(600_000, 30_000, now);
  let regime = 'steady'; let clarity = 0.3;
  if (fast != null && slow != null && slow > 0) {
    const ratio = fast / slow;
    if (ratio >= 1.2) { regime = 'expanding'; clarity = clamp01((ratio - 1)); }
    else if (ratio <= 0.8) { regime = 'contracting'; clarity = clamp01(1 - ratio); }
  }
  return {
    key: 'F4_volatility', vote: 'neutral',
    confidence: clamp01(clarity),
    reading: projected != null
      ? `volatility projects ±${usd(projected)} before settlement (${regime})`
      : `volatility unavailable`,
    detail: { projected, regime, fast, slow },
  };
}

/**
 * F7 — distance-vs-time HARD GATE (reuse of the B1 diffusion idea, in $).
 * Determines whether each side is a realistic destination given vol × time.
 * A side that requires a crossing move beyond the projected band is FORBIDDEN.
 */
export function f7DistanceVsTime(ctx) {
  const { S, K, tauSec, sigmaPerSec } = ctx;
  const projected = sigmaPerSec != null && sigmaPerSec > 0
    ? PARAMS.Z_BAND * S * sigmaPerSec * Math.sqrt(tauSec) : null;
  if (projected == null) {
    return { key: 'F7_distance_vs_time', vote: 'neutral', confidence: 0,
      reading: 'path model unavailable (no volatility)',
      detail: { projected: null, yesPlausible: false, noPlausible: false, dataOk: false } };
  }
  const currentSide = S >= K ? 'YES' : 'NO';         // where we'd settle if frozen now
  const crossingMove = Math.abs(K - S);              // move needed to flip to the other side
  const crossPlausible = crossingMove <= projected * PARAMS.F7_TOL;
  const yesPlausible = currentSide === 'YES' || crossPlausible;
  const noPlausible = currentSide === 'NO' || crossPlausible;
  let vote = 'neutral';
  if (yesPlausible && !noPlausible) vote = 'long';
  else if (noPlausible && !yesPlausible) vote = 'short';
  // confidence = how decisively the forbidden side is out of reach
  const ratio = crossingMove / projected; // >1 => reversal unlikely
  const confidence = vote === 'neutral' ? 0 : clamp01((ratio - 1) / 2);
  const needWord = currentSide === 'YES'
    ? `hold above (a ${signed$(-(crossingMove))} drop flips it)`
    : `rally ${signed$(crossingMove)} to cross`;
  return {
    key: 'F7_distance_vs_time', vote, confidence,
    reading: `to finish the other way BTC must move ${usd(crossingMove)} in ${mins(tauSec)}; vol projects ±${usd(projected)} — reversal is ${crossPlausible ? 'possible' : 'unlikely'} (${needWord})`,
    detail: { projected, crossingMove, currentSide, crossPlausible, yesPlausible, noPlausible, ratio, dataOk: true },
  };
}

/**
 * F8 — Kalshi pricing, evaluated LAST. Reads the market and flags whether the
 * favored side's executable entry leaves any room after fees + spread.
 * @param {object} ctx
 * @param {'long'|'short'|'neutral'} lean  the pre-F8 directional lean
 */
export function f8Kalshi(ctx, lean) {
  const { market_p, up_ask, down_ask, half_spread } = ctx;
  const pct = (p) => (p == null ? '—' : `${Math.round(p * 100)}%`);
  const favAsk = lean === 'long' ? up_ask : lean === 'short' ? down_ask : null;
  const spreadOk = half_spread == null || half_spread <= PARAMS.MAX_HALF_SPREAD;
  const askOk = favAsk == null || favAsk <= PARAMS.COST_ASK_CEILING;
  const costOk = spreadOk && askOk;
  // does the market already strongly agree with our lean? (little disagreement => thin edge)
  let agreement = 'neutral';
  if (market_p != null && lean !== 'neutral') {
    const marketLong = market_p >= 0.5;
    agreement = (marketLong && lean === 'long') || (!marketLong && lean === 'short') ? 'agrees' : 'disagrees';
  }
  return {
    key: 'F8_kalshi', vote: 'neutral', confidence: 0,
    reading: `market prices YES at ${pct(market_p)}; it ${agreement} with our read`,
    detail: { market_p, favAsk, half_spread, costOk, askOk, spreadOk, agreement },
  };
}
