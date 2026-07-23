#!/usr/bin/env node
/**
 * Summarise a dry-run capture: per-window coverage, cadence conformance,
 * invariant violations, gap census, and replica grading.
 *
 * Produces fixtures/14-capture-analysis.json — the runtime evidence for the
 * RVR's end-to-end capture claim.
 */

import fs from 'node:fs';
import path from 'node:path';

const dir = path.resolve(process.cwd(), 'data', 'capture');
if (!fs.existsSync(dir)) {
  console.error('no data/capture directory — run the worker in --dry-run first');
  process.exit(1);
}

const files = fs.readdirSync(dir);
const readJsonl = (prefix) => {
  const rows = [];
  for (const f of files.filter((x) => x.startsWith(prefix))) {
    const text = fs.readFileSync(path.join(dir, f), 'utf8').trim();
    if (!text) continue;
    for (const line of text.split('\n')) {
      try {
        rows.push(JSON.parse(line));
      } catch {
        /* skip torn line */
      }
    }
  }
  return rows;
};

const captures = readJsonl('fa_window_capture');
const settlements = readJsonl('fa_settlement_grade');

// --- per-window analysis ---------------------------------------------
const byWindow = new Map();
for (const r of captures) {
  if (!byWindow.has(r.window_id)) byWindow.set(r.window_id, []);
  byWindow.get(r.window_id).push(r);
}

const windows = [];
for (const [windowId, rowsRaw] of byWindow) {
  const rows = [...rowsRaw].sort((a, b) => new Date(a.ts) - new Date(b.ts));

  // Cadence conformance, measured separately per phase.
  const gaps = [];
  for (let i = 1; i < rows.length; i += 1) {
    gaps.push({
      ms: new Date(rows[i].ts) - new Date(rows[i - 1].ts),
      phase: rows[i].capture_phase,
    });
  }
  const normalGaps = gaps.filter((g) => g.phase === 'normal').map((g) => g.ms);
  const finalGaps = gaps.filter((g) => g.phase === 'final120').map((g) => g.ms);
  const mean = (a) => (a.length ? Math.round(a.reduce((x, y) => x + y, 0) / a.length) : null);

  // Invariant census.
  const flagCounts = {};
  for (const r of rows) {
    for (const k of Object.keys(r.quality_flags || {})) {
      flagCounts[k] = (flagCounts[k] || 0) + 1;
    }
  }

  // Complementary-mid check, computed independently of the worker's own flag
  // so this is a genuine audit rather than a restatement.
  const sums = rows
    .filter((r) => r.up_mid != null && r.down_mid != null)
    .map((r) => Number((r.up_mid + r.down_mid).toFixed(4)));
  const outOfBand = sums.filter((s) => s < 0.97 || s > 1.01);

  // Monotonicity audit.
  let nonMonotonic = 0;
  for (let i = 1; i < rows.length; i += 1) {
    if (new Date(rows[i].ts) <= new Date(rows[i - 1].ts)) nonMonotonic += 1;
  }

  const replicaNulls = rows.filter((r) => r.replica_index == null).length;
  const thin60s = rows.filter((r) => (r.replica_60s_n ?? 0) < 55).length;
  const settlement = settlements.find((s) => s.window_id === windowId) || null;

  const first = rows[0];
  const last = rows[rows.length - 1];

  windows.push({
    window_id: windowId,
    snapshots: rows.length,
    first_ts: first?.ts,
    last_ts: last?.ts,
    span_seconds: first && last ? Math.round((new Date(last.ts) - new Date(first.ts)) / 1000) : 0,
    phases: {
      normal: rows.filter((r) => r.capture_phase === 'normal').length,
      final120: rows.filter((r) => r.capture_phase === 'final120').length,
    },
    cadence_ms: {
      normal_mean: mean(normalGaps),
      normal_target: 5000,
      final120_mean: mean(finalGaps),
      final120_target: 1000,
    },
    gaps_over_30s: gaps.filter((g) => g.ms > 30_000).length,
    max_gap_seconds: gaps.length ? Math.round(Math.max(...gaps.map((g) => g.ms)) / 1000) : 0,
    invariants: {
      flag_counts: flagCounts,
      independent_audit: {
        mid_sum_out_of_band: outOfBand.length,
        mid_sum_min: sums.length ? Math.min(...sums) : null,
        mid_sum_max: sums.length ? Math.max(...sums) : null,
        non_monotonic_timestamps: nonMonotonic,
        replica_null_rows: replicaNulls,
        thin_60s_average_rows: thin60s,
      },
    },
    session_buckets: [...new Set(rows.map((r) => r.session_bucket))],
    macro_flagged_rows: rows.filter((r) => r.macro_flag).length,
    settlement,
  });
}

windows.sort((a, b) => String(a.first_ts).localeCompare(String(b.first_ts)));

// --- replica grading across settled windows ---------------------------
const graded = settlements.filter((s) => s.replica_error != null);
const errs = graded.map((s) => Math.abs(s.replica_error));
const agree = settlements.filter((s) => s.replica_outcome_agrees === true).length;
const disagree = settlements.filter((s) => s.replica_outcome_agrees === false).length;

const report = {
  captured_at: new Date().toISOString(),
  source: 'dry-run JSONL (Supabase migration not yet applied by CTO)',
  totals: {
    capture_rows: captures.length,
    windows_seen: byWindow.size,
    windows_settled: settlements.length,
    fully_captured_windows: windows.filter((w) => w.phases.final120 > 0 && w.settlement).length,
  },
  replica_grading: {
    graded_windows: graded.length,
    abs_error_min: errs.length ? Math.min(...errs) : null,
    abs_error_max: errs.length ? Math.max(...errs) : null,
    abs_error_mean: errs.length
      ? Number((errs.reduce((a, b) => a + b, 0) / errs.length).toFixed(2))
      : null,
    outcome_agreements: agree,
    outcome_disagreements: disagree,
    note:
      graded.length < 30
        ? `Sample of ${graded.length} is FAR too small for any accuracy claim. These are ` +
          'existence-proof numbers only: they show the grading pipeline works end to end, ' +
          'not that the replica is accurate.'
        : null,
  },
  windows,
};

fs.mkdirSync(path.resolve(process.cwd(), 'fixtures'), { recursive: true });
fs.writeFileSync(
  path.resolve(process.cwd(), 'fixtures', '14-capture-analysis.json'),
  JSON.stringify(report, null, 2)
);

// --- console summary --------------------------------------------------
console.log('=== Capture analysis ===');
console.log(`rows=${report.totals.capture_rows} windows=${report.totals.windows_seen} settled=${report.totals.windows_settled}`);
console.log(`fully captured (final120 + settlement): ${report.totals.fully_captured_windows}\n`);

for (const w of windows) {
  console.log(`  ${w.window_id}`);
  console.log(
    `    snapshots=${w.snapshots} span=${w.span_seconds}s ` +
      `phases[normal=${w.phases.normal} final120=${w.phases.final120}]`
  );
  console.log(
    `    cadence: normal=${w.cadence_ms.normal_mean}ms (target 5000) ` +
      `final120=${w.cadence_ms.final120_mean}ms (target 1000)`
  );
  console.log(
    `    gaps>30s=${w.gaps_over_30s} maxgap=${w.max_gap_seconds}s ` +
      `mid_sum_range=[${w.invariants.independent_audit.mid_sum_min}, ${w.invariants.independent_audit.mid_sum_max}]`
  );
  console.log(
    `    violations: sum_out_of_band=${w.invariants.independent_audit.mid_sum_out_of_band} ` +
      `non_monotonic=${w.invariants.independent_audit.non_monotonic_timestamps} ` +
      `replica_null=${w.invariants.independent_audit.replica_null_rows}`
  );
  if (w.settlement) {
    const s = w.settlement;
    console.log(
      `    SETTLED value=${s.settlement_value} outcome=${s.outcome} ` +
        `replica=${s.replica_predicted_settlement} err=${s.replica_error} ` +
        `(${s.replica_error_bps}bps) agrees=${s.replica_outcome_agrees}`
    );
  } else {
    console.log('    (not settled within this run)');
  }
}

console.log(`\n=== Replica grading ===`);
console.log(`  graded windows: ${report.replica_grading.graded_windows}`);
console.log(
  `  |error|: min=${report.replica_grading.abs_error_min} ` +
    `mean=${report.replica_grading.abs_error_mean} max=${report.replica_grading.abs_error_max}`
);
console.log(
  `  outcome agree/disagree: ${report.replica_grading.outcome_agreements}/${report.replica_grading.outcome_disagreements}`
);
if (report.replica_grading.note) console.log(`  NOTE: ${report.replica_grading.note}`);
console.log('\nfixture -> fixtures/14-capture-analysis.json');
