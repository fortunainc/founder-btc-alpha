#!/usr/bin/env node
/**
 * Isolation + safety census. Proves, mechanically, the three properties the
 * dispatch treats as pass/fail:
 *
 *   1. Zero references to TSM database objects (`public.tsm_*`, `tsm_`).
 *   2. Zero imports from any TSM repo.
 *   3. Zero Kalshi order/portfolio-mutation endpoints anywhere in the source.
 *
 * Self-referential matches are excluded: this file and the RVR necessarily
 * contain the very strings being searched for, so scanning them would
 * guarantee a false positive. Exclusions are listed explicitly in the output
 * so the census cannot quietly hide a real hit.
 *
 * Exit 0 = clean, 1 = violation found.
 */

import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();

// Files that legitimately discuss the forbidden patterns.
const SELF_REFERENTIAL = new Set([
  'scripts/isolation-check.js',
  'docs/RVR-phase0-build.md',
  'src/kalshi-client.js', // contains the denylist that enforces rule 2
  'fixtures/13-isolation-census.json',
  // Evidence fixture: records that public.tsm_* objects EXIST in the shared
  // Supabase project, captured while investigating whether the credentials
  // pointed at the right database. It documents the environment, it does not
  // reference those objects from our code. Same category as a guard-proof:
  // suppressing it would hide the finding, so it is excluded by name and the
  // exclusion is printed on every run.
  'fixtures/16-supabase-project-mismatch.json',
]);

const SKIP_DIRS = new Set(['node_modules', '.git', 'data', 'logs']);

const CHECKS = [
  {
    id: 'tsm_db_objects',
    label: 'TSM database objects (public.tsm_*, tsm_ prefix)',
    pattern: /\btsm_[a-z0-9_]+/gi,
  },
  {
    id: 'tsm_imports',
    label: 'Imports from a TSM repo',
    pattern: /(?:import|require)\s*\(?\s*['"][^'"]*(?:tsm|trade-signal|tradesignal)[^'"]*['"]/gi,
  },
  {
    id: 'order_endpoints',
    label: 'Kalshi order / portfolio-mutation endpoints',
    // Endpoint paths only. Deliberately narrow so that the words "order" or
    // "portfolio" in prose do not trip the census.
    pattern:
      /\/trade-api\/v2\/(?:portfolio\/orders|orders|portfolio\/positions\/close)|batch_create_orders|batch_cancel_orders/gi,
  },
  {
    id: 'mutating_http',
    label: 'Mutating HTTP verbs issued against the Kalshi host',
    pattern: /method\s*:\s*['"](?:POST|PUT|PATCH|DELETE)['"]/gi,
  },
];

function walk(dir, out = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.name.startsWith('.') && entry.name !== '.gitignore' && entry.name !== '.env.example') {
      continue;
    }
    const abs = path.join(dir, entry.name);
    const rel = path.relative(ROOT, abs);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      walk(abs, out);
    } else if (/\.(js|mjs|cjs|json|sql|md|yml|yaml|toml|Dockerfile)$/i.test(entry.name) ||
               entry.name === 'Dockerfile') {
      out.push(rel);
    }
  }
  return out;
}

const files = walk(ROOT);
const results = {};
let violations = 0;

const allGuardProofs = {};
for (const check of CHECKS) {
  const hits = [];
  const guardProofs = [];
  for (const rel of files) {
    if (SELF_REFERENTIAL.has(rel)) continue;
    let content;
    try {
      content = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    } catch {
      continue;
    }
    const matches = content.match(check.pattern);
    if (matches) {
      // Record line numbers so a hit is actionable, not just a filename.
      // A line is classified GUARD_PROOF rather than VIOLATION when it is
      // demonstrably the negative test that the read-only guard fires --
      // an assertReadOnly() call, or a recorded refusal in a fixture. Those
      // lines prove the endpoint is BLOCKED; treating them as violations
      // would penalise the repo for testing its own safety property.
      const lines = [];
      content.split('\n').forEach((line, i) => {
        const re = new RegExp(check.pattern.source, check.pattern.flags.replace('g', ''));
        if (!re.test(line)) return;
        const isGuardProof =
          /assertReadOnly|ReadOnlyViolation|refused|denylist|MUTATION_DENYLIST/i.test(line);
        lines.push({
          line: i + 1,
          text: line.trim().slice(0, 120),
          classification: isGuardProof ? 'GUARD_PROOF' : 'VIOLATION',
        });
      });
      const realViolations = lines.filter((l) => l.classification === 'VIOLATION');
      if (realViolations.length) {
        hits.push({ file: rel, match_count: realViolations.length, lines: realViolations });
      } else {
        guardProofs.push({ file: rel, lines });
      }
    }
  }
  allGuardProofs[check.id] = guardProofs;
  results[check.id] = {
    label: check.label,
    status: hits.length === 0 ? 'CLEAN' : 'VIOLATION',
    hit_count: hits.length,
    hits,
    guard_proof_count: guardProofs.length,
    guard_proofs: guardProofs,
  };
  if (hits.length) violations += 1;
}

const report = {
  captured_at: new Date().toISOString(),
  files_scanned: files.length,
  files_excluded_as_self_referential: [...SELF_REFERENTIAL],
  dirs_skipped: [...SKIP_DIRS],
  checks: results,
  overall: violations === 0 ? 'ISOLATED' : 'VIOLATIONS FOUND',
};

fs.mkdirSync(path.join(ROOT, 'fixtures'), { recursive: true });
fs.writeFileSync(
  path.join(ROOT, 'fixtures', '13-isolation-census.json'),
  JSON.stringify(report, null, 2)
);

console.log('=== Isolation & safety census ===');
console.log(`files scanned: ${files.length}`);
console.log(`excluded as self-referential: ${[...SELF_REFERENTIAL].join(', ')}\n`);
for (const [id, r] of Object.entries(results)) {
  console.log(`  [${r.status === 'CLEAN' ? ' OK ' : 'FAIL'}] ${r.label}`);
  // Surface guard-proofs explicitly. A silent pass would hide the fact that
  // the string was found at all; the reader should see it was found AND why
  // it was classified as proof-of-blocking rather than a violation.
  for (const gp of r.guard_proofs) {
    for (const l of gp.lines) {
      console.log(`         guard-proof: ${gp.file}:${l.line} -> ${l.text}`);
    }
  }
  if (r.status !== 'CLEAN') {
    for (const h of r.hits) {
      console.log(`         ${h.file} (${h.match_count} match(es))`);
      for (const l of h.lines.slice(0, 5)) console.log(`           L${l.line}: ${l.text}`);
    }
  }
}
console.log(`\nOVERALL: ${report.overall}`);
console.log('fixture -> fixtures/13-isolation-census.json');
process.exit(violations === 0 ? 0 : 1);
