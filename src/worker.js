#!/usr/bin/env node
/**
 * Founder BTC Alpha — Phase 1 capture + forecast worker.
 *
 * CAPTURE, FORECAST AND GRADE ONLY. This process reads Kalshi market data and
 * public exchange WebSockets, writes research rows, and seals forecasts from
 * the frozen models in fa_ontology_versions. It places NO orders, commits NO
 * capital, and reads NO portfolio endpoint. The Kalshi client refuses non-GET
 * requests at the transport layer, so that property does not depend on this
 * file being correct.
 *
 * Loop:
 *   - discover the active + next KXBTC15M window every 30s
 *   - snapshot the book every 5s; every 1s inside the final 120s
 *   - accumulate 1 Hz replica prints continuously (never gated on a window)
 *   - seal all four frozen models at T-10 / T-5 / T-2 (+/-5s)
 *   - flush at most one batched write per 5s per window
 *   - on close, resolve settlement, grade the replica, and score every seal
 *   - heartbeat log every 60s
 */

import { loadEnv } from './env.js';
import { clientFromEnv } from './kalshi-client.js';
import { ReplicaIndex, REPLICA_METHODOLOGY_VERSION } from './replica-index.js';
import { normaliseOrderbook, evaluateInvariants } from './orderbook.js';
import { sessionBucket, loadMacroCalendar, macroFlag } from './session.js';
import { sinkFromEnv } from './sink.js';
import {
  sealPointFor, buildSealRows, brier, logLoss, MODEL_IDS,
} from './forecaster.js';
import { runPreflight } from './preflight.js';
import { startDashboard } from './dashboard.js';
import { V2Scheduler } from './v2/scheduler.js';

loadEnv();

const SERIES = process.env.KALSHI_SERIES_TICKER || 'KXBTC15M';
const DRY_RUN = process.argv.includes('--dry-run') || process.env.CAPTURE_DRY_RUN === 'true';
// BTC Alpha V2 shadow engine (btc-alpha-v2-scalp). DEFAULT OFF: when unset the worker
// behaves EXACTLY as Phase-1 — the V2 scheduler is never constructed or called, so this
// splice is provably inert until the env flag is deliberately turned on. Still shadow-only
// (writes to fa_v2_decisions/grades; places no orders; emission_prod unaffected).
const V2_SHADOW = process.env.V2_SHADOW_ENABLED === 'true';
const MAX_WINDOWS = Number(
  (process.argv.find((a) => a.startsWith('--max-windows=')) || '').split('=')[1] || 0
);

const SNAPSHOT_MS = 5_000;
const FINAL_PHASE_MS = 1_000;
const FINAL_PHASE_WINDOW_S = 120;
const DISCOVERY_MS = 30_000;
const HEARTBEAT_MS = 60_000;

const log = {
  info: (m, ...a) => console.log(`${new Date().toISOString()} INFO  ${m}`, ...a),
  warn: (m, ...a) => console.warn(`${new Date().toISOString()} WARN  ${m}`, ...a),
  error: (m, ...a) => console.error(`${new Date().toISOString()} ERROR ${m}`, ...a),
};

class CaptureWorker {
  constructor() {
    this.kalshi = clientFromEnv({ env: 'prod' });
    this.replica = new ReplicaIndex({ logger: log });
    this.sink = sinkFromEnv({ logger: log, forceDryRun: DRY_RUN });
    this.macro = loadMacroCalendar();

    /** @type {Map<string, object>} windowId -> tracking state */
    this.windows = new Map();
    this.completed = [];
    this.stopping = false;
    this.startedAt = Date.now();
    this.stats = {
      snapshots: 0, flushes: 0, settlements: 0,
      discovery_errors: 0, snapshot_errors: 0,
      seals_graded: 0,
    };
    this._timers = [];

    // V2 shadow scheduler — only constructed when the flag is on. Injected deps only;
    // it never touches Phase-1 state. getOrderbook THROWS on a bad book so a transient
    // failure retries next tick rather than burning the window's single minute-3 seal.
    this.v2 = V2_SHADOW
      ? new V2Scheduler({
          writeDecision: (row) => this.sink.writeV2Decision(row),
          writeGrade: (row) => this.sink.writeV2Grade(row),
          getOrderbook: async (windowId) => {
            const ob = await this.kalshi.getOrderbook(windowId, 100);
            if (ob.status !== 200) throw new Error(`orderbook HTTP ${ob.status}`);
            return normaliseOrderbook(ob.body);
          },
          getMacroEvent: (now) => {
            try { return macroFlag(new Date(now), this.macro).flag; } catch { return false; }
          },
          logger: log,
          isReplay: false,
        })
      : null;
  }

  async start() {
    log.info(`=== Founder BTC Alpha capture worker ===`);
    log.info(`series=${SERIES} sink=${this.sink.mode} replica=${REPLICA_METHODOLOGY_VERSION}`);
    log.info(
      `macro calendar: ${this.macro.loaded ? `${this.macro.events.length} events` : 'NOT LOADED'}`
    );
    if (MAX_WINDOWS) log.info(`will exit after ${MAX_WINDOWS} completed window(s)`);

    this.replica.on('venue-reconnect', (v, reason, delay) =>
      log.warn(`replica venue ${v} reconnecting in ${delay}ms (${reason})`)
    );
    this.replica.start();

    // Founder-only read-only dashboard. Only starts with a Supabase client
    // (nothing to show against a dry-run sink) and a token set. It reads the
    // same DB the worker writes; it never writes.
    if (this.sink.mode === 'supabase' && process.env.FOUNDER_DASH_TOKEN) {
      const port = Number(process.env.PORT || process.env.DASH_PORT || 8787);
      this.dashboard = startDashboard({
        getClient: () => this.sink._ensureClient(),
        token: process.env.FOUNDER_DASH_TOKEN,
        port,
        logger: log,
      });
    } else if (!process.env.FOUNDER_DASH_TOKEN) {
      log.info('dashboard: FOUNDER_DASH_TOKEN not set — route disabled');
    }

    // Let the replica accumulate before the first snapshot so early rows carry
    // a real 60s average rather than a thin one.
    await this._discover();

    this._timers.push(setInterval(() => this._discover(), DISCOVERY_MS));
    this._timers.push(setInterval(() => this._tick(), FINAL_PHASE_MS));
    this._timers.push(setInterval(() => this._heartbeat(), HEARTBEAT_MS));

    process.on('SIGINT', () => this.stop('SIGINT'));
    process.on('SIGTERM', () => this.stop('SIGTERM'));
  }

  async stop(reason) {
    if (this.stopping) return;
    this.stopping = true;
    log.info(`shutting down (${reason})`);
    for (const t of this._timers) clearInterval(t);
    this.replica.stop();
    if (this.dashboard) { try { this.dashboard.close(); } catch { /* already closed */ } }
    const res = await this.sink.flush();
    log.info(`final flush wrote ${res.written} row(s); ${this.sink.pending} still pending`);
    this._summary();
    process.exit(0);
  }

  _summary() {
    const uptime = Math.round((Date.now() - this.startedAt) / 1000);
    log.info('=== SUMMARY ===');
    log.info(`uptime=${uptime}s snapshots=${this.stats.snapshots} flushes=${this.stats.flushes}`);
    log.info(`windows completed=${this.completed.length} settlements=${this.stats.settlements}`);
    log.info(`sink: ${JSON.stringify(this.sink.stats)}`);
    if (this.sink.mode === 'dry-run') {
      log.info(`dry-run files: ${JSON.stringify(this.sink.files)}`);
    }
    for (const w of this.completed) {
      log.info(
        `  window ${w.window_id}: snapshots=${w.snapshots} seals=${w.sealsWritten} flagged=${w.flagged} ` +
          `settled=${w.settlement_value ?? 'pending'} replica_err=${w.replica_error ?? 'n/a'}`
      );
    }
  }

  /** Find the active and next windows. */
  async _discover() {
    try {
      const res = await this.kalshi.getMarkets({
        series_ticker: SERIES,
        status: 'open',
        limit: 20,
      });
      const markets = res.body?.markets || [];
      if (!markets.length) {
        log.warn('discovery returned no open markets');
        return;
      }

      // Sort by close time; the soonest to close is the active window.
      markets.sort((a, b) => new Date(a.close_time) - new Date(b.close_time));

      for (const m of markets.slice(0, 2)) {
        if (!this.windows.has(m.ticker)) {
          this.windows.set(m.ticker, {
            window_id: m.ticker,
            event_ticker: m.event_ticker,
            open_time: m.open_time,
            close_time: m.close_time,
            reference_strike: m.floor_strike ?? null,
            snapshots: 0,
            flagged: 0,
            prevTs: null,
            lastFlushAt: 0,
            settled: false,
            role: null,
            sealsDone: new Set(),   // seal-point labels already attempted
            sealsWritten: 0,
            sealPasses: [],
          });
          log.info(
            `discovered window ${m.ticker} close=${m.close_time} strike=${m.floor_strike ?? 'TBD'}`
          );
        } else {
          // floor_strike is TBD until the opening minute has elapsed, so keep
          // refreshing it rather than trusting the first read.
          const w = this.windows.get(m.ticker);
          if (m.floor_strike != null) w.reference_strike = m.floor_strike;
          w.close_time = m.close_time;
        }
      }
    } catch (err) {
      this.stats.discovery_errors += 1;
      log.error(`discovery failed: ${err.message}`);
    }
  }

  /** 1 Hz driver: decides which windows need a snapshot this second. */
  async _tick() {
    if (this.stopping) return;
    const now = Date.now();

    for (const w of [...this.windows.values()]) {
      const closeMs = new Date(w.close_time).getTime();
      const secondsToClose = Math.round((closeMs - now) / 1000);

      // Past close: settle and retire.
      if (secondsToClose <= 0) {
        if (!w.settled) {
          w.settled = true;
          this._settle(w).catch((e) => log.error(`settle ${w.window_id}: ${e.message}`));
        }
        continue;
      }

      // ---- Phase 1: sealed forecasts at T-10 / T-5 / T-2 (+/-5s) ----
      const sp = sealPointFor(secondsToClose);
      if (sp && !w.sealsDone.has(sp.label)) {
        w.sealsDone.add(sp.label); // mark BEFORE awaiting: one attempt per point
        this._seal(w, sp, secondsToClose).catch((e) =>
          log.error(`seal ${w.window_id} ${sp.label}: ${e.message}`)
        );
      }

      const inFinalPhase = secondsToClose <= FINAL_PHASE_WINDOW_S;
      const cadence = inFinalPhase ? FINAL_PHASE_MS : SNAPSHOT_MS;
      if (now - (w.lastSnapshotAt || 0) < cadence - 50) continue;
      w.lastSnapshotAt = now;

      await this._snapshot(w, secondsToClose, inFinalPhase ? 'final120' : 'normal');
    }

    // ---- V2 shadow (flagged): continuous bar feed + single minute-3 seal ----
    // Wrapped so any V2 fault is isolated and can never disrupt Phase-1 capture.
    if (this.v2) {
      try {
        await this.v2.onTick({
          windows: [...this.windows.values()],
          replicaIndex: this.replica.lastTick?.index ?? null,
          now,
        });
      } catch (e) {
        log.error(`v2 onTick failed (isolated): ${e.message}`);
      }
    }

    // Batched flush: at most one write per 5s, covering all windows.
    if (now - (this._lastFlushAt || 0) >= SNAPSHOT_MS && this.sink.pending > 0) {
      this._lastFlushAt = now;
      const res = await this.sink.flush();
      if (res.written) {
        this.stats.flushes += 1;
        log.info(`flushed ${res.written} row(s) (${this.sink.mode})`);
      }
    }
  }

  async _snapshot(w, secondsToClose, phase) {
    try {
      const ob = await this.kalshi.getOrderbook(w.window_id, 100);
      if (ob.status !== 200) {
        log.warn(`orderbook ${w.window_id} -> HTTP ${ob.status}`);
        return;
      }

      const now = Date.now();
      const book = normaliseOrderbook(ob.body);
      const tick = this.replica.lastTick || {};
      const avg60 = this.replica.trailing60s(now);
      const vol = this.replica.volSnapshot(now);
      const when = new Date(now);
      const macro = macroFlag(when, this.macro);

      const flags = evaluateInvariants(book, {
        prevTs: w.prevTs,
        ts: now,
        replicaIndex: tick.index ?? null,
      });
      w.prevTs = now;
      w.snapshots += 1;
      this.stats.snapshots += 1;
      if (Object.keys(flags).length) w.flagged += 1;

      const { _levels, ...bookFields } = book;

      this.sink.queueCapture({
        window_id: w.window_id,
        event_ticker: w.event_ticker,
        ts: when.toISOString(),
        ...bookFields,
        replica_index: tick.index ?? null,
        replica_60s_avg: avg60.avg,
        replica_60s_n: avg60.n,
        replica_venues_used: tick.venues_used ?? null,
        replica_venue_count: tick.venue_count ?? null,
        replica_weight_share: tick.weight_share ?? null,
        reference_strike: w.reference_strike,
        replica_vs_reference:
          avg60.avg != null && w.reference_strike != null
            ? Number((avg60.avg - w.reference_strike).toFixed(2))
            : null,
        rv_1m: vol.rv_1m,
        rv_5m: vol.rv_5m,
        rv_15m: vol.rv_15m,
        session_bucket: sessionBucket(when),
        macro_flag: macro.flag,
        macro_events: macro.events.length ? macro.events : null,
        seconds_to_close: secondsToClose,
        capture_phase: phase,
        quality_flags: flags,
      });
    } catch (err) {
      this.stats.snapshot_errors += 1;
      log.error(`snapshot ${w.window_id} failed: ${err.message}`);
    }
  }

  /**
   * On close: read the settled market and grade the replica against the true
   * settlement. The settlement value can lag the close, so retry briefly.
   */
  async _settle(w) {
    log.info(`window ${w.window_id} closed; resolving settlement`);

    // Capture the replica's closing 60s average AT close, which is the
    // quantity Kalshi settles on. Reading it later would be a different number.
    const closeMs = new Date(w.close_time).getTime();
    const replicaClose = this.replica.trailing60s(closeMs);
    const volClose = this.replica.volSnapshot(closeMs);

    let market = null;
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await new Promise((r) => setTimeout(r, attempt === 0 ? 3_000 : 10_000));
      try {
        const res = await this.kalshi.getMarket(w.window_id);
        const m = res.body?.market;
        if (m && (m.result || m.status === 'settled' || m.status === 'finalized')) {
          market = m;
          break;
        }
        market = m || market;
      } catch (err) {
        log.warn(`settlement read ${w.window_id} attempt ${attempt + 1}: ${err.message}`);
      }
    }

    const settlementValue =
      market?.expiration_value != null ? Number(market.expiration_value) : null;
    const outcome = market?.result ? String(market.result).toLowerCase() : null;
    const reference = w.reference_strike;

    // What the replica would have predicted: closing 60s mean vs reference.
    const replicaPredictedOutcome =
      replicaClose.avg != null && reference != null
        ? replicaClose.avg >= reference
          ? 'yes'
          : 'no'
        : null;

    const replicaError =
      settlementValue != null && replicaClose.avg != null
        ? Number((replicaClose.avg - settlementValue).toFixed(2))
        : null;

    const row = {
      window_id: w.window_id,
      event_ticker: w.event_ticker,
      window_open_ts: w.open_time,
      window_close_ts: w.close_time,
      settlement_value: settlementValue,
      reference_strike: reference,
      outcome: outcome === 'yes' || outcome === 'no' ? outcome : null,
      replica_predicted_settlement: replicaClose.avg,
      replica_predicted_outcome: replicaPredictedOutcome,
      replica_error: replicaError,
      replica_error_bps:
        replicaError != null && settlementValue
          ? Number(((replicaError / settlementValue) * 10_000).toFixed(4))
          : null,
      replica_outcome_agrees:
        outcome && replicaPredictedOutcome ? outcome === replicaPredictedOutcome : null,
      replica_60s_n: replicaClose.n,
      session_bucket: sessionBucket(new Date(w.close_time)),
      macro_flag: macroFlag(new Date(w.close_time), this.macro).flag,
      rv_5m_at_close: volClose.rv_5m,
      graded_at: new Date().toISOString(),
      quality_flags: settlementValue == null ? { settlement_unresolved: true } : {},
    };

    await this.sink.flush(); // ensure capture rows land before the grade
    await this.sink.writeSettlement(row);
    this.stats.settlements += 1;

    // Phase 1: score every sealed forecast for this window.
    if (row.outcome) {
      this.stats.seals_graded += await this._gradeSeals(w, row.outcome);
    }

    // V2 shadow (flagged): grade the one minute-3 decision. Isolated from Phase-1.
    // Only grades resolved windows (yes/no); an unresolved settlement is left ungraded.
    if (this.v2 && row.outcome) {
      try {
        await this.v2.onSettle(
          { window_id: w.window_id },
          { outcome: row.outcome, settlement_value: settlementValue, graded_at: Date.now() }
        );
      } catch (e) {
        log.error(`v2 onSettle failed (isolated): ${e.message}`);
      }
    }

    log.info(
      `settled ${w.window_id}: value=${settlementValue ?? 'UNRESOLVED'} outcome=${outcome ?? '?'} ` +
        `replica=${replicaClose.avg ?? 'n/a'} err=${replicaError ?? 'n/a'} ` +
        `agrees=${row.replica_outcome_agrees ?? 'n/a'}`
    );

    this.completed.push({ ...w, settlement_value: settlementValue, replica_error: replicaError });
    this.windows.delete(w.window_id);

    if (MAX_WINDOWS && this.completed.length >= MAX_WINDOWS) {
      log.info(`reached --max-windows=${MAX_WINDOWS}`);
      await this.stop('max-windows');
    }
  }

  /**
   * Seal all four frozen models at one seal point.
   *
   * A model that cannot compute from real inputs PASSES: no row is written.
   * The absence of a seal is the honest record; sealed_p is NOT NULL in the
   * schema, so there is no way to record a fabricated or null probability.
   *
   * Seals are written immediately rather than batched: the sealed_at < close
   * CHECK is the whole integrity guarantee, and a batched seal could drift
   * past close and be rejected. A late seal is dropped, never backdated.
   */
  async _seal(w, sealPoint, secondsToClose) {
    const sealedAt = new Date();
    const closeMs = new Date(w.close_time).getTime();
    if (sealedAt.getTime() >= closeMs) {
      log.warn(`seal ${w.window_id} ${sealPoint.label} DROPPED: would postdate close`);
      return;
    }

    let book;
    try {
      const ob = await this.kalshi.getOrderbook(w.window_id, 100);
      if (ob.status !== 200) {
        log.warn(`seal ${w.window_id} ${sealPoint.label}: orderbook HTTP ${ob.status}`);
        return;
      }
      book = normaliseOrderbook(ob.body);
    } catch (err) {
      log.error(`seal ${w.window_id} ${sealPoint.label}: book fetch failed: ${err.message}`);
      return;
    }

    const now = Date.now();
    const tick = this.replica.lastTick || {};
    const vol = this.replica.volSnapshot(now);
    const ret5m = this._replicaReturn(5 * 60_000, now);

    const { rows, passes } = buildSealRows({
      windowId: w.window_id,
      windowCloseTs: new Date(closeMs).toISOString(),
      sealedAt: sealedAt.toISOString(),
      sealPoint,
      secondsToClose,
      book,
      replica: tick.index ?? null,
      strike: w.reference_strike,
      sigma: vol.rv_15m,
      ret5m,
    });

    // Re-check the clock AFTER the network round trip.
    if (Date.now() >= closeMs) {
      log.warn(`seal ${w.window_id} ${sealPoint.label} DROPPED: close passed during fetch`);
      return;
    }

    const res = await this.sink.writeSeals(rows);
    w.sealsWritten += res.written || 0;
    if (passes.length) w.sealPasses.push({ seal_point: sealPoint.label, passes });

    log.info(
      `SEAL ${w.window_id} ${sealPoint.label} T-${secondsToClose}s: ` +
        `${res.written || 0}/4 sealed` +
        (passes.length ? ` | PASS: ${passes.map((p) => p.model_id.split('-')[0] + '=' + p.reason).join(' ')}` : '') +
        (rows.length ? ` | p=[${rows.map((r) => r.model_id.split('-')[0] + ':' + r.sealed_p.toFixed(3)).join(' ')}]` : '')
    );
  }

  /** Signed replica return over the trailing `ms`, or null if uncovered. */
  _replicaReturn(ms, endTs) {
    const buf = this.replica.window.buf;
    if (!buf.length) return null;
    const start = endTs - ms;
    const recent = buf.filter((p) => p.ts >= start && p.ts <= endTs);
    if (recent.length < 10) return null;
    const first = recent[0].value;
    const last = recent[recent.length - 1].value;
    if (!(first > 0) || !(last > 0)) return null;
    // Require the sample to actually span the requested horizon.
    if (recent[recent.length - 1].ts - recent[0].ts < ms * 0.8) return null;
    return Math.log(last / first);
  }

  /**
   * Grade every seal of a settled window: Brier, log loss, and the delta
   * against B0 at the SAME seal point (stats-rules v1 primary metric).
   */
  async _gradeSeals(w, outcome) {
    if (outcome !== 'yes' && outcome !== 'no') {
      log.warn(`grade ${w.window_id}: outcome '${outcome}' not gradeable`);
      return 0;
    }
    if (this.sink.mode !== 'supabase') {
      log.info(`grade ${w.window_id}: skipped (dry-run sink has no seal ids)`);
      return 0;
    }

    let seals;
    try {
      const client = await this.sink._ensureClient();
      const { data, error } = await client
        .from('fa_forecast_seal')
        .select('id,model_id,model_version,sealed_p,executable_prices')
        .eq('window_id', w.window_id);
      if (error) throw new Error(error.message);
      seals = data || [];
    } catch (err) {
      log.error(`grade ${w.window_id}: seal fetch failed: ${err.message}`);
      return 0;
    }
    if (!seals.length) return 0;

    const yes = outcome === 'yes';

    // B0's Brier per seal point is the baseline every other model is scored against.
    const b0Brier = {};
    for (const s of seals) {
      if (s.model_id === MODEL_IDS.B0) {
        b0Brier[s.model_version] = brier(Number(s.sealed_p), yes);
      }
    }

    const rows = [];
    for (const s of seals) {
      const p = Number(s.sealed_p);
      const b = brier(p, yes);
      const base = b0Brier[s.model_version];
      rows.push({
        seal_id: s.id,
        window_id: w.window_id,
        model_id: s.model_id,
        model_version: s.model_version,
        seal_point: String(s.model_version).split('@')[1] || null,
        outcome,
        sealed_p: p,
        market_p_at_seal: s.executable_prices?.up_mid ?? null,
        brier: b,
        log_loss: logLoss(p, yes),
        // Signed: negative means the model beat the market baseline.
        brier_vs_b0: Number.isFinite(base) && Number.isFinite(b) ? b - base : null,
      });
    }

    const res = await this.sink.writeGrades(rows);
    log.info(`GRADED ${w.window_id}: ${res.written || 0} seal(s) scored vs outcome=${outcome}`);
    return res.written || 0;
  }

  _heartbeat() {
    const h = this.replica.health();
    const venues = Object.entries(h.venues)
      .map(([v, s]) => `${v}=${s.fresh ? 'ok' : 'STALE'}`)
      .join(' ');
    const active = [...this.windows.values()]
      .map((w) => {
        const s = Math.round((new Date(w.close_time).getTime() - Date.now()) / 1000);
        return `${w.window_id}(T-${s}s,n=${w.snapshots},seals=${w.sealsWritten})`;
      })
      .join(' ');
    const tick = this.replica.lastTick || {};
    log.info(
      `heartbeat uptime=${Math.round((Date.now() - this.startedAt) / 1000)}s ` +
        `index=${tick.index ?? 'n/a'} venues[${venues}] ` +
        `windows[${active || 'none'}] snapshots=${this.stats.snapshots} ` +
        `pending=${this.sink.pending} reconnects=${h.stats.reconnects}`
    );
  }
}

// Preflight BEFORE constructing the worker: the constructor builds the Kalshi
// client, which parses the PEM and would otherwise die with a raw OpenSSL
// decoder error. Running the diagnosis first means Railway's logs name the
// fault ("PEM newlines lost on paste") instead of a cryptic crash. A fatal
// config exits non-zero so the restart policy does not loop on a dead config.
if (!runPreflight(process.env, log)) {
  log.error('refusing to start on a fatal config error; see docs/RAILWAY-FIX.md');
  process.exit(1);
}

let worker;
try {
  worker = new CaptureWorker();
} catch (err) {
  log.error(`worker construction failed: ${err.message} — see docs/RAILWAY-FIX.md`);
  process.exit(1);
}
worker.start().catch((err) => {
  log.error(`worker failed to start: ${err.message}`);
  console.error(err.stack);
  process.exit(1);
});
