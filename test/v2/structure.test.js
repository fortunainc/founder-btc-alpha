import test from 'node:test';
import assert from 'node:assert/strict';
import { BarBuilder } from '../../src/v2/bars.js';
import { f2Structure } from '../../src/v2/structure.js';

const T0 = 1_700_000_000_000;
// Feed one tick per 20s boundary so bars.closes(20s) returns exactly `vals`.
function seed(vals) {
  const b = new BarBuilder();
  for (let i = 0; i < vals.length; i += 1) b.add(T0 + i * 20_000, vals[i]);
  return { bars: b, now: T0 + (vals.length - 1) * 20_000 };
}
// clear HH/HL zigzag ending on a new high (up-trend + up-break)
const UP = [100,101,102,103, 102,101,100.5, 101.5,102.5,104, 103,102,101.5, 102.5,103.5,105];
const DOWN = UP.map((v) => 200 - v); // mirror → LH/LL + down-break

test('F2: uptrend structure (HH/HL) votes YES and flags an up-break', () => {
  const { bars, now } = seed(UP);
  const r = f2Structure({ bars, now });
  assert.equal(r.side, 'yes');
  assert.equal(r.trend, true);
  assert.ok(r.strength > 0);
  assert.ok(r.breakout && r.breakout.side === 'yes');
});

test('F2: downtrend structure (LH/LL) votes NO and flags a down-break', () => {
  const { bars, now } = seed(DOWN);
  const r = f2Structure({ bars, now });
  assert.equal(r.side, 'no');
  assert.equal(r.trend, true);
  assert.ok(r.breakout && r.breakout.side === 'no');
});

test('F2: insufficient history → flat, zero strength', () => {
  const { bars, now } = seed([100, 100, 100]);
  const r = f2Structure({ bars, now });
  assert.equal(r.side, 'flat');
  assert.equal(r.strength, 0);
  assert.equal(r.trend, false);
});

test('F2: emits the arbiter evidence shape', () => {
  const { bars, now } = seed(UP);
  const r = f2Structure({ bars, now });
  assert.equal(r.key, 'F2_structure');
  assert.ok(['yes', 'no', 'flat'].includes(r.side));
  assert.equal(typeof r.strength, 'number');
});
