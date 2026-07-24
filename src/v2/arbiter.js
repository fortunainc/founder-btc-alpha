/**
 * BTC Alpha V2.1 — the Arbiter (regime-based evidence resolution).
 *
 * This is the reasoning core. It does NOT add indicators; it decides which
 * evidence should DOMINATE under the current market regime, resolves conflict,
 * and abstains when the read is genuinely split. Same raw conflict, different
 * regime → different call. That regime-dependence is the intelligence.
 *
 * It also emits the ARBITRATION LEDGER record on every call — the append-only
 * training set (regime + reachability bucket + per-factor evidence + a canonical
 * conflict signature + decision), later joined to the settled outcome. The rules
 * run the engine today; the ledger builds the dataset that will run it tomorrow.
 * Nothing here reads Kalshi price. The only question is ABOVE vs BELOW the strike.
 *
 * Pure and deterministic: arbitrate(ctx) does no I/O and reads no clock.
 */

export const MATRIX_VERSION = 'arb-matrix-v1';

/** Factors the arbiter can weigh. Absent/flat factors simply do not vote. */
export const FACTORS = Object.freeze(['order_flow', 'momentum', 'structure', 'vwap', 'liquidity', 's_r', 'mtf']);

/**
 * FROZEN regime → factor weight matrix (arb-matrix-v1). A factor's vote is
 * scaled by how trustworthy it is in the current regime. These are the PRIOR
 * the learned arbiter will later blend against per-signature realized win-rates.
 */
export const WEIGHTS = Object.freeze({
  trend:    { order_flow: 1.0, momentum: 1.0, structure: 1.0, vwap: 0.5, liquidity: 0.5, s_r: 0.2, mtf: 0.6 },
  range:    { order_flow: 0.7, momentum: 0.1, structure: 0.6, vwap: 1.0, liquidity: 0.6, s_r: 1.0, mtf: 0.3 },
  breakout: { order_flow: 1.2, momentum: 0.6, structure: 1.0, vwap: 0.3, liquidity: 0.9, s_r: 0.6, mtf: 0.6 },
  event:    { order_flow: 0.2, momentum: 0.1, structure: 0.2, vwap: 0.2, liquidity: 0.2, s_r: 0.2, mtf: 0.2 },
});

export const ARB_PARAMS = Object.freeze({
  Z_DECIDED: 1.5,          // |z| beyond this ⇒ the window is DECIDED by reachability
  CONVICTION_BAR: 0.20,    // min |net conviction| (after contestedness) to act
  AGREEMENT_BAR: 0.60,     // min share of weighted mass on the winning side to act
  OVERRIDE_STRENGTH: 0.6,  // leading opposing push that can turn a DECIDED window into NO_TRADE
  MOM_EXHAUST: 0.5,        // momentum this strong, opposed by structure, in a non-trend ⇒ exhaustion
});

const sgn = (side) => (side === 'yes' ? 1 : side === 'no' ? -1 : 0);
const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
const band = (s) => (s == null ? 'na' : s >= 0.66 ? 'hi' : s >= 0.33 ? 'md' : 'lo');
const present = (e) => e && e.side && e.side !== 'flat' && Number.isFinite(e.strength) && e.strength > 0;

/** Reachability bucket + contestedness from the z-score. */
export function reachability(z) {
  const Z = ARB_PARAMS.Z_DECIDED;
  const bucket = z >= Z ? 'decided_above' : z <= -Z ? 'decided_below' : 'contested';
  const contestedness = clamp01(1 - Math.abs(z) / Z); // 1 at the strike, 0 once decided
  return { bucket, contestedness };
}

/**
 * Classify the regime from whatever evidence is present. Degrades gracefully:
 * with only momentum + vol regime it still separates trend from range. Defaults
 * to 'range' when unsure — the conservative choice (favors mean-reversion + abstention).
 */
export function classifyRegime(ctx) {
  if (ctx.eventFlag) return 'event';
  const ev = ctx.evidence || {};
  const bo = ctx.breakout;
  if (bo && bo.active) return 'breakout';

  const mom = ev.momentum;
  const struc = ev.structure;
  const vol = ctx.volRegime; // 'expanding' | 'contracting' | 'steady'

  const strongTrendStructure = present(struc) && struc.strength >= 0.5 && struc.trend === true;
  const strongMom = present(mom) && mom.strength >= 0.5 && mom.consistent !== false;
  const aligned = present(struc) && present(mom) && sgn(struc.side) === sgn(mom.side);

  if (strongTrendStructure && (aligned || vol === 'expanding')) return 'trend';
  if (strongMom && vol === 'expanding') return 'trend';
  if (vol === 'contracting') return 'range';
  if (!present(mom) || mom.strength < 0.3) return 'range';
  return 'range';
}

/**
 * Apply failed-signal transforms BEFORE weighting. Returns a shallow-adjusted
 * evidence map plus notes. This is where "momentum without structure = exhaustion"
 * and "breakout without order-flow = trap" actually change votes, not just weights.
 */
function resolveConflicts(regime, evidence, breakout) {
  const ev = { ...evidence };
  const notes = [];
  const mom = ev.momentum, struc = ev.structure, of = ev.order_flow;

  // 1. Momentum opposed by structure, outside a trend ⇒ suspected exhaustion.
  if (regime !== 'trend' && present(mom) && present(struc)
      && sgn(mom.side) === -sgn(struc.side) && mom.strength >= ARB_PARAMS.MOM_EXHAUST) {
    ev.momentum = { ...mom, side: struc.side, strength: mom.strength * 0.5, _exhaustion: true };
    notes.push('momentum reread as exhaustion vs structure');
  }
  // 1b. In a trend, a structure signal OPPOSING the trend is a pullback ⇒ discount it,
  //     so the dominant momentum is not cancelled by a minor counter-trend objection.
  if (regime === 'trend' && present(mom) && present(struc) && sgn(struc.side) === -sgn(mom.side)) {
    ev.structure = { ...struc, strength: struc.strength * 0.5, _pullback: true };
    notes.push('counter-trend structure discounted as pullback');
  }
  // 2. Breakout not confirmed by order flow ⇒ suspected trap: favor the fade.
  if (regime === 'breakout' && breakout && breakout.side) {
    const confirmed = present(of) && of.side === breakout.side && of.strength >= 0.3;
    if (!confirmed) {
      const fade = breakout.side === 'yes' ? 'no' : 'yes';
      ev.structure = { side: fade, strength: 0.6, leading: true, _failedBreak: true };
      notes.push('unconfirmed breakout treated as trap (fade)');
    }
  }
  return { ev, notes };
}

/** Canonical conflict signature — the key the learned arbiter will group history by. */
export function signatureFor(regime, bucket, evidence) {
  const yes = [], no = [];
  for (const k of FACTORS) {
    const e = evidence[k];
    if (!present(e)) continue;
    (e.side === 'yes' ? yes : no).push(`${k}:${band(e.strength)}`);
  }
  yes.sort(); no.sort();
  return `${regime}·${bucket}·YES={${yes.join(',')}}·NO={${no.join(',')}}`;
}

/**
 * Arbitrate one decision.
 * @param {object} ctx { z, tauSec, volRegime, eventFlag, breakout?, evidence:{factor:{side,strength,leading}} }
 * @returns {{decision, regime, bucket, conviction, agreement, contestedness, reason, ledger}}
 */
export function arbitrate(ctx) {
  const { z = 0, evidence: rawEv = {} } = ctx;
  const { bucket, contestedness } = reachability(z);
  const regime = classifyRegime(ctx);
  const { ev, notes } = resolveConflicts(regime, rawEv, ctx.breakout);
  const W = WEIGHTS[regime];

  // Weighted directional vote over PRESENT factors only.
  let num = 0, mass = 0, yesMass = 0, noMass = 0;
  for (const k of FACTORS) {
    const e = ev[k];
    if (!present(e)) continue;
    const w = (W[k] || 0) * (e.leading ? 1.1 : 1.0); // leading factors break ties
    const contrib = w * e.strength;
    num += contrib * sgn(e.side);
    mass += contrib;
    if (sgn(e.side) > 0) yesMass += contrib; else noMass += contrib;
  }
  const rawConviction = mass > 0 ? num / mass : 0;          // -1..1, pre-reachability
  const winMass = Math.max(yesMass, noMass);
  const agreement = mass > 0 ? winMass / mass : 0;          // 0.5 = split, 1 = unanimous
  const conviction = rawConviction * contestedness;         // TA matters less as the window is decided

  let decision = 'NO_TRADE';
  let reason = 'Evidence is too split to call — staying out.';

  if (regime === 'event' && bucket === 'contested') {
    reason = 'Scheduled-event volatility with no reachability edge — no trade.';
  } else if (bucket !== 'contested') {
    // DECIDED by reachability: take the winning side unless a strong LEADING push threatens a cross.
    const baseSide = bucket === 'decided_above' ? 'yes' : 'no';
    const opp = baseSide === 'yes' ? 'no' : 'yes';
    const leadingOpp = FACTORS.some((k) => present(ev[k]) && ev[k].leading && ev[k].side === opp
      && ev[k].strength >= ARB_PARAMS.OVERRIDE_STRENGTH);
    if (leadingOpp && ctx.volRegime === 'expanding') {
      reason = `Reachability favors ${baseSide.toUpperCase()}, but a strong opposing push with expanding vol could cross — no trade.`;
    } else {
      decision = baseSide === 'yes' ? 'TAKE_YES' : 'TAKE_NO';
      reason = `Distance to strike makes ${baseSide.toUpperCase()} the reachable outcome.`;
    }
  } else if (Math.abs(conviction) >= ARB_PARAMS.CONVICTION_BAR && agreement >= ARB_PARAMS.AGREEMENT_BAR) {
    const side = conviction > 0 ? 'yes' : 'no';
    decision = side === 'yes' ? 'TAKE_YES' : 'TAKE_NO';
    reason = `In a ${regime}, the dominant evidence points ${side.toUpperCase()} (agreement ${(agreement * 100).toFixed(0)}%).`;
  }
  if (notes.length) reason += ` [${notes.join('; ')}]`;

  const ledgerEvidence = {};
  for (const k of FACTORS) {
    const e = rawEv[k];
    ledgerEvidence[k] = present(e) ? { side: e.side, strength: Number(e.strength.toFixed(3)), leading: !!e.leading } : null;
  }
  const ledger = {
    matrix_version: MATRIX_VERSION,
    regime,
    reachability_bucket: bucket,
    evidence: ledgerEvidence,
    conflict_signature: signatureFor(regime, bucket, rawEv),
    applied_weights: W,
    conviction: Number(conviction.toFixed(4)),
    raw_conviction: Number(rawConviction.toFixed(4)),
    agreement: Number(agreement.toFixed(4)),
    contestedness: Number(contestedness.toFixed(4)),
    decision,
    // settled_side / decision_correct are filled at grade time (join on window).
  };

  return { decision, regime, bucket, conviction, agreement, contestedness, reason, ledger };
}

export default arbitrate;
