import test from 'node:test';
import assert from 'node:assert/strict';
import { BarBuilder } from '../../src/v2/bars.js';
import { sealDecision, gradeDecision, kalshiFee, ENGINE_ID, SPEC_VERSION } from '../../src/v2/engine.js';

const T0 = 1_700_000_000_000;
function warmBars(start, end, minutes = 16, stepSec = 10) {
  const b = new BarBuilder();
  const n = Math.round((minutes * 60) / stepSec);
  for (let i = 0; i <= n; i += 1) b.add(T0 + i * stepSec * 1000, start + (end - start) * (i / n));
  return { bars: b, now: T0 + n * stepSec * 1000 };
}
const lowVol = (S) => 18 / (S * Math.sqrt(720));

test('kalshiFee matches the canonical ceil(0.07*p*(1-p)) model', () => {
  assert.equal(kalshiFee(0.50), 0.02);
  assert.equal(kalshiFee(0.30), 0.02);
  assert.equal(kalshiFee(0.05), 0.01);
  assert.equal(kalshiFee(0), 0);
  assert.equal(kalshiFee(1), 0);
});

test('sealDecision produces one immutable, fully-formed row', () => {
  const { bars, now } = warmBars(65088, 65088);
  const row = sealDecision({
    window_id: 'KXBTC15M-26JUL242100-35', window_close_ts: new Date(now + 720000).toISOString(),
    now, S: 65088, K: 65135, tauSec: 720, bars, sigmaPerSec: lowVol(65088),
    market_p: 0.30, up_ask: 0.34, down_ask: 0.68, up_bid: 0.30, down_bid: 0.64, is_replay: false,
  });
  assert.equal(row.window_id, 'KXBTC15M-26JUL242100-35');
  assert.equal(row.engine_id, ENGINE_ID);
  assert.equal(row.spec_version, SPEC_VERSION);
  assert.equal(row.recommendation, 'TAKE_NO'); // founder example
  assert.match(row.reason, /Recommendation: TAKE NO\./);
  assert.equal(row.strike, 65135);
  assert.ok(row.families.F7_distance_vs_time && row.families.F3_momentum);
  assert.ok(row.half_spread != null);
  assert.equal(row.seconds_to_close_at_seal, 720);
});

test('grade: TAKE NO that settles NO -> win, net after fee', () => {
  const decision = { window_id: 'w', recommendation: 'TAKE_NO', up_ask: 0.34, down_ask: 0.60 };
  const g = gradeDecision(decision, { outcome: 'no', settlement_value: 64900, graded_at: T0 });
  assert.equal(g.call_correct, true);
  assert.equal(g.entry_price, 0.60);
  assert.equal(g.fee, kalshiFee(0.60));
  // payoff 1 - 0.60 - fee
  assert.equal(g.net_pnl, Number((1 - 0.60 - kalshiFee(0.60)).toFixed(4)));
});

test('grade: TAKE YES that settles NO -> loss (negative net)', () => {
  const decision = { window_id: 'w', recommendation: 'TAKE_YES', up_ask: 0.55, down_ask: 0.47 };
  const g = gradeDecision(decision, { outcome: 'no', settlement_value: 64000, graded_at: T0 });
  assert.equal(g.call_correct, false);
  assert.equal(g.entry_price, 0.55);
  assert.ok(g.net_pnl < 0);
  assert.equal(g.net_pnl, Number((0 - 0.55 - kalshiFee(0.55)).toFixed(4)));
});

test('grade: NO_TRADE -> no position (net 0, correct null), outcome recorded', () => {
  const g = gradeDecision({ window_id: 'w', recommendation: 'NO_TRADE' }, { outcome: 'yes', graded_at: T0 });
  assert.equal(g.call_correct, null);
  assert.equal(g.net_pnl, 0);
  assert.equal(g.settled_outcome, 'yes');
});

test('grade: void -> all P&L null', () => {
  const g = gradeDecision({ window_id: 'w', recommendation: 'TAKE_YES', up_ask: 0.5 }, { outcome: 'void' });
  assert.equal(g.call_correct, null);
  assert.equal(g.net_pnl, null);
});

test('grade: unpriceable fill -> correctness only, never a fabricated P&L', () => {
  const g = gradeDecision({ window_id: 'w', recommendation: 'TAKE_YES', up_ask: null }, { outcome: 'yes', graded_at: T0 });
  assert.equal(g.call_correct, true);
  assert.equal(g.net_pnl, null); // no midpoint/fabricated fill
});
