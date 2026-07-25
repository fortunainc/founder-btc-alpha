// BTC-2 fix: boot-time seed eliminates the ~15-min blind window after a redeploy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { BarBuilder } from '../../src/v2/bars.js';

test('BarBuilder.seed makes realized vol warm IMMEDIATELY (no 15-min blind window after restart)', () => {
  const b = new BarBuilder();
  const now = 1_700_000_000_000;
  const points = [];
  for (let i = 20; i >= 1; i--) points.push({ ts: now - i * 60_000, price: 64000 + Math.sin(i) * 40 });
  assert.equal(b.seed(points), 20);
  assert.equal(b.isWarm(15 * 60_000, now), true, 'warm right after seeding 20 min of history');
  assert.ok(b.realizedVolPerSec(10 * 60_000, 30_000, now) > 0, 'realized vol computable immediately after seed');
});

test('BarBuilder.seed must precede live ticks (older points rejected as out-of-order)', () => {
  const b = new BarBuilder();
  const now = 1_700_000_000_000;
  b.add(now, 64000);
  assert.equal(b.seed([{ ts: now - 60_000, price: 63900 }]), 0);
});

test('BarBuilder.seed ignores malformed points, never fabricates', () => {
  const b = new BarBuilder();
  const now = 1_700_000_000_000;
  assert.equal(b.seed([{ ts: now - 1000, price: 0 }, { ts: NaN, price: 64000 }, { ts: now - 2000, price: 64000 }]), 1);
});
