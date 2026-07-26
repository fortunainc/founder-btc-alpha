/**
 * BTC v2.4 — FOUNDER TECHNICAL ENGINE (technical-analysis execution lock, 2026-07-26).
 * Engine btc-alpha-v24-technical @ spec v2.4.0-shadow · experiment btc-v24-technical-e1.
 *
 * Continuous synthesis for the LIVE 15-minute market: STRAT + FVG + structure/
 * liquidity + trend + volatility across 1m/3m/5m/15m/1h → exactly one of
 * YES | NO | WAIT | NO_TRADE right now, sealed as an IMMUTABLE timestamped
 * REVISION every refresh (target ≤180s). Never overwrites a prior revision.
 *
 * Conflict resolution (§D, deterministic, in priority order for the 15m decision):
 *   1. Freshness/risk gates veto everything (stale data, τ too small, book missing).
 *   2. Reachability gate: strike beyond ~2 expected moves → NO_TRADE (vol controls).
 *   3. An immediate 1m/3m liquidity SWEEP against the HTF trend CONTROLS (a bullish
 *      HTF never overrides a fresh buyside sweep — founder rule).
 *   4. Fresh displacement + BOS on 3m/5m controls direction.
 *   5. Otherwise HTF (15m/1h) trend + STRAT continuity + active FVG reaction vote.
 *   6. Direction without an acceptable executable price → WAIT (with the exact
 *      price/confirmation needed). Conflict without resolution → NO_TRADE.
 *
 * UNSUPPORTED on this data feed (declared, never faked): volume/participation,
 * VWAP (no volume), order blocks (need footprint), funding/OI/liquidations
 * (no derivatives source wired), options-implied vol (not licensed here).
 * Available + scored: index price action (all TA above), Kalshi book (entry
 * pricing + imbalance), remaining-time volatility. See data_status in output.
 */
import { buildCandles, emaTrend, atr, volatilityRead } from './ta-core.js';
import { stratSignals, timeframeContinuity, broadening, detectFvgs, structureRead } from './ta-patterns.js';
import { kalshiFee } from '../engine.js';

export const V24_ENGINE_ID = 'btc-alpha-v24-technical';
export const V24_SPEC_VERSION = 'v2.4.0-shadow';
export const V24_EXPERIMENT_KEY = 'btc-v24-technical-e1';
export const V24_PARAMS = Object.freeze({
  refresh_target_ms: 150_000,      // 2.5 min target (max allowed 180s)
  stale_after_ms: 180_000,         // data older than 3 min must not present as current
  min_tau_sec: 90,                 // <90s to resolution: too close, execution risk dominates
  max_reach_sigma: 2.0,            // strike beyond 2 expected moves → not realistically reachable
  min_edge_usd: 0.02,              // after-fee edge floor per contract (matches v2.2 doctrine)
  conviction_floor: 0.25,          // below this → WAIT/NO_TRADE, never a coin flip
});

const fin = (v) => (v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));

/** Model probability that spot resolves ABOVE strike, from technical vote + distance/vol. */
function technicalProbability({ voteScore, spot, strike, expectedMove }) {
  if (![spot, strike, expectedMove].every(Number.isFinite) || expectedMove <= 0) return null;
  // base: distance in expected-move units through a logistic squash; vote tilts it.
  const z = (spot - strike) / expectedMove;
  const base = 1 / (1 + Math.exp(-1.7 * z));
  const tilt = 0.12 * voteScore; // vote in [-1,1] → max ±12 pts — evidence tilts, distance anchors
  return Math.min(0.97, Math.max(0.03, base + tilt));
}

/**
 * evaluateV24 — ONE refresh evaluation. PURE (no I/O, no clock: now injected).
 * @param s { window_id, window_open_ts, window_close_ts, now, tauSec, S(spot), K(strike),
 *            ticks: [{ts,price}], sigmaPerSec, up_ask, up_bid, down_ask, down_bid,
 *            dataAgeMs, prevRevision (or null), revision_seq }
 */
export function evaluateV24(s) {
  const now = s.now;
  const gatesFailed = [];
  const spot = fin(s.S), strike = fin(s.K), tau = fin(s.tauSec);

  // --- multi-timeframe candles from the shared tick buffer ---
  const tf = {
    m1: buildCandles(s.ticks ?? [], 60_000, now),
    m3: buildCandles(s.ticks ?? [], 180_000, now),
    m5: buildCandles(s.ticks ?? [], 300_000, now),
    m15: buildCandles(s.ticks ?? [], 900_000, now),
    h1: buildCandles(s.ticks ?? [], 3_600_000, now),
  };
  const atr1 = atr(tf.m1, 14);
  const vol = volatilityRead({ candles1m: tf.m1, sigmaPerSec: fin(s.sigmaPerSec), spot, strike, secondsLeft: tau });
  const strat3 = stratSignals(tf.m3);
  const strat5 = stratSignals(tf.m5);
  const cont = timeframeContinuity({ m3: tf.m3, m5: tf.m5, m15: tf.m15 });
  const broad = broadening(tf.m5, 4);
  const fvg = detectFvgs(tf.m1, { now, maxAgeMs: 45 * 60_000 });
  const struct1 = structureRead(tf.m1, { atrValue: atr1 });
  const struct5 = structureRead(tf.m5, { atrValue: atr(tf.m5, 10) });
  const trend15 = emaTrend(tf.m15, 5, 13); // fewer 15m candles available: shorter EMAs
  const trend1h = emaTrend(tf.h1, 3, 7);

  // --- evidence vote in [-1, 1] with a controlling-evidence trail (§D) ---
  const forEv = [], againstEv = [];
  let vote = 0; let controlling = null;

  const sweep = struct1.ok ? struct1.sweep : null;
  if (sweep) {
    const dir = sweep.side === 'sellside_swept' ? +1 : -1;
    vote += dir * 0.55;
    controlling = `1m liquidity sweep (${sweep.side} @ ${sweep.level.toFixed(0)}) — sweeps control over HTF trend`;
    (dir > 0 ? forEv : againstEv).push(`liquidity: ${sweep.note}`);
  }
  const bos5 = struct5.ok ? struct5.event : null;
  if (bos5) {
    const dir = bos5.type === 'BOS_up' ? +1 : -1;
    vote += dir * (struct5.displacement ? 0.45 : 0.3);
    if (!controlling) controlling = `5m ${bos5.type}${struct5.displacement ? ' with displacement' : ''} @ ${bos5.level.toFixed(0)}`;
    (dir > 0 ? forEv : againstEv).push(`structure: 5m ${bos5.type}${struct5.displacement ? ' + displacement' : ''}`);
  }
  for (const sg of [...strat3.signals, ...strat5.signals]) {
    const dir = sg.side === 'up' ? +1 : sg.side === 'down' ? -1 : 0;
    vote += dir * 0.2;
    if (dir !== 0) (dir > 0 ? forEv : againstEv).push(`STRAT: ${sg.name}`);
  }
  for (const g of fvg.active.slice(-3)) {
    // price ABOVE a held bullish gap (or below a bearish one) = displacement away = trend evidence
    if (g.side === 'bullish' && g.distance != null && g.distance > 0 && g.state !== 'filled') { vote += 0.15; forEv.push(`FVG: bullish gap ${g.state} below price (support)`); }
    if (g.side === 'bearish' && g.distance != null && g.distance > 0 && g.state !== 'filled') { vote -= 0.15; againstEv.push(`FVG: bearish gap ${g.state} above price (supply)`); }
  }
  if (trend15.state === 'up') { vote += 0.2; forEv.push('15m EMA trend up'); }
  if (trend15.state === 'down') { vote -= 0.2; againstEv.push('15m EMA trend down'); }
  if (trend1h.state === 'up') { vote += 0.1; forEv.push('1h EMA trend up'); }
  if (trend1h.state === 'down') { vote -= 0.1; againstEv.push('1h EMA trend down'); }
  if (cont.state === 'full_up') { vote += 0.15; forEv.push('timeframe continuity: all up'); }
  if (cont.state === 'full_down') { vote -= 0.15; againstEv.push('timeframe continuity: all down'); }
  if (broad.detected) { vote *= 0.6; againstEv.push('broadening formation — two-sided expansion degrades directional signals'); }
  if (struct1.ok && struct1.range) {
    if (struct1.range.zone === 'premium') { vote -= 0.1; againstEv.push('price in premium of the 1m dealing range'); }
    if (struct1.range.zone === 'discount') { vote += 0.1; forEv.push('price in discount of the 1m dealing range'); }
  }
  vote = Math.max(-1, Math.min(1, vote));
  const conviction = Math.abs(vote);
  if (!controlling) controlling = conviction >= V24_PARAMS.conviction_floor ? 'trend + continuity composite (no single controlling event)' : 'no controlling setup';

  // --- gates ---
  const dataAge = fin(s.dataAgeMs) ?? (s.ticks?.length ? now - s.ticks[s.ticks.length - 1].ts : null);
  if (dataAge == null || dataAge > V24_PARAMS.stale_after_ms) gatesFailed.push(`stale_data(${dataAge == null ? 'unknown' : Math.round(dataAge / 1000) + 's'})`);
  if (tau == null || tau < V24_PARAMS.min_tau_sec) gatesFailed.push(`too_close_to_resolution(${tau ?? '?'}s)`);
  if (spot == null || strike == null) gatesFailed.push('spot_or_strike_missing');
  if (vol.strike_realistically_reachable === false && ((spot > strike && vote < 0) || (spot < strike && vote > 0))) {
    gatesFailed.push(`strike_unreachable(${vol.strike_reachability_sigma?.toFixed(2)}σ_of_expected_move)`);
  }
  const upAsk = fin(s.up_ask), downAsk = fin(s.down_ask);
  if (upAsk == null && downAsk == null) gatesFailed.push('book_missing');

  // --- probability + economics ---
  const p = technicalProbability({ voteScore: vote, spot, strike, expectedMove: vol.expected_move_usd });
  let evYes = null, evNo = null;
  if (p != null && upAsk != null) evYes = p * 1 - upAsk - kalshiFee(upAsk);
  if (p != null && downAsk != null) evNo = (1 - p) * 1 - downAsk - kalshiFee(downAsk);

  // --- state machine: YES | NO | WAIT | NO_TRADE ---
  let recommendation, reason, waiting_for = null, entry_limit = null, side_ev = null;
  if (gatesFailed.length) {
    recommendation = 'NO_TRADE';
    reason = `gates closed: ${gatesFailed.join('; ')}`;
  } else if (conviction < V24_PARAMS.conviction_floor) {
    if (conviction > 0.12 && (strat3.developing || fvg.active.length)) {
      recommendation = 'WAIT';
      waiting_for = strat3.developing
        ? `confirmation of the developing 3m ${strat3.developing.type} candle (closes ${vote >= 0 ? 'above prior high' : 'below prior low'})`
        : 'a reaction at the nearest active FVG';
      reason = `structure is developing but unconfirmed (conviction ${conviction.toFixed(2)} < ${V24_PARAMS.conviction_floor}); ${waiting_for}`;
    } else {
      recommendation = 'NO_TRADE';
      reason = `evidence conflicting/weak (conviction ${conviction.toFixed(2)}): ${forEv.length} for vs ${againstEv.length} against`;
    }
  } else {
    const side = vote > 0 ? 'YES' : 'NO';
    const ev = side === 'YES' ? evYes : evNo;
    const ask = side === 'YES' ? upAsk : downAsk;
    side_ev = ev;
    // max entry: price at which after-fee EV = min_edge, capped at 0.97
    const pSide = side === 'YES' ? p : 1 - p;
    let maxEntry = null;
    if (pSide != null) {
      let lo = 0.01, hi = 0.97;
      for (let i = 0; i < 30; i++) { const mid = (lo + hi) / 2; (pSide - mid - kalshiFee(mid) >= V24_PARAMS.min_edge_usd) ? lo = mid : hi = mid; }
      maxEntry = Number(lo.toFixed(2));
    }
    entry_limit = maxEntry;
    if (ev != null && ev >= V24_PARAMS.min_edge_usd) {
      recommendation = side;
      reason = `${controlling}; technical p(${side}) ${(pSide * 100).toFixed(0)}% vs ask ${(ask * 100).toFixed(0)}¢ — after-fee edge $${ev.toFixed(3)}/contract`;
    } else {
      recommendation = 'WAIT';
      waiting_for = maxEntry != null ? `${side} at ${(maxEntry * 100).toFixed(0)}¢ or better (currently ${(ask * 100).toFixed(0)}¢)` : 'a priceable book';
      reason = `direction is ${side} (${controlling}) but the available price does not pay after fees; waiting for ${waiting_for}`;
    }
  }

  // --- change vs prior revision ---
  let change_reason = 'first evaluation of this market';
  if (s.prevRevision) {
    change_reason = s.prevRevision.recommendation === recommendation
      ? `unchanged (${recommendation} maintained)`
      : `changed ${s.prevRevision.recommendation} → ${recommendation}: ${reason}`;
  }

  return {
    engine_id: V24_ENGINE_ID,
    spec_version: V24_SPEC_VERSION,
    experiment_key: V24_EXPERIMENT_KEY,
    window_id: s.window_id,
    window_open_ts: s.window_open_ts ?? null,
    window_close_ts: s.window_close_ts ?? null,
    revision_seq: s.revision_seq ?? 1,
    evaluated_at: new Date(now).toISOString(),
    tau_sec: tau,
    spot,
    strike,
    distance_usd: vol.distance_usd,
    up_ask: upAsk, up_bid: fin(s.up_bid), down_ask: downAsk, down_bid: fin(s.down_bid),
    recommendation,                      // YES | NO | WAIT | NO_TRADE
    conviction: Number(conviction.toFixed(3)),
    vote: Number(vote.toFixed(3)),
    p_above: p != null ? Number(p.toFixed(4)) : null,
    entry_limit,
    side_ev_usd: side_ev != null ? Number(side_ev.toFixed(4)) : null,
    reason,
    waiting_for,
    controlling_evidence: controlling,
    strongest_bullish: forEv.slice(0, 4),
    strongest_bearish: againstEv.slice(0, 4),
    invalidation: (() => {
      const done1 = tf.m1.filter((c) => c.complete).slice(-5);
      const swingLow = struct1.ok ? struct1.swings.lastLow?.price : null;
      const swingHigh = struct1.ok ? struct1.swings.lastHigh?.price : null;
      if (vote >= 0) {
        const lvl = swingLow ?? (done1.length ? Math.min(...done1.map((c) => c.low)) : null);
        return lvl != null ? `1m close below ${lvl.toFixed(0)} (${swingLow != null ? 'last swing low' : 'recent 5-candle low'})` : null;
      }
      const lvl = swingHigh ?? (done1.length ? Math.max(...done1.map((c) => c.high)) : null);
      return lvl != null ? `1m close above ${lvl.toFixed(0)} (${swingHigh != null ? 'last swing high' : 'recent 5-candle high'})` : null;
    })(),
    change_reason,
    features: {
      strat: { m3: strat3, m5: strat5 }, continuity: cont, broadening: broad,
      fvg_active: fvg.active.slice(-5), structure_1m: struct1.ok ? { event: struct1.event, sweep: struct1.sweep, range: struct1.range } : null,
      structure_5m: struct5.ok ? { event: struct5.event, displacement: struct5.displacement } : null,
      trend: { m15: trend15.state, h1: trend1h.state }, volatility: vol,
    },
    data_status: {
      scored: ['index price action (STRAT/FVG/structure/trend across 1m-1h)', 'kalshi book (entry pricing)', 'remaining-time volatility'],
      available_not_scored: [],
      unavailable: ['volume/participation (index feed has no volume)', 'VWAP (needs volume)', 'order blocks (need footprint data)', 'funding/OI/liquidations (no derivatives source wired)', 'options-implied vol (not licensed)'],
      data_age_ms: dataAge,
      is_stale: dataAge != null && dataAge > V24_PARAMS.stale_after_ms,
    },
  };
}

/** Pre-registered grading policy (§H): the OFFICIAL call for a market. */
export function officialCall(revisions) {
  const eligible = revisions.filter((r) => (r.recommendation === 'YES' || r.recommendation === 'NO')
    && r.side_ev_usd != null && r.side_ev_usd >= V24_PARAMS.min_edge_usd);
  const first = eligible.length ? eligible.reduce((a, b) => (a.revision_seq <= b.revision_seq ? a : b)) : null;
  const last = eligible.length ? eligible.reduce((a, b) => (a.revision_seq >= b.revision_seq ? a : b)) : null;
  return {
    policy: 'first_actionable_yes_no_meeting_executable_entry (pre-registered 2026-07-26; later changes stored separately; final eligible reported as diagnostic only; never chosen after outcome)',
    official: first,
    final_eligible_diagnostic: last,
    abstained: !first,
  };
}
