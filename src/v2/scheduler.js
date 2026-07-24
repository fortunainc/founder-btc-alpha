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
import { sealDecision, gradeDecision } from './engine.js';

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
  constructor({ writeDecision, writeGrade, getOrderbook, getMacroEvent, logger = console, isReplay = false, sealTauSec = SEAL_TAU_SEC } = {}) {
    this.writeDecision = writeDecision;
    this.writeGrade = writeGrade;
    this.getOrderbook = getOrderbook;
    this.getMacroEvent = typeof getMacroEvent === 'function' ? getMacroEvent : () => false;
    this.logger = logger;
    this.isReplay = !!isReplay;
    this.sealTauSec = sealTauSec;
    this.bars = new BarBuilder();
    /** @type {Map<string,{sealing:boolean,sealed:boolean,decision:object|null,decisionId:any,graded:boolean,missed:boolean}>} */
    this.windows = new Map();
  }

  _state(windowId) {
    let s = this.windows.get(windowId);
    if (!s) { s = { sealing: false, sealed: false, decision: null, decisionId: null, graded: false, missed: false }; this.windows.set(windowId, s); }
    return s;
  }

  /** Feed one replica tick into the continuous buffer. */
  ingestTick(ts, price) { this.bars.add(ts, price); }

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

  async _seal(w, secondsToClose, now, st) {
    const book = await this.getOrderbook(w.window_id); // may throw → caller retries
    const replica = this.bars.last();
    const sigmaPerSec = this.bars.realizedVolPerSec(VOL_WINDOW_MS, VOL_STEP_MS, now); // null if thin → decide() NO_TRADE
    const up_bid = book?.up_bid ?? null, up_ask = book?.up_ask ?? null;
    const down_bid = book?.down_bid ?? null, down_ask = book?.down_ask ?? null;
    const market_p = (up_bid != null && up_ask != null) ? Number(((up_bid + up_ask) / 2).toFixed(6)) : null;

    const decision = sealDecision({
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
      macroEvent: !!this.getMacroEvent(now),
      is_replay: this.isReplay,
    });

    const res = await this.writeDecision(decision);
    st.sealed = true;                       // one seal per window, final
    st.decision = decision;
    st.decisionId = res?.id ?? null;
    this.logger.info?.(`[v2] SEAL ${w.window_id} τ-${secondsToClose}s → ${decision.recommendation} (${decision.status})`);
    return decision;
  }

  /**
   * Grade the (single) sealed decision for a settled window. Idempotent.
   * @param {object} w { window_id }
   * @param {object} settlement { outcome:'yes'|'no'|'void', settlement_value?, graded_at }
   */
  async onSettle(w, settlement) {
    const st = this._state(w.window_id);
    if (!st.sealed || !st.decision) { this.logger.warn?.(`[v2] settle ${w.window_id}: no sealed decision to grade`); return { graded: 0 }; }
    if (st.graded) return { graded: 0 };

    const grade = gradeDecision(st.decision, settlement);
    if (st.decisionId != null) grade.decision_id = st.decisionId; // FK link when the DB id is known
    const res = await this.writeGrade(grade);
    st.graded = true;
    this.logger.info?.(`[v2] GRADE ${w.window_id} ${st.decision.recommendation}/${settlement.outcome} → net=${grade.net_pnl} correct=${grade.call_correct}`);
    return { graded: res?.written ? 1 : 0, grade };
  }
}

export default V2Scheduler;
