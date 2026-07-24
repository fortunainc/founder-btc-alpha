/**
 * BTC Alpha V2 — decision rule (Phase A).
 *
 * F7 distance-vs-time is a HARD GATE (a side beyond the vol×time band is
 * forbidden). Directional conviction comes from a weighted consensus of the
 * directional families; in Phase A only F3 momentum is active (F2 structure,
 * F6 multi-timeframe, F5 order flow are reserved with frozen weights and switch
 * on in Phases B/C). F8 Kalshi pricing is applied LAST as a cost veto. Output is
 * exactly one of TAKE YES / TAKE NO / NO TRADE plus a deterministic, jargon-free
 * reason. No probability is ever the headline.
 *
 * Pure and deterministic: decide(ctx) does no I/O and reads no clock.
 */

import {
  f1Distance, f3Momentum, f4Volatility, f7DistanceVsTime, f8Kalshi,
} from './families.js';

/** FROZEN decision params (spec v2.0.0). Weights sum to 1 across all directional families. */
export const DECISION_PARAMS = Object.freeze({
  WEIGHTS: { F2_structure: 0.30, F6_mtf: 0.30, F3_momentum: 0.25, F5_flow: 0.15 },
  CONVICTION_FLOOR: 0.15,   // min |consensus| to act when both sides are reachable
  MOM_OPPOSE_STRONG: 0.5,   // momentum confidence above which it can veto an F7-only side
  WARMUP_MS: 15 * 60_000,
});

const sv = (vote) => (vote === 'long' ? 1 : vote === 'short' ? -1 : 0);
const cap = (s) => (s ? s.charAt(0).toUpperCase() + s.slice(1) : s);
const usd = (v) => (v == null || Number.isNaN(v) ? '—' : `$${Math.round(v).toLocaleString('en-US')}`);

function buildReason(ctx, fams, side) {
  const f7 = fams.f7.detail;
  if (!f7.dataOk) return 'Not enough live data to make a disciplined call yet — staying out.';
  const parts = [];
  const move = f7.currentSide === 'NO'
    ? `rally +${usd(f7.crossingMove)}`
    : `hold above the strike (a −${usd(f7.crossingMove)} drop would flip it)`;
  parts.push(`BTC would need to ${move} in ${Math.round(ctx.tauSec / 60)} min to change the outcome.`);
  if (fams.f3) parts.push(`${cap(fams.f3.reading)}.`);
  if (fams.f4) parts.push(`${cap(fams.f4.reading)}.`);
  parts.push(`Path to a reversal is ${f7.crossPlausible ? 'realistic' : 'unlikely'}.`);
  if (fams.f8) {
    parts.push(fams.f8.detail.agreement === 'agrees'
      ? 'The market largely agrees with this read.'
      : fams.f8.detail.agreement === 'disagrees'
        ? 'The market disagrees — which is where the edge is.'
        : 'The market is roughly balanced here.');
  }
  const rec = side === 'TAKE_YES' ? 'TAKE YES' : side === 'TAKE_NO' ? 'TAKE NO' : 'NO TRADE';
  parts.push(`Recommendation: ${rec}.`);
  return parts.join(' ');
}

function familyReadings(fams) {
  const out = {};
  for (const f of Object.values(fams)) {
    if (f && f.key) out[f.key] = { vote: f.vote, confidence: f.confidence, reading: f.reading, detail: f.detail };
  }
  return out;
}

/**
 * Produce the single sealed decision.
 * @param {object} ctx  { S, K, tauSec, bars, sigmaPerSec, market_p, up_ask, down_ask, half_spread, now }
 * @returns {{recommendation:'TAKE_YES'|'TAKE_NO'|'NO_TRADE', badge:string, status:string, reason:string, families:object, detail:object}}
 */
export function decide(ctx) {
  const f1 = f1Distance(ctx);
  const f4 = f4Volatility(ctx);
  const f7 = f7DistanceVsTime(ctx);
  const f3 = f3Momentum(ctx);
  const fams = { f1, f3, f4, f7 };

  // 0. Data readiness — honest abstention, never a guessed direction.
  const warm = ctx.bars && typeof ctx.bars.isWarm === 'function'
    ? ctx.bars.isWarm(DECISION_PARAMS.WARMUP_MS, ctx.now) : false;
  const dataOk = f7.detail.dataOk && ctx.S > 0 && ctx.K > 0 && ctx.tauSec > 0 && warm;
  if (!dataOk) {
    fams.f8 = f8Kalshi(ctx, 'neutral');
    return finalize(ctx, fams, 'NO_TRADE', 'no_forecast_data', null);
  }

  // 1. Directional consensus (Phase A: F3 only; others reserved).
  const W = DECISION_PARAMS.WEIGHTS;
  const active = [['F3_momentum', f3]]; // Phase B/C: unshift F2_structure, F6_mtf, F5_flow
  let num = 0; let wsum = 0;
  for (const [key, fam] of active) { num += W[key] * sv(fam.vote) * fam.confidence; wsum += W[key]; }
  const consensus = wsum > 0 ? num / wsum : 0; // -1..1

  // 2. F7 hard gate.
  const yesOk = f7.detail.yesPlausible;
  const noOk = f7.detail.noPlausible;

  let side = 'NO_TRADE';
  if (yesOk && !noOk) {
    side = (sv(f3.vote) < 0 && f3.confidence >= DECISION_PARAMS.MOM_OPPOSE_STRONG) ? 'NO_TRADE' : 'TAKE_YES';
  } else if (noOk && !yesOk) {
    side = (sv(f3.vote) > 0 && f3.confidence >= DECISION_PARAMS.MOM_OPPOSE_STRONG) ? 'NO_TRADE' : 'TAKE_NO';
  } else if (yesOk && noOk) {
    if (Math.abs(consensus) >= DECISION_PARAMS.CONVICTION_FLOOR) {
      side = consensus > 0 ? 'TAKE_YES' : 'TAKE_NO';
    }
  }

  // 3. F8 cost veto (LAST family).
  const lean = side === 'TAKE_YES' ? 'long' : side === 'TAKE_NO' ? 'short' : 'neutral';
  fams.f8 = f8Kalshi(ctx, lean);
  if (side !== 'NO_TRADE' && !fams.f8.detail.costOk) side = 'NO_TRADE';

  return finalize(ctx, fams, side, 'ok', consensus);
}

function finalize(ctx, fams, side, status, consensus) {
  const badge = side === 'TAKE_YES' ? 'TAKE YES' : side === 'TAKE_NO' ? 'TAKE NO' : 'NO TRADE';
  return {
    recommendation: side,
    badge,
    status,
    reason: buildReason(ctx, fams, side),
    families: familyReadings(fams),
    detail: {
      consensus,
      S: ctx.S, K: ctx.K, tauSec: ctx.tauSec, market_p: ctx.market_p,
      yesPlausible: fams.f7.detail.yesPlausible, noPlausible: fams.f7.detail.noPlausible,
    },
  };
}
