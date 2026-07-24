/**
 * BTC Alpha V2 — seal/grade engine (Phase A).
 *
 * Bridges the analytical core (bars + families + decision) to storage:
 *   sealDecision(liveState) -> one immutable decision row (for fa_v2_decisions)
 *   gradeDecision(decision, settlement) -> one grade row (for fa_v2_grades)
 *
 * The seal is IMMUTABLE (append-only table, one per window); grading writes a
 * SEPARATE row, never mutating the seal — the same discipline as Phase-1. Paper
 * P&L uses the SEALED executable ask + the canonical Kalshi fee (no midpoint
 * fills), identical methodology to v_fa_paper_pnl.
 *
 * Pure and deterministic: no I/O, no clock reads (timestamps are passed in).
 */

import { buildArbiterInput, dataReady } from './evidence.js';
import { arbitrate } from './arbiter.js';

export const SPEC_VERSION = 'v2.1.0';   // v2.1: regime-based Arbiter + Arbitration Ledger
export const ENGINE_ID = 'btc-alpha-v2-scalp';

/** Canonical Kalshi fee for one contract at price p: ceil(0.07*p*(1-p)) in dollars. */
export function kalshiFee(p) {
  if (p == null || !Number.isFinite(p) || p <= 0 || p >= 1) return 0;
  return Math.ceil(0.07 * p * (1 - p) * 100) / 100;
}

/** Assemble the decision context from the worker's live state. */
export function buildContext(s) {
  return {
    S: s.S, K: s.K, tauSec: s.tauSec,
    bars: s.bars,
    tape: s.tape ?? null,          // trade tape for order flow (may be absent)
    sigmaPerSec: s.sigmaPerSec,
    market_p: s.market_p,
    up_ask: s.up_ask, down_ask: s.down_ask, up_bid: s.up_bid, down_bid: s.down_bid,
    half_spread: s.half_spread != null ? s.half_spread
      : (s.up_ask != null && s.up_bid != null ? (s.up_ask - s.up_bid) / 2 : null),
    now: s.now,
  };
}

/**
 * Seal ONE decision for the current window. Returns the immutable row.
 * @param {object} s live state (see buildContext) + { window_id, window_close_ts, now, is_replay }
 */
export function sealDecision(s) {
  const ctx = buildContext(s);
  const bars = s.bars;

  let recommendation = 'NO_TRADE';
  let status = 'no_forecast_data';
  let reason = 'Not enough live data to make a disciplined call yet — staying out.';
  let ledger = null;
  let z = null;

  if (dataReady(ctx)) {
    const input = buildArbiterInput(ctx, { macroEvent: !!s.macroEvent });
    z = input.z;
    const res = arbitrate(input);
    recommendation = res.decision;    // TAKE_YES | TAKE_NO | NO_TRADE
    status = 'ok';
    reason = res.reason;
    ledger = res.ledger;
  }

  return {
    window_id: s.window_id,
    sealed_at: new Date(s.now).toISOString(),
    window_close_ts: s.window_close_ts ?? null,
    seconds_to_close_at_seal: s.tauSec != null ? Math.round(s.tauSec) : null,
    engine_id: ENGINE_ID,
    spec_version: SPEC_VERSION,
    recommendation,
    status,
    reason,
    strike: s.K ?? null,
    replica_index: s.S ?? null,
    market_p: s.market_p ?? null,     // recorded for paper P&L only — NOT a directional input
    up_ask: s.up_ask ?? null, down_ask: s.down_ask ?? null,
    up_bid: s.up_bid ?? null, down_bid: s.down_bid ?? null,
    half_spread: ctx.half_spread,
    // ---- Arbitration Ledger (v2.1) ----
    regime: ledger ? ledger.regime : null,
    reachability_bucket: ledger ? ledger.reachability_bucket : null,
    conflict_signature: ledger ? ledger.conflict_signature : null,
    conviction: ledger ? ledger.conviction : null,
    agreement: ledger ? ledger.agreement : null,
    matrix_version: ledger ? ledger.matrix_version : null,
    consensus: ledger ? ledger.raw_conviction : null,   // kept: raw directional conviction
    families: ledger ? ledger.evidence : {},            // per-factor evidence vector
    evidence: {
      z: z != null ? Number(z.toFixed(4)) : null,
      sigmaPerSec: s.sigmaPerSec ?? null,
      history_ms: bars && typeof bars.historyMs === 'function' ? bars.historyMs(s.now) : null,
      applied_weights: ledger ? ledger.applied_weights : null,
    },
    is_replay: !!s.is_replay,
  };
}

/**
 * Grade a sealed decision against settlement. Returns the grade row (append-only).
 * Paper P&L: 1 contract, entered at the SEALED executable ask of the taken side,
 * Kalshi fee at that ask, payoff $1 if the side won else $0. NO_TRADE => no
 * position (net 0, correct = null) but the outcome is recorded for the
 * abstention-discipline hypothesis (H4).
 * @param {object} decision  a row from sealDecision()
 * @param {object} settlement { outcome: 'yes'|'no'|'void', settlement_value, graded_at }
 */
export function gradeDecision(decision, settlement) {
  const outcome = settlement.outcome;
  const base = {
    window_id: decision.window_id,
    engine_id: ENGINE_ID,
    recommendation: decision.recommendation,
    settled_outcome: outcome,
    settlement_value: settlement.settlement_value ?? null,
    graded_at: settlement.graded_at ? new Date(settlement.graded_at).toISOString() : null,
  };
  if (outcome === 'void') {
    return { ...base, call_correct: null, entry_price: null, fee: null, net_pnl: null };
  }
  if (decision.recommendation === 'NO_TRADE') {
    // No position taken. Record the outcome for H4 counterfactual analysis.
    return { ...base, call_correct: null, entry_price: null, fee: null, net_pnl: 0 };
  }
  const isYes = decision.recommendation === 'TAKE_YES';
  const entry = isYes ? decision.up_ask : decision.down_ask;
  const won = isYes ? outcome === 'yes' : outcome === 'no';
  if (entry == null || !Number.isFinite(entry) || entry <= 0 || entry >= 1) {
    // Cannot price the fill honestly — grade correctness only, no fabricated P&L.
    return { ...base, call_correct: won, entry_price: entry ?? null, fee: null, net_pnl: null };
  }
  const fee = kalshiFee(entry);
  const payoff = won ? 1 : 0;
  const net = Number((payoff - entry - fee).toFixed(4));
  return { ...base, call_correct: won, entry_price: entry, fee, net_pnl: net };
}
