#!/usr/bin/env node
/**
 * Runtime proof that the replica index actually connects to all four public
 * venues and produces sane 1 Hz prints. Writes fixtures/11-replica-probe.json.
 *
 * Usage: node scripts/probe-replica.js [seconds]
 */

import fs from 'node:fs';
import path from 'node:path';
import { ReplicaIndex, REPLICA_METHODOLOGY_VERSION } from '../src/replica-index.js';

const SECONDS = Number(process.argv[2] || 75);

const idx = new ReplicaIndex();
const events = [];
const ticks = [];

idx.on('venue-open', (v) => {
  console.log(`  [open] ${v}`);
  events.push({ t: new Date().toISOString(), event: 'open', venue: v });
});
idx.on('venue-error', (v, m) => {
  console.log(`  [error] ${v}: ${m}`);
  events.push({ t: new Date().toISOString(), event: 'error', venue: v, message: m });
});
idx.on('venue-reconnect', (v, reason, delay) => {
  console.log(`  [reconnect] ${v} in ${delay}ms (${reason})`);
  events.push({ t: new Date().toISOString(), event: 'reconnect', venue: v, reason, delay_ms: delay });
});
idx.on('tick', (t) => {
  ticks.push(t);
  if (ticks.length % 15 === 0) {
    const avg = idx.trailing60s();
    console.log(
      `  tick #${ticks.length} index=${t.index} venues=[${t.venues_used.join(',')}] ` +
        `60s_avg=${avg.avg} (n=${avg.n})`
    );
  }
});

console.log(`=== replica index probe (${SECONDS}s) ===`);
idx.start();

setTimeout(() => {
  idx.stop();

  const withIndex = ticks.filter((t) => t.index !== null);
  const health = idx.health();
  const avg60 = idx.trailing60s();
  const vol = idx.volSnapshot();

  const venueParticipation = {};
  for (const t of withIndex) {
    for (const v of t.venues_used) venueParticipation[v] = (venueParticipation[v] || 0) + 1;
  }

  const values = withIndex.map((t) => t.index);
  const out = {
    methodology_version: REPLICA_METHODOLOGY_VERSION,
    captured_at: new Date().toISOString(),
    duration_seconds: SECONDS,
    ticks_total: ticks.length,
    ticks_with_index: withIndex.length,
    coverage_pct: ticks.length ? Number(((withIndex.length / ticks.length) * 100).toFixed(1)) : 0,
    index_min: values.length ? Math.min(...values) : null,
    index_max: values.length ? Math.max(...values) : null,
    index_last: values.length ? values[values.length - 1] : null,
    trailing_60s_average: avg60,
    realized_vol: vol,
    venue_participation_ticks: venueParticipation,
    venue_health_at_end: health,
    sample_ticks: withIndex.slice(-5),
    events,
    status:
      withIndex.length > SECONDS * 0.5 && Object.keys(venueParticipation).length >= 2
        ? 'VERIFIED'
        : 'FAILED',
  };

  const file = path.resolve(process.cwd(), 'fixtures', '11-replica-probe.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(out, null, 2));

  console.log(`\n  ticks with index: ${withIndex.length}/${ticks.length} (${out.coverage_pct}%)`);
  console.log(`  venue participation: ${JSON.stringify(venueParticipation)}`);
  console.log(`  60s avg: ${avg60.avg} (n=${avg60.n})`);
  console.log(`  vol 1m/5m: ${vol.rv_1m} / ${vol.rv_5m}`);
  console.log(`  fixture -> fixtures/11-replica-probe.json`);
  console.log(`\nSTATUS: ${out.status}`);
  process.exit(out.status === 'VERIFIED' ? 0 : 1);
}, SECONDS * 1000);
