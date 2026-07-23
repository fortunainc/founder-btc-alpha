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

class BaseSink {
  constructor({ logger = console } = {}) {
    this.logger = logger;
    this.stats = { rows_queued: 0, rows_written: 0, flushes: 0, errors: 0 };
    this._queue = [];
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
      return { written: batch.length };
    } catch (err) {
      this.stats.errors += 1;
      // Re-queue at the FRONT so ordering is preserved and data is not lost.
      this._queue.unshift(...batch);
      this.logger.error?.(`[sink] flush failed (${batch.length} rows requeued): ${err.message}`);
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

export { CAPTURE_TABLE, SETTLEMENT_TABLE };
