/**
 * Session bucketing and macro-event flagging.
 *
 * Buckets are derived from US Eastern wall-clock time, because the macro
 * calendar that drives BTC intraday regime (CPI/FOMC/NFP releases) is
 * scheduled in ET. Weekend takes precedence over every intraday bucket.
 *
 * Bucket definitions (ET):
 *   weekend    Saturday or Sunday
 *   us_rth     09:30 - 16:00   US regular trading hours
 *   eu         03:00 - 09:30   European session
 *   asia       19:00 - 03:00   Asian session (wraps midnight)
 *   overnight  everything else (16:00 - 19:00 US post-close lull)
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Extract ET wall-clock parts for an instant, DST-correct. */
export function easternParts(date) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: 'America/New_York',
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const parts = Object.fromEntries(
    fmt.formatToParts(date).map((p) => [p.type, p.value])
  );
  let hour = Number(parts.hour);
  // Intl can emit "24" for midnight in some ICU versions.
  if (hour === 24) hour = 0;
  return {
    weekday: parts.weekday,
    hour,
    minute: Number(parts.minute),
    date: `${parts.year}-${parts.month}-${parts.day}`,
    minutesOfDay: hour * 60 + Number(parts.minute),
  };
}

export function sessionBucket(date = new Date()) {
  const { weekday, minutesOfDay } = easternParts(date);
  if (weekday === 'Sat' || weekday === 'Sun') return 'weekend';

  const RTH_OPEN = 9 * 60 + 30; // 09:30
  const RTH_CLOSE = 16 * 60; // 16:00
  const EU_OPEN = 3 * 60; // 03:00
  const ASIA_OPEN = 19 * 60; // 19:00

  if (minutesOfDay >= RTH_OPEN && minutesOfDay < RTH_CLOSE) return 'us_rth';
  if (minutesOfDay >= EU_OPEN && minutesOfDay < RTH_OPEN) return 'eu';
  if (minutesOfDay >= ASIA_OPEN || minutesOfDay < EU_OPEN) return 'asia';
  return 'overnight';
}

/**
 * Load the static macro calendar. Kept as a checked-in data file rather than a
 * live feed so that a capture is reproducible: the flag a row carried at write
 * time can always be re-derived from the repo at that commit.
 */
export function loadMacroCalendar(file) {
  const f = file || path.resolve(__dirname, '..', 'data', 'macro-calendar.json');
  if (!fs.existsSync(f)) return { events: [], loaded: false, path: f };
  try {
    const parsed = JSON.parse(fs.readFileSync(f, 'utf8'));
    return { events: parsed.events || [], loaded: true, path: f, generated_at: parsed.generated_at };
  } catch {
    return { events: [], loaded: false, path: f };
  }
}

/**
 * Is `date` inside the blast radius of a scheduled macro release?
 * Default window: 30 min before to 90 min after, which covers the pre-print
 * positioning drift and the post-print repricing.
 */
export function macroFlag(date, calendar, { beforeMin = 30, afterMin = 90 } = {}) {
  const t = date.getTime();
  const hits = [];
  for (const ev of calendar.events || []) {
    const evTime = new Date(ev.ts_utc).getTime();
    if (!Number.isFinite(evTime)) continue;
    if (t >= evTime - beforeMin * 60_000 && t <= evTime + afterMin * 60_000) {
      hits.push(`${ev.kind}:${ev.ts_utc}`);
    }
  }
  return { flag: hits.length > 0, events: hits };
}
