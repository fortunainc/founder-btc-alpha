/**
 * BTC Alpha V2 — seal scheduler (Phase A worker glue, dependency-injected).
 *
 * Bridges the live worker loop to the analytical core WITHOUT importing any
 * worker/sink/kalshi internals: everything it needs is injected, so it is unit
 * testable with fakes and cannot perturb the running Phase-1 worker.
 *
 * Behaviour (the V2 contract):
 *   - Maintains ONE continuous BarBuilder fed by replica ticks (window-agnostic:
 *     BTC price is continuous, the 15-min Kalshi boundary is not a price break).
 *   - Fires exactly ONE decision seal per window, at ~minute 3 (τ≈720s to close),
 *     then never re-seals that window. A transient orderbook failure does NOT
 *     burn the window's single seal (it retries next tick); a produced decision
 *     — including NO_TRADE on cold/thin data — is final.
 *   - On settlement, grades that one decision once (paper P&L at the SEALED
 *     executable ask + Kalshi fee; NO midpoint fills), never mutating the seal.
 *
 * Pure control-flow; all I/O and the clock are injected.
 */

import { BarBuilder } from './bars.js';
import { sealDecision, gradeDecision, sealProfitDecision } from './engine.js';
import { sealChallengerV23 } from './challenger-v23.js';
import { evaluateV24, officialCall, V24_ENGINE_ID, V24_SPEC_VERSION, V24_PARAMS } from './technical/engine-v24.js';

export const SEAL_TAU_SEC = 720;      // minute 3 of a 900s window — the single seal instant
export const SEAL_FLOOR_SEC = 120;    // never seal in the final 2 min: that is not a "first-3-minutes" call
export const WARMUP_MS = 15 * 60_000; // decide() also gates on this; kept here for the seal-readiness note
const VOL_WINDOW_MS = 10 * 60_000;
const VOL_STEP_MS = 30_000;

export class V2Scheduler {
  /**
   * @param {object} deps
   * @param {(row:object)=>Promise<{written:number,id?:number|string}>} deps.writeDecision  persist one decision, returns its id
   * @param {(row:object)=>Promise<{written:number}>} deps.writeGrade   persist one grade
   * @param {(windowId:string)=>Promise<object|null>} deps.getOrderbook returns a normalised book {up_bid,up_ask,down_bid,down_ask} or null
   * @param {object} [deps.logger]
   * @param {boolean} [deps.isReplay]
   * @param {number} [deps.sealTauSec]
   */
  constructor({ writeDecision, writeGrade, getOrderbook, getMacroEvent, getTradeTape, readDecision = null, logger = console, isReplay = false, sealTauSec = SEAL_TAU_SEC, withProfitEngine = false, withV23Challenger = false, withV24Technical = false, writeRevision = null } = {}) {
    this.writeDecision = writeDecision;
    this.writeGrade = writeGrade;
    // readDecision(windowId, engineId) -> stored decision row or null.
    // AUDIT FIX (2026-07-26, grade 57): grading MUST price from the STORED seal,
    // not the in-memory object — a transient write-retry can reseal in memory with
    // a fresher book while the DB keeps the first (canonical) row. When a reader is
    // provided, onSettle grades the stored row; memory is only a fallback.
    this.readDecision = typeof readDecision === 'function' ? readDecision : null;
    this.getOrderbook = getOrderbook;
    this.getMacroEvent = typeof getMacroEvent === 'function' ? getMacroEvent : () => false;
    this.getTradeTape = typeof getTradeTape === 'function' ? getTradeTape : () => null;
    this.logger = logger;
    this.isReplay = !!isReplay;
    this.sealTauSec = sealTauSec;
    this.withProfitEngine = withProfitEngine === true;
    // v2.3 REGISTERED shadow challenger (experiment btc-v23-e1): flag-gated,
    // isolated, distinct engine_id — can never alter the frozen engines' rows.
    this.withV23Challenger = withV23Challenger === true;
    // v2.4 FOUNDER TECHNICAL engine (experiment btc-v24-technical-e1): continuous
    // 2.5-min revision cadence across the WHOLE 15m market, immutable revisions via
    // writeRevision; the OFFICIAL call (first actionable YES/NO, pre-registered) is
    // written once through writeDecision so the existing grade path settles it.
    this.withV24Technical = withV24Technical === true && typeof writeRevision === 'function';
    this.writeRevision = writeRevision;
    // v2.4 technical engine needs ~75 min of history (1h HTF context + 15m market);
    // the default 20 min only served the 15m realized-vol lookback.
    this.bars = new BarBuilder({ maxAgeMs: 75 * 60_000 });
    /** @type {Map<string,{sealing:boolean,sealed:boolean,decision:object|null,decisionId:any,graded:boolean,missed:boolean}>} */
    this.windows = new Map();
  }

  _state(windowId) {
    let s = this.windows.get(windowId);
    if (!s) { s = { sealing: false, sealed: false, decision: null, decisionId: null, graded: false, missed: false, profitDecision: null, profitDecisionId: null, profitGraded: false, v23Decision: null, v23DecisionId: null, v23Graded: false, v24LastRevAt: 0, v24Seq: 0, v24Prev: null, v24Official: null, v24OfficialId: null, v24Graded: false, v24Revising: false, v24Misses: 0 }; this.windows.set(windowId, s); }
    return s;
  }

  /** Feed one replica tick into the continuous buffer. */
  ingestTick(ts, price) { this.bars.add(ts, price); }

  /** Seed the bar buffer from historical points (boot backfill) so vol is warm immediately after a restart. */
  seedHistory(points) { return this.bars.seed(points); }

  secondsToClose(w, now) { return Math.round((new Date(w.close_time).getTime() - now) / 1000); }

  /**
   * 1 Hz driver. Call once per tick with the active windows and the current
   * replica price. Seals each eligible window exactly once at ~minute 3.
   * @param {object} p { windows: Array<{window_id,close_time,reference_strike,event_ticker?}>, replicaIndex:number|null, now:number }
   */
  async onTick({ windows = [], replicaIndex = null, now }) {
    if (replicaIndex != null && Number.isFinite(replicaIndex)) this.bars.add(now, replicaIndex);

    for (const w of windows) {
      const stc = this.secondsToClose(w, now);
      if (stc <= 0) continue;                        // closed — settlement handles it
      const st = this._state(w.window_id);

      // ---- v2.4 continuous technical revisions (whole market, cadence-gated) ----
      if (this.withV24Technical && w.reference_strike != null && !st.v24Revising
          && now - st.v24LastRevAt >= V24_PARAMS.refresh_target_ms) {
        st.v24Revising = true;
        try {
          await this._v24Revise(w, stc, now, st);
        } catch (err) {
          st.v24Misses += 1;
          this.logger.error?.(`[v24] revision ${w.window_id} failed (missed refresh #${st.v24Misses}): ${err.message}`);
        }
        st.v24Revising = false;
      }

      if (st.sealed || st.sealing || st.missed) continue;
      if (stc > this.sealTauSec) continue;           // before minute 3 — wait for the seal instant

      if (stc < SEAL_FLOOR_SEC) {                     // discovered too late to be a first-3-min call
        st.missed = true;
        this.logger.warn?.(`[v2] ${w.window_id} MISSED seal window (stc=${stc}s < floor ${SEAL_FLOOR_SEC}s); no decision`);
        continue;
      }
      if (w.reference_strike == null) continue;       // strike not published yet — hold the seal (don't burn it)

      st.sealing = true; // guard against re-entry within the same async gap
      try {
        await this._seal(w, stc, now, st);
      } catch (err) {
        st.sealing = false; // transient failure — allow a retry on a later tick (seal not burned)
        this.logger.error?.(`[v2] seal ${w.window_id} failed: ${err.message}`);
        continue;
      }
      st.sealing = false;
    }
  }

  async _v24Revise(w, stc, now, st) {
    const book = await this.getOrderbook(w.window_id);
    const rev = evaluateV24({
      window_id: w.window_id,
      window_open_ts: w.open_time ? new Date(w.open_time).toISOString() : null,
      window_close_ts: new Date(w.close_time).toISOString(),
      now, tauSec: stc,
      S: this.bars.last(), K: w.reference_strike,
      ticks: this.bars.ticks,
      sigmaPerSec: this.bars.realizedVolPerSec(VOL_WINDOW_MS, VOL_STEP_MS, now),
      up_ask: book?.up_ask ?? null, up_bid: book?.up_bid ?? null,
      down_ask: book?.down_ask ?? null, down_bid: book?.down_bid ?? null,
      dataAgeMs: this.bars.ticks.length ? now - this.bars.ticks[this.bars.ticks.length - 1].ts : null,
      prevRevision: st.v24Prev, revision_seq: st.v24Seq + 1,
    });
    rev.missed_refreshes = st.v24Misses;
    await this.writeRevision(rev);                    // IMMUTABLE append — never overwrites
    st.v24Seq += 1; st.v24Prev = rev; st.v24LastRevAt = now;
    this.logger.info?.(`[v24] rev#${rev.revision_seq} ${w.window_id} → ${rev.recommendation} (conv ${rev.conviction})`);

    // OFFICIAL call (pre-registered §H): FIRST actionable YES/NO meeting the
    // executable-entry requirement → one standard decision row, graded later by
    // the normal settle path. Never re-chosen, never updated.
    if (!st.v24Official && (rev.recommendation === 'YES' || rev.recommendation === 'NO')
        && rev.side_ev_usd != null && rev.side_ev_usd >= V24_PARAMS.min_edge_usd) {
      const side = rev.recommendation === 'YES' ? 'TAKE_YES' : 'TAKE_NO';
      const official = {
        window_id: w.window_id, sealed_at: rev.evaluated_at,
        window_close_ts: rev.window_close_ts, seconds_to_close_at_seal: stc,
        engine_id: V24_ENGINE_ID, spec_version: V24_SPEC_VERSION,
        recommendation: side, status: 'ok',
        reason: `OFFICIAL (first actionable, rev#${rev.revision_seq}): ${rev.reason}`,
        strike: rev.strike, replica_index: rev.spot, market_p: null,
        up_ask: rev.up_ask, down_ask: rev.down_ask, up_bid: rev.up_bid, down_bid: rev.down_bid,
        half_spread: (rev.up_ask != null && rev.up_bid != null) ? Number(((rev.up_ask - rev.up_bid) / 2).toFixed(6)) : null,
        regime: null, reachability_bucket: null, conflict_signature: null,
        conviction: rev.conviction, agreement: null, matrix_version: null, consensus: null,
        families: {},
        evidence: { experiment_key: rev.experiment_key, revision_seq: rev.revision_seq, p_above: rev.p_above, entry_limit: rev.entry_limit, side_ev_usd: rev.side_ev_usd, controlling: rev.controlling_evidence, grading_policy: 'first_actionable_yes_no_meeting_executable_entry' },
        is_replay: this.isReplay,
      };
      const res = await this.writeDecision(official);
      st.v24Official = official; st.v24OfficialId = res?.id ?? null;
      this.logger.info?.(`[v24] OFFICIAL ${w.window_id} = ${side} @ rev#${rev.revision_seq}`);
    }
  }

  async _seal(w, secondsToClose, now, st) {
    const book = await this.getOrderbook(w.window_id); // may throw → caller retries
    const replica = this.bars.last();
    const sigmaPerSec = this.bars.realizedVolPerSec(VOL_WINDOW_MS, VOL_STEP_MS, now); // null if thin → decide() NO_TRADE
    const up_bid = book?.up_bid ?? null, up_ask = book?.up_ask ?? null;
    const down_bid = book?.down_bid ?? null, down_ask = book?.down_ask ?? null;
    const market_p = (up_bid != null && up_ask != null) ? Number(((up_bid + up_ask) / 2).toFixed(6)) : null;

    const sealInput = {
      window_id: w.window_id,
      window_close_ts: new Date(w.close_time).toISOString(),
      now,
      S: replica,
      K: w.reference_strike,
      tauSec: secondsToClose,
      bars: this.bars,
      sigmaPerSec,
      market_p,
      up_ask, down_ask, up_bid, down_bid,
      half_spread: (up_ask != null && up_bid != null) ? (up_ask - up_bid) / 2 : null,
      macroEvent: !!this.getMacroEvent(now),
      tape: this.getTradeTape(),
      is_replay: this.isReplay,
    };
    const decision = sealDecision(sealInput);

    const res = await this.writeDecision(decision);
    st.sealed = true;                       // one seal per window, final
    st.decision = decision;
    st.decisionId = res?.id ?? null;
    this.logger.info?.(`[v2] SEAL ${w.window_id} τ-${secondsToClose}s → ${decision.recommendation} (${decision.status})`);

    // v2.2 PROFIT engine (shadow): a SECOND sealed decision on the same inputs, picked by
    // expected net dollars after fees rather than conviction. Distinct engine_id → no unique
    // conflict; isolated so a profit write never burns the arbiter seal.
    if (this.withProfitEngine) {
      try {
        const profitDecision = sealProfitDecision(sealInput);
        const pres = await this.writeDecision(profitDecision);
        st.profitDecision = profitDecision;
        st.profitDecisionId = pres?.id ?? null;
        this.logger.info?.(`[v2] SEAL(profit) ${w.window_id} → ${profitDecision.recommendation} (ev=${profitDecision.evidence?.chosen_ev})`);
      } catch (e) {
        this.logger.error?.(`[v2] profit seal ${w.window_id} failed (isolated): ${e.message}`);
      }
    }

    // v2.3 tech+profit challenger (shadow): a THIRD sealed decision on the same
    // inputs — conviction AND after-fee EV must agree. Isolated like profit.
    if (this.withV23Challenger) {
      try {
        const v23Decision = sealChallengerV23(sealInput);
        const vres = await this.writeDecision(v23Decision);
        st.v23Decision = v23Decision;
        st.v23DecisionId = vres?.id ?? null;
        this.logger.info?.(`[v2] SEAL(v23) ${w.window_id} → ${v23Decision.recommendation}`);
      } catch (e) {
        this.logger.error?.(`[v2] v23 seal ${w.window_id} failed (isolated): ${e.message}`);
      }
    }
    return decision;
  }

  /**
   * Grade the (single) sealed decision for a settled window. Idempotent.
   * @param {object} w { window_id }
   * @param {object} settlement { outcome:'yes'|'no'|'void', settlement_value?, graded_at }
   */
  /** Prefer the STORED decision row over the in-memory one (audit fix, grade 57). */
  async _canonicalDecision(windowId, engineId, memoryDecision, memoryId) {
    if (this.readDecision) {
      try {
        const stored = await this.readDecision(windowId, engineId);
        if (stored) {
          const num = (v) => (v == null ? null : Number(v));
          return {
            decision: {
              ...stored,
              up_ask: num(stored.up_ask), down_ask: num(stored.down_ask),
              up_bid: num(stored.up_bid), down_bid: num(stored.down_bid),
            },
            decisionId: stored.id ?? memoryId ?? null,
            source: 'stored',
          };
        }
      } catch (e) {
        this.logger.warn?.(`[v2] readDecision ${windowId}/${engineId} failed (${e.message}); falling back to memory`);
      }
    }
    return { decision: memoryDecision, decisionId: memoryId ?? null, source: 'memory' };
  }

  async onSettle(w, settlement) {
    const st = this._state(w.window_id);
    if (!st.sealed || !st.decision) { this.logger.warn?.(`[v2] settle ${w.window_id}: no sealed decision to grade`); return { graded: 0 }; }
    if (st.graded) return { graded: 0 };

    const canon = await this._canonicalDecision(w.window_id, st.decision.engine_id, st.decision, st.decisionId);
    const grade = gradeDecision(canon.decision, settlement);
    if (canon.decisionId != null) grade.decision_id = canon.decisionId; // FK link when the DB id is known
    const res = await this.writeGrade(grade);
    st.graded = true;
    this.logger.info?.(`[v2] GRADE ${w.window_id} ${canon.decision.recommendation}/${settlement.outcome} → net=${grade.net_pnl} correct=${grade.call_correct} (priced from ${canon.source})`);

    // grade the profit engine's decision too (same settlement, its own row)
    if (st.profitDecision && !st.profitGraded) {
      try {
        const pcanon = await this._canonicalDecision(w.window_id, st.profitDecision.engine_id, st.profitDecision, st.profitDecisionId);
        const pgrade = gradeDecision(pcanon.decision, settlement);
        if (pcanon.decisionId != null) pgrade.decision_id = pcanon.decisionId;
        await this.writeGrade(pgrade);
        st.profitGraded = true;
        this.logger.info?.(`[v2] GRADE(profit) ${w.window_id} ${pcanon.decision.recommendation}/${settlement.outcome} → net=${pgrade.net_pnl} (priced from ${pcanon.source})`);
      } catch (e) {
        this.logger.error?.(`[v2] profit grade ${w.window_id} failed (isolated): ${e.message}`);
      }
    }

    // grade the v2.4 OFFICIAL call (pre-registered first-actionable policy)
    if (st.v24Official && !st.v24Graded) {
      try {
        const ocanon = await this._canonicalDecision(w.window_id, V24_ENGINE_ID, st.v24Official, st.v24OfficialId);
        const ograde = gradeDecision(ocanon.decision, settlement);
        if (ocanon.decisionId != null) ograde.decision_id = ocanon.decisionId;
        await this.writeGrade(ograde);
        st.v24Graded = true;
        this.logger.info?.(`[v24] GRADE ${w.window_id} ${ocanon.decision.recommendation}/${settlement.outcome} → net=${ograde.net_pnl} (priced from ${ocanon.source})`);
      } catch (e) {
        this.logger.error?.(`[v24] grade ${w.window_id} failed (isolated): ${e.message}`);
      }
    }

    // grade the v2.3 challenger's decision too (same settlement, its own row)
    if (st.v23Decision && !st.v23Graded) {
      try {
        const vcanon = await this._canonicalDecision(w.window_id, st.v23Decision.engine_id, st.v23Decision, st.v23DecisionId);
        const vgrade = gradeDecision(vcanon.decision, settlement);
        if (vcanon.decisionId != null) vgrade.decision_id = vcanon.decisionId;
        await this.writeGrade(vgrade);
        st.v23Graded = true;
        this.logger.info?.(`[v2] GRADE(v23) ${w.window_id} ${vcanon.decision.recommendation}/${settlement.outcome} → net=${vgrade.net_pnl} (priced from ${vcanon.source})`);
      } catch (e) {
        this.logger.error?.(`[v2] v23 grade ${w.window_id} failed (isolated): ${e.message}`);
      }
    }
    return { graded: res?.written ? 1 : 0, grade };
  }
}

export default V2Scheduler;
