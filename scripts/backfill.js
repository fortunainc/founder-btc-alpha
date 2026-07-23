#!/usr/bin/env node
/**
 * Backfill JSONL captured while Supabase writes were unavailable.
 *
 * Sources, in order:
 *   data/capture/*.jsonl  — dry-run output
 *   data/spill/*.jsonl    — rows spilled after repeated live-write failures
 *
 * Usage:
 *   node scripts/backfill.js --check     verify connectivity only, write nothing
 *   node scripts/backfill.js --dry       report what WOULD be inserted
 *   node scripts/backfill.js             perform the insert
 *
 * The target tables are append-only. `fa_window_capture` has NO unique
 * constraint (only an index) on (window_id, ts), so a plain re-insert WOULD
 * double-count. This script therefore de-dups capture rows on (window_id, ts)
 * against what is already in the DB before inserting, which makes it idempotent
 * and safe to re-run. It still requires --confirm for large loads.
 *
 * Usable both locally and INSIDE the Railway container (`railway ssh` -> node
 * scripts/backfill.js) to recover /app/data/spill before a redeploy wipes the
 * ephemeral disk.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadEnv } from '../src/env.js';
import { ensureWebSocket } from '../src/ws-polyfill.js';
import { CAPTURE_TABLE, SETTLEMENT_TABLE } from '../src/sink.js';

loadEnv();

const CHECK_ONLY = process.argv.includes('--check');
const DRY = process.argv.includes('--dry');
const CONFIRM = process.argv.includes('--confirm');
const BATCH = 500;

function readJsonlFrom(dir, prefix) {
  const abs = path.resolve(process.cwd(), dir);
  if (!fs.existsSync(abs)) return [];
  const rows = [];
  for (const f of fs.readdirSync(abs).filter((x) => x.startsWith(prefix) && x.endsWith('.jsonl'))) {
    const text = fs.readFileSync(path.join(abs, f), 'utf8').trim();
    if (!text) continue;
    for (const line of text.split('\n')) {
      try {
        rows.push(JSON.parse(line));
      } catch {
        /* torn final line */
      }
    }
  }
  return rows;
}

const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
if (!url || !key) {
  console.error('BLOCKED: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY not set');
  process.exit(1);
}

// The broken Railway container (node:20) has no global WebSocket, and this
// script may be run there to recover spills, so inject ws before createClient.
await ensureWebSocket();

const { createClient } = await import('@supabase/supabase-js');
const client = createClient(url, key, {
  auth: { persistSession: false, autoRefreshToken: false },
  db: { schema: 'founder_alpha' },
});

// --- connectivity preflight ------------------------------------------
console.log('=== connectivity check ===');
const probe = await client.from('fa_ontology_versions').select('kind,version');
if (probe.error) {
  console.error(`FAILED: ${probe.error.code || ''} ${probe.error.message}`);
  if (probe.error.code === 'PGRST106') {
    console.error('\n  The founder_alpha schema is not exposed to the REST API.');
    console.error('  Fix: Supabase Dashboard -> Project Settings -> API ->');
    console.error('       "Exposed schemas" -> add `founder_alpha` -> Save.');
  }
  process.exit(1);
}
console.log(`OK — ontology rows: ${probe.data.map((r) => `${r.kind}/${r.version}`).join(', ')}`);
if (CHECK_ONLY) process.exit(0);

// --- gather ----------------------------------------------------------
// Optional dir override so this can point at a copied-out Railway spill dir:
//   node scripts/backfill.js --spill-dir=/tmp/railway-spill
const spillDirArg = (process.argv.find((a) => a.startsWith('--spill-dir=')) || '').split('=')[1];
const spillDir = spillDirArg || 'data/spill';

const captures = [
  ...readJsonlFrom('data/capture', CAPTURE_TABLE),
  ...readJsonlFrom(spillDir, 'spill'),
];
const settlements = readJsonlFrom('data/capture', SETTLEMENT_TABLE);

console.log(`\ncapture rows on disk:    ${captures.length} (spill dir: ${spillDir})`);
console.log(`settlement rows on disk: ${settlements.length}`);

const existing = await client.from(CAPTURE_TABLE).select('*', { count: 'exact', head: true });
console.log(`rows already in ${CAPTURE_TABLE}: ${existing.count ?? 'unknown'}`);

// --- de-dup captures on (window_id, ts) ------------------------------
// fa_window_capture has no unique constraint, so we cannot rely on ON CONFLICT.
// Query existing (window_id, ts) keys for exactly the windows present on disk,
// and drop any spill row already in the DB. This makes the backfill idempotent.
async function filterNewCaptures(rows) {
  const windows = [...new Set(rows.map((r) => r.window_id))];
  const present = new Set();
  for (const wid of windows) {
    let from = 0;
    const PAGE = 1000;
    for (;;) {
      const { data, error } = await client
        .from(CAPTURE_TABLE)
        .select('ts')
        .eq('window_id', wid)
        .range(from, from + PAGE - 1);
      if (error) throw new Error(`existing-key fetch: ${error.message}`);
      for (const r of data) present.add(`${wid}|${new Date(r.ts).toISOString()}`);
      if (data.length < PAGE) break;
      from += PAGE;
    }
  }
  const fresh = [];
  let already = 0;
  for (const r of rows) {
    const key = `${r.window_id}|${new Date(r.ts).toISOString()}`;
    if (present.has(key)) already += 1;
    else fresh.push(r);
  }
  return { fresh, already };
}

const { fresh: freshCaptures, already: alreadyCaptures } = await filterNewCaptures(captures);
console.log(
  `capture de-dup on (window_id, ts): ${alreadyCaptures} already in DB, ${freshCaptures.length} new`
);

if (DRY) {
  console.log('\n--dry: nothing written. Would insert ' +
    `${freshCaptures.length} capture + ${settlements.length} settlement row(s).`);
  process.exit(0);
}
if (freshCaptures.length > 10_000 && !CONFIRM) {
  console.error(`\nREFUSING: ${freshCaptures.length} new rows is large. Re-run with --confirm.`);
  process.exit(1);
}

// --- insert ----------------------------------------------------------
async function insertAll(table, rows) {
  let written = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const chunk = rows.slice(i, i + BATCH).map(({ _levels, ...r }) => r);
    const { error } = await client.from(table).insert(chunk);
    if (error) {
      console.error(`  batch @${i} FAILED: ${error.code || ''} ${error.message}`);
      return { written, error };
    }
    written += chunk.length;
    console.log(`  ${table}: ${written}/${rows.length}`);
  }
  return { written };
}

console.log('\n=== inserting (de-duped) ===');
const c = await insertAll(CAPTURE_TABLE, freshCaptures);
const s = await insertAll(SETTLEMENT_TABLE, settlements);

console.log(`\ncaptures written:    ${c.written}/${captures.length}`);
console.log(`settlements written: ${s.written}/${settlements.length}`);
process.exit(c.error || s.error ? 1 : 0);
