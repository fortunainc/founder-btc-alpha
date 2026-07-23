/**
 * Batched write sink.
 *
 * Two backends, same interface:
 *   SupabaseSink — writes to schema `founder_alpha` via the service role.
 *   DryRunSink   — appends JSONL to data/capture/, for use before the CTO has
 *                  applied the migration. Produces the same row shapes so a
 *                  dry run is a genuine rehearsal, not a different code path.
 *
 * Batching contract (dispatch section D): at most ONE write per 5s per window.
 * The 1 Hz snapshots taken in the final 120s are accumulated and flushed in the
 * same 5s cadence, so row volume stays sane while resolution stays high.
 */

import fs from 'node:fs';
import path from 'node:path';

const CAPTURE_TABLE = 'fa_window_capture';
const SETTLEMENT_TABLE = 'fa_settlement_grade';
const SEAL_TABLE = 'fa_forecast_seal';
const GRADE_TABLE = 'fa_forecast_grade';

/**
 * Above this many pending rows, or this many consecutive failures, the sink
 * stops holding data in memory and spills it to disk. Without this a sustained
 * Supabase outage would grow the queue unbounded until the container OOMs --
 * losing everything held in memory, which is the exact outcome the requeue
 * logic was meant to prevent.
 */
const MAX_PENDING_ROWS = 5_000;
const MAX_CONSECUTIVE_FAILURES = 3;

class BaseSink {
  constructor({ logger = console } = {}) {
    this.logger = logger;
    this.stats = {
      rows_queued: 0,
      rows_written: 0,
      flushes: 0,
      errors: 0,
      rows_spilled: 0,
      spill_events: 0,
      seals_written: 0,
      grades_written: 0,
    };
    this._queue = [];
    this._consecutiveFailures = 0;
    this._spillFile = null;
  }

  /**
   * Last-resort durability: append rows to a local JSONL file and drop them
   * from memory. Data survives for later backfill instead of being lost to an
   * OOM kill.
   */
  _spill(rows, reason) {
    try {
      if (!this._spillFile) {
        const dir = path.resolve(process.cwd(), 'data', 'spill');
        fs.mkdirSync(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        this._spillFile = path.join(dir, `spill-${stamp}.jsonl`);
      }
      fs.appendFileSync(
        this._spillFile,
        rows.map((r) => JSON.stringify(r)).join('\n') + '\n',
        'utf8'
      );
      this.stats.rows_spilled += rows.length;
      this.stats.spill_events += 1;
      this.logger.error?.(
        `[sink] SPILLED ${rows.length} row(s) to ${this._spillFile} (${reason}). ` +
          'Data is preserved on disk and must be backfilled manually.'
      );
    } catch (err) {
      this.logger.error?.(`[sink] SPILL FAILED, ${rows.length} row(s) LOST: ${err.message}`);
    }
  }

  /** Queue a capture row. Never writes immediately. */
  queueCapture(row) {
    this._queue.push(row);
    this.stats.rows_queued += 1;
  }

  get pending() {
    return this._queue.length;
  }

  /** Flush everything queued. Subclasses implement _write. */
  async flush() {
    if (!this._queue.length) return { written: 0 };
    const batch = this._queue.splice(0, this._queue.length);
    try {
      await this._write(CAPTURE_TABLE, batch);
      this.stats.rows_written += batch.length;
      this.stats.flushes += 1;
      this._consecutiveFailures = 0;
      return { written: batch.length };
    } catch (err) {
      this.stats.errors += 1;
      this._consecutiveFailures += 1;

      // Re-queue at the FRONT so ordering is preserved and data is not lost.
      this._queue.unshift(...batch);

      // Bounded memory: once the backend is persistently unavailable, move the
      // backlog to disk rather than growing the queue until the process dies.
      if (
        this._consecutiveFailures >= MAX_CONSECUTIVE_FAILURES ||
        this._queue.length > MAX_PENDING_ROWS
      ) {
        const spill = this._queue.splice(0, this._queue.length);
        this._spill(
          spill,
          `${this._consecutiveFailures} consecutive failures, ${spill.length} pending`
        );
      }

      this.logger.error?.(
        `[sink] flush failed (${batch.length} rows requeued, ` +
          `${this._consecutiveFailures} consecutive): ${err.message}`
      );
      return { written: 0, error: err.message };
    }
  }

  /**
   * Write sealed forecasts. Idempotent by construction: the schema's
   * UNIQUE(model_id, model_version, window_id) plus ON CONFLICT DO NOTHING
   * means a re-run of the same seal point inserts nothing. This needs only
   * INSERT privilege -- it never updates, so it works under the deliberately
   * UPDATE-less grant from migration 002.
   */
  async writeSeals(rows) {
    if (!rows.length) return { written: 0 };
    try {
      await this._writeIgnoreDuplicates(SEAL_TABLE, rows, 'model_id,model_version,window_id');
      this.stats.seals_written += rows.length;
      return { written: rows.length };
    } catch (err) {
      this.stats.errors += 1;
      this.logger.error?.(`[sink] seal write failed: ${err.message}`);
      return { written: 0, error: err.message };
    }
  }

  /** Write forecast grades. Idempotent on seal_id. */
  async writeGrades(rows) {
    if (!rows.length) return { written: 0 };
    try {
      await this._writeIgnoreDuplicates(GRADE_TABLE, rows, 'seal_id');
      this.stats.grades_written += rows.length;
      return { written: rows.length };
    } catch (err) {
      this.stats.errors += 1;
      this.logger.error?.(`[sink] grade write failed: ${err.message}`);
      return { written: 0, error: err.message };
    }
  }

  async writeSettlement(row) {
    try {
      await this._write(SETTLEMENT_TABLE, [row]);
      return { written: 1 };
    } catch (err) {
      this.stats.errors += 1;
      this.logger.error?.(`[sink] settlement write failed: ${err.message}`);
      return { written: 0, error: err.message };
    }
  }
}

export class SupabaseSink extends BaseSink {
  constructor({ url, serviceRoleKey, logger = console } = {}) {
    super({ logger });
    this.mode = 'supabase';
    if (!url || !serviceRoleKey) {
      throw new Error('SupabaseSink requires SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
    }
    this._url = url;
    this._key = serviceRoleKey;
    this._client = null;
  }

  async _ensureClient() {
    if (this._client) return this._client;

    // supabase-js's createClient builds a Realtime client that needs a global
    // WebSocket even though we never use Realtime. Node <22 has none, so on the
    // Railway node:20 image every flush failed with "native WebSocket not
    // found" and rows spilled to disk. Inject `ws` before createClient.
    const { ensureWebSocket } = await import('./ws-polyfill.js');
    await ensureWebSocket();

    const { createClient } = await import('@supabase/supabase-js');
    this._client = createClient(this._url, this._key, {
      auth: { persistSession: false, autoRefreshToken: false },
      db: { schema: 'founder_alpha' },
    });
    return this._client;
  }

  async _write(table, rows) {
    const client = await this._ensureClient();
    // Strip internal-only fields before they reach the DB.
    const clean = rows.map(({ _levels, ...rest }) => rest);
    const { error } = await client.from(table).insert(clean);
    if (error) throw new Error(`${error.code || ''} ${error.message}`.trim());
  }

  async _writeIgnoreDuplicates(table, rows, conflictCols) {
    const client = await this._ensureClient();
    const clean = rows.map(({ _levels, ...rest }) => rest);
    // ignoreDuplicates => ON CONFLICT DO NOTHING, which requires only INSERT.
    const { error } = await client
      .from(table)
      .upsert(clean, { onConflict: conflictCols, ignoreDuplicates: true });
    if (error) throw new Error(`${error.code || ''} ${error.message}`.trim());
  }
}

export class DryRunSink extends BaseSink {
  constructor({ dir = path.resolve(process.cwd(), 'data', 'capture'), logger = console } = {}) {
    super({ logger });
    this.mode = 'dry-run';
    this.dir = dir;
    fs.mkdirSync(this.dir, { recursive: true });
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    this.files = {
      [CAPTURE_TABLE]: path.join(this.dir, `${CAPTURE_TABLE}-${stamp}.jsonl`),
      [SETTLEMENT_TABLE]: path.join(this.dir, `${SETTLEMENT_TABLE}-${stamp}.jsonl`),
      [SEAL_TABLE]: path.join(this.dir, `${SEAL_TABLE}-${stamp}.jsonl`),
      [GRADE_TABLE]: path.join(this.dir, `${GRADE_TABLE}-${stamp}.jsonl`),
    };
  }

  async _write(table, rows) {
    const file = this.files[table];
    const payload = rows.map((r) => JSON.stringify(r)).join('\n') + '\n';
    await fs.promises.appendFile(file, payload, 'utf8');
  }
}

/**
 * Choose a sink from the environment. Falls back to dry-run — deliberately,
 * because a missing Supabase config must never cause silent data loss.
 */
export function sinkFromEnv({ logger = console, forceDryRun = false } = {}) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (forceDryRun || !url || !key) {
    const reason = forceDryRun
      ? '--dry-run requested'
      : 'SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set';
    logger.warn?.(`[sink] using DRY-RUN sink (${reason}); rows go to data/capture/*.jsonl`);
    return new DryRunSink({ logger });
  }
  logger.info?.('[sink] using Supabase sink (schema founder_alpha)');
  return new SupabaseSink({ url, serviceRoleKey: key, logger });
}

export { CAPTURE_TABLE, SETTLEMENT_TABLE, SEAL_TABLE, GRADE_TABLE };
