#!/usr/bin/env node
/**
 * Build data/macro-calendar.json for the next N days.
 *
 * CONFIDENCE IS RECORDED PER EVENT AND MUST BE RESPECTED:
 *
 *   confidence: "rule_derived"
 *     NFP / Employment Situation. BLS releases it on the FIRST FRIDAY of the
 *     month at 08:30 ET. That rule is stable and computed exactly here, so the
 *     date is trustworthy. (Rare holiday shifts are possible.)
 *
 *   confidence: "estimated"
 *     CPI and FOMC. CPI lands mid-month but the exact day varies by release
 *     schedule; FOMC dates are set by the Board and follow no arithmetic rule.
 *     These are PLACEHOLDERS positioned on the typical day and MUST be
 *     replaced with the official published dates before any regime analysis
 *     depends on them.
 *
 * Nothing downstream should treat an "estimated" event as fact. The macro flag
 * derived from it is itself flagged in the capture row.
 */

import fs from 'node:fs';
import path from 'node:path';

const DAYS = Number(process.argv[2] || 60);
const START = process.argv[3] ? new Date(process.argv[3]) : new Date();

/** Build a UTC instant from an ET wall-clock time, DST-correct. */
function etToUtc(year, month, day, hourET, minuteET) {
  // Probe UTC offset for that date by formatting a noon-UTC instant in ET.
  const probe = new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    timeZoneName: 'shortOffset',
  });
  const tzName = fmt.formatToParts(probe).find((p) => p.type === 'timeZoneName')?.value || 'GMT-5';
  const m = tzName.match(/GMT([+-]\d+)/);
  const offsetHours = m ? Number(m[1]) : -5;
  return new Date(Date.UTC(year, month - 1, day, hourET - offsetHours, minuteET, 0));
}

function firstFriday(year, month) {
  for (let d = 1; d <= 7; d += 1) {
    const dt = new Date(Date.UTC(year, month - 1, d));
    if (dt.getUTCDay() === 5) return d;
  }
  return null;
}

const end = new Date(START.getTime() + DAYS * 86400000);
const events = [];

// Walk each month touched by the window.
const cursor = new Date(Date.UTC(START.getUTCFullYear(), START.getUTCMonth(), 1));
while (cursor <= end) {
  const y = cursor.getUTCFullYear();
  const mo = cursor.getUTCMonth() + 1;

  // --- NFP: first Friday, 08:30 ET. Rule-derived, trustworthy. ---
  const ff = firstFriday(y, mo);
  if (ff) {
    const ts = etToUtc(y, mo, ff, 8, 30);
    if (ts >= START && ts <= end) {
      events.push({
        kind: 'NFP',
        label: 'Employment Situation (Nonfarm Payrolls)',
        ts_utc: ts.toISOString(),
        et_time: '08:30',
        confidence: 'rule_derived',
        rule: 'BLS releases on the first Friday of the month at 08:30 ET',
      });
    }
  }

  // --- CPI: mid-month, 08:30 ET. ESTIMATED placeholder. ---
  // Snap off weekends: BLS never releases on a Saturday or Sunday, so a naive
  // "always the 12th" placeholder would put the flag on an impossible day.
  let cpiDay = 12;
  for (let i = 0; i < 4; i += 1) {
    const dow = new Date(Date.UTC(y, mo - 1, cpiDay)).getUTCDay();
    if (dow !== 0 && dow !== 6) break;
    cpiDay += 1;
  }
  const cpiTs = etToUtc(y, mo, cpiDay, 8, 30);
  if (cpiTs >= START && cpiTs <= end) {
    events.push({
      kind: 'CPI',
      label: 'Consumer Price Index',
      ts_utc: cpiTs.toISOString(),
      et_time: '08:30',
      confidence: 'estimated',
      rule: 'PLACEHOLDER on the 12th. CPI lands mid-month but the exact day varies. REPLACE with the official BLS date.',
    });
  }

  cursor.setUTCMonth(cursor.getUTCMonth() + 1);
}

// --- FOMC: no arithmetic rule exists. Explicit placeholders. ---
// These are positioned on historically typical meeting weeks and are NOT
// authoritative. Replace from federalreserve.gov before relying on them.
const FOMC_ESTIMATES = ['2026-07-29', '2026-09-16'];
for (const d of FOMC_ESTIMATES) {
  const [yy, mm, dd] = d.split('-').map(Number);
  const ts = etToUtc(yy, mm, dd, 14, 0);
  if (ts >= START && ts <= end) {
    events.push({
      kind: 'FOMC',
      label: 'FOMC rate decision',
      ts_utc: ts.toISOString(),
      et_time: '14:00',
      confidence: 'estimated',
      rule: 'PLACEHOLDER. FOMC dates follow no arithmetic rule. REPLACE with the official Federal Reserve calendar.',
    });
  }
}

events.sort((a, b) => a.ts_utc.localeCompare(b.ts_utc));

const out = {
  generated_at: new Date().toISOString(),
  window_start: START.toISOString(),
  window_end: end.toISOString(),
  window_days: DAYS,
  flag_window: { before_minutes: 30, after_minutes: 90 },
  confidence_legend: {
    rule_derived: 'Computed from a stable published rule. Trustworthy.',
    estimated: 'PLACEHOLDER. Must be replaced with the official published date before use in analysis.',
  },
  counts: {
    total: events.length,
    rule_derived: events.filter((e) => e.confidence === 'rule_derived').length,
    estimated: events.filter((e) => e.confidence === 'estimated').length,
  },
  events,
};

const file = path.resolve(process.cwd(), 'data', 'macro-calendar.json');
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(out, null, 2));

console.log(`Wrote ${file}`);
console.log(`  window: ${out.window_start.slice(0, 10)} .. ${out.window_end.slice(0, 10)} (${DAYS}d)`);
console.log(`  events: ${out.counts.total} (rule_derived=${out.counts.rule_derived}, estimated=${out.counts.estimated})`);
for (const e of events) {
  console.log(`    ${e.ts_utc}  ${e.kind.padEnd(5)} ${e.confidence}`);
}
