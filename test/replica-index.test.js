import test from 'node:test';
import assert from 'node:assert/strict';
import { computeIndex, median, TrailingWindow } from '../src/replica-index.js';

const NOW = 1_700_000_000_000;
const q = (bid, ask, bidSize = 1, askSize = 1, ageMs = 0) => ({
  bid,
  ask,
  bidSize,
  askSize,
  ts: NOW - ageMs,
});

test('median handles odd and even counts', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 2, 3]), 2.5);
  assert.equal(median([]), null);
});

test('index sits between the venue mids', () => {
  // Keep mids within 50bps of each other. At a price near 100 that is only
  // ~$0.50, so venues quoting a dollar apart would all be outlier-rejected.
  const r = computeIndex(
    { a: q(100.0, 100.2), b: q(100.1, 100.3), c: q(100.2, 100.4) },
    NOW
  );
  assert.equal(r.venue_count, 3);
  assert.ok(r.index >= 100.1 && r.index <= 100.3, `got ${r.index}`);
});

test('tighter spreads receive more weight', () => {
  // tight: 0.1-wide market, mid 100.05. wide: 1.0-wide market, mid 100.50.
  // Mids are ~45bps apart, inside the outlier bound, so both survive and the
  // spread term is what actually decides the result.
  const r = computeIndex({ tight: q(100, 100.1), wide: q(100, 101) }, NOW);
  assert.equal(r.venue_count, 2, 'both venues must survive outlier rejection');
  assert.ok(r.weight_share.tight > r.weight_share.wide);
  // Result must sit nearer the tight venue's mid than the wide one's.
  assert.ok(
    Math.abs(r.index - 100.05) < Math.abs(r.index - 100.5),
    `expected pull toward tight venue, got ${r.index}`
  );
});

test('deeper books receive more weight at equal spread', () => {
  // Mids must stay within the 50bps outlier bound, otherwise both venues are
  // rejected and there is no weighting left to assert on.
  const r = computeIndex(
    { deep: q(100, 101, 1000, 1000), thin: q(100.2, 101.2, 1, 1) },
    NOW
  );
  assert.equal(r.venue_count, 2, 'both venues must survive outlier rejection');
  assert.ok(r.weight_share.deep > r.weight_share.thin);
  assert.ok(r.index < 100.7, `deep venue should dominate, got ${r.index}`);
});

test('with only two venues, outlier rejection drops BOTH or NEITHER', () => {
  // Both are equidistant from a 2-point median, so a genuine dislocation
  // cannot be arbitrated -- the index must go null rather than pick a side.
  const r = computeIndex({ a: q(100, 100.1), b: q(110, 110.1) }, NOW);
  assert.equal(r.index, null);
  assert.match(r.reason, /outlier rejection/);
});

test('stale venues are excluded', () => {
  const r = computeIndex(
    { fresh1: q(100, 101), fresh2: q(100, 101), old: q(200, 201, 1, 1, 20_000) },
    NOW
  );
  assert.equal(r.venues_excluded.old, 'stale');
  assert.ok(!r.venues_used.includes('old'));
  assert.ok(r.index > 99 && r.index < 102, 'stale outlier must not drag the index');
});

test('crossed and locked books are excluded', () => {
  const r = computeIndex(
    { good1: q(100, 101), good2: q(100, 101), crossed: q(105, 104), locked: q(100, 100) },
    NOW
  );
  assert.equal(r.venues_excluded.crossed, 'crossed_or_locked');
  assert.equal(r.venues_excluded.locked, 'crossed_or_locked');
});

test('outliers beyond 50bps of the median are rejected', () => {
  // 100 vs 100 vs 110 -> the 110 venue is ~1000bps out.
  const r = computeIndex({ a: q(100, 100.1), b: q(100, 100.1), rogue: q(110, 110.1) }, NOW);
  assert.ok(String(r.venues_excluded.rogue).startsWith('outlier_'));
  assert.ok(r.index < 101);
});

test('a venue just inside the 50bps bound is kept', () => {
  // 0.3% away from the median -> 30bps, inside the bound.
  const r = computeIndex({ a: q(100, 100), b: q(100, 100.2), c: q(100.3, 100.4) }, NOW);
  assert.ok(!('c' in r.venues_excluded) || !String(r.venues_excluded.c).startsWith('outlier'));
});

test('fewer than two usable venues yields null, never a guess', () => {
  const r = computeIndex({ only: q(100, 101) }, NOW);
  assert.equal(r.index, null);
  assert.match(r.reason, /minimum/);
});

test('empty quote set yields null', () => {
  const r = computeIndex({}, NOW);
  assert.equal(r.index, null);
});

test('weight shares sum to 1', () => {
  const r = computeIndex({ a: q(100, 101), b: q(100.5, 101.5), c: q(100.2, 101.2) }, NOW);
  const total = Object.values(r.weight_share).reduce((x, y) => x + y, 0);
  assert.ok(Math.abs(total - 1) < 1e-5, `weights sum to ${total}`);
});

// --- TrailingWindow ---------------------------------------------------

test('trailing average covers only the requested window', () => {
  const w = new TrailingWindow(3600);
  for (let i = 0; i < 120; i += 1) w.push(NOW - (120 - i) * 1000, 100 + i);
  const { avg, n } = w.average(60, NOW);
  // Start bound is exclusive (ts > start), so a print landing exactly on the
  // boundary belongs to the previous window and is not double-counted.
  assert.equal(n, 59);
  // Last 60 prints are values 61..120 -> mean 90.5 offset by the +100 base.
  assert.ok(avg > 160 && avg < 221, `got ${avg}`);
});

test('null and non-finite prints are never stored', () => {
  const w = new TrailingWindow(60);
  w.push(NOW, null);
  w.push(NOW, NaN);
  w.push(NOW, Infinity);
  assert.equal(w.size, 0);
  assert.deepEqual(w.average(60, NOW), { avg: null, n: 0 });
});

test('realizedVol returns null when the sample is too small', () => {
  const w = new TrailingWindow(3600);
  for (let i = 0; i < 5; i += 1) w.push(NOW - i * 1000, 100);
  assert.equal(w.realizedVol(1, NOW), null);
});

test('realizedVol returns null when the buffer does not SPAN the window', () => {
  // 5 minutes of dense data must not be reported as a 15-minute vol.
  const w = new TrailingWindow(3600);
  for (let i = 0; i < 300; i += 1) w.push(NOW - (300 - i) * 1000, 100 + Math.sin(i) * 0.5);
  assert.ok(w.realizedVol(1, NOW) !== null, '1m is fully covered');
  assert.ok(w.realizedVol(5, NOW) !== null, '5m is fully covered');
  assert.equal(w.realizedVol(15, NOW), null, '15m must be null with only 5m of buffer');
});

test('realizedVol is zero for a flat series and positive for a moving one', () => {
  const flat = new TrailingWindow(3600);
  for (let i = 0; i < 90; i += 1) flat.push(NOW - (90 - i) * 1000, 100);
  assert.equal(Number(flat.realizedVol(1, NOW)), 0);

  const moving = new TrailingWindow(3600);
  for (let i = 0; i < 90; i += 1) moving.push(NOW - (90 - i) * 1000, 100 + (i % 2 ? 0.5 : 0));
  assert.ok(Number(moving.realizedVol(1, NOW)) > 0);
});

test('window evicts prints older than its capacity', () => {
  const w = new TrailingWindow(10);
  for (let i = 0; i < 60; i += 1) w.push(NOW - (60 - i) * 1000, 100);
  assert.ok(w.size <= 12, `expected eviction, size=${w.size}`);
});
