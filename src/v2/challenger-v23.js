/**
 * BTC Alpha V2.3 challenger — TECHNICAL + PROFIT (money-first §6, 2026-07-26).
 *
 * ██ REGISTERED SHADOW CHALLENGER — experiment btc-v23-e1 (tsm_experiment_registry) ██
 *
 * Combines the two FROZEN incumbents without touching either:
 *   • V2.1 Arbiter (arbitrate): regime + evidence-family conviction → direction;
 *   • V2.2 Profit (selectProfit): fee-aware expected net dollars → entry gate.
 * TRADE only when BOTH agree on the SAME side: conviction says the direction,
 * after-fee EV says the price still pays. Everything else is NO_TRADE with the
 * failing gate named. Parameters are inherited FROZEN from the incumbents
 * (grid of size 1 — no fitting was performed; see experiment registry FITTING row).
 *
 * PURE: no I/O, no clock (now injected). Distinct engine_id → its rows can never
 * collide with or alter the frozen engines' records. Promotion path: prospective
 * shadow ≥200 settled + prereg economic gate + human founder — never here.
 */
import { arbitrate } from './arbiter.js';
import { selectProfit, PROFIT_PARAMS } from './profit.js';
import { kalshiFee, buildContext, profitProbability } from './engine.js';
import { buildArbiterInput, dataReady } from './evidence.js';

export const V23_ENGINE_ID = 'btc-alpha-v23-tech-profit';
export const V23_SPEC_VERSION = 'v2.3.0-shadow';

export function sealChallengerV23(s) {
  const ctx = buildContext(s);

  let recommendation = 'NO_TRADE';
  let status = 'no_forecast_data';
  let reason = 'Not enough live data for a disciplined call — staying out.';
  let arb = null, sel = null, p_yes = null;

  if (dataReady(ctx)) {
    const input = buildArbiterInput(ctx, { macroEvent: !!s.macroEvent });
    arb = arbitrate(input);
    p_yes = profitProbability(s);
    sel = selectProfit({ p_yes, up_ask: s.up_ask ?? null, down_ask: s.down_ask ?? null, feeFn: kalshiFee });
    status = 'ok';

    const dir = arb.decision;          // TAKE_YES | TAKE_NO | NO_TRADE
    const ev = sel.recommendation;     // TAKE_YES | TAKE_NO | NO_TRADE
    if (dir === 'NO_TRADE') {
      reason = `conviction gate closed: ${arb.reason}`;
    } else if (ev === 'NO_TRADE') {
      reason = `direction ${dir} had conviction but after-fee EV gate closed: ${sel.reason}`;
    } else if (dir !== ev) {
      reason = `gates disagree (conviction ${dir} vs EV ${ev}) — disagreement is a NO_TRADE, never a coin flip`;
    } else {
      recommendation = dir;
      reason = `both gates open: ${dir} with conviction AND after-fee edge >= $${PROFIT_PARAMS.MIN_EDGE}`;
    }
  }

  const half_spread = s.half_spread != null ? s.half_spread
    : (s.up_ask != null && s.up_bid != null ? Number(((s.up_ask - s.up_bid) / 2).toFixed(6)) : null);

  return {
    window_id: s.window_id,
    sealed_at: new Date(s.now).toISOString(),
    window_close_ts: s.window_close_ts ?? null,
    seconds_to_close_at_seal: s.tauSec != null ? Math.round(s.tauSec) : null,
    engine_id: V23_ENGINE_ID,
    spec_version: V23_SPEC_VERSION,
    recommendation,
    status,
    reason,
    strike: s.K ?? null,
    replica_index: s.S ?? null,
    market_p: s.market_p ?? null,
    up_ask: s.up_ask ?? null, down_ask: s.down_ask ?? null,
    up_bid: s.up_bid ?? null, down_bid: s.down_bid ?? null,
    half_spread,
    regime: arb?.ledger?.regime ?? null,
    reachability_bucket: arb?.ledger?.reachability_bucket ?? null,
    conflict_signature: arb?.ledger?.conflict_signature ?? null,
    conviction: arb?.ledger?.conviction ?? null,
    agreement: arb?.ledger?.agreement ?? null,
    matrix_version: arb?.ledger?.matrix_version ?? null,
    consensus: null,
    families: arb?.ledger?.evidence ?? {},
    evidence: {
      experiment_key: 'btc-v23-e1',
      arbiter_decision: arb?.decision ?? null,
      p_model: p_yes != null ? Number(p_yes.toFixed(6)) : null,
      ev_yes: sel?.ev_yes ?? null, ev_no: sel?.ev_no ?? null, chosen_ev: sel?.chosen_ev ?? null,
      min_edge: sel?.min_edge ?? PROFIT_PARAMS.MIN_EDGE,
      objective: 'direction_conviction_AND_expected_net_dollars_after_fees',
    },
    is_replay: !!s.is_replay,
  };
}
