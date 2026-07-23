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
 * The target tables are append-only, so this script MUST NOT be run twice over
 * the same files -- duplicates cannot be deleted afterwards. It prints the
 * exact row counts it is about to write and requires --confirm to proceed when
 * more than 10k rows are involved.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadEnv } from '../src/env.js';
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
const captures = [
  ...readJsonlFrom('data/capture', CAPTURE_TABLE),
  ...readJsonlFrom('data/spill', 'spill'),
];
const settlements = readJsonlFrom('data/capture', SETTLEMENT_TABLE);

console.log(`\ncapture rows on disk:    ${captures.length}`);
console.log(`settlement rows on disk: ${settlements.length}`);

const existing = await client.from(CAPTURE_TABLE).select('*', { count: 'exact', head: true });
console.log(`rows already in ${CAPTURE_TABLE}: ${existing.count ?? 'unknown'}`);

if (DRY) {
  console.log('\n--dry: nothing written.');
  process.exit(0);
}
if (captures.length > 10_000 && !CONFIRM) {
  console.error(`\nREFUSING: ${captures.length} rows is large and these tables are append-only.`);
  console.error('Re-run with --confirm if this is genuinely intended.');
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

console.log('\n=== inserting ===');
const c = await insertAll(CAPTURE_TABLE, captures);
const s = await insertAll(SETTLEMENT_TABLE, settlements);

console.log(`\ncaptures written:    ${c.written}/${captures.length}`);
console.log(`settlements written: ${s.written}/${settlements.length}`);
process.exit(c.error || s.error ? 1 : 0);
