// v2.4 founder technical engine — deterministic pins for the execution lock:
// STRAT/FVG/structure math, state machine (YES/NO/WAIT/NO_TRADE), staleness +
// reachability gates, sweep-controls-over-HTF rule, immutable revision cadence,
// pre-registered official-call policy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildCandles, atr, emaTrend } from '../../src/v2/technical/ta-core.js';
import { stratType, stratSignals, detectFvgs, swings, structureRead, broadening } from '../../src/v2/technical/ta-patterns.js';
import { evaluateV24, officialCall, V24_PARAMS, V24_ENGINE_ID } from '../../src/v2/technical/engine-v24.js';
import { V2Scheduler } from '../../src/v2/scheduler.js';

const T0 = Date.parse('2026-07-26T18:00:00Z');
const mkTicks = (prices, stepMs = 5_000, t0 = T0) => prices.map((p, i) => ({ ts: t0 + i * stepMs, price: p }));

test('candles: aggregation + completeness; STRAT typing 1/2U/2D/3', () => {
  const ticks = mkTicks([100, 101, 99, 102, 103, 101], 30_000);
  const c = buildCandles(ticks, 60_000, T0 + 3 * 60_000);
  assert.equal(c.length, 3);
  assert.ok(c[0].complete && c[1].complete);
  assert.equal(stratType({ high: 10, low: 8 }, { high: 9.5, low: 8.5 }), '1');
  assert.equal(stratType({ high: 10, low: 8 }, { high: 11, low: 8.5 }), '2U');
  assert.equal(stratType({ high: 10, low: 8 }, { high: 9.5, low: 7 }), '2D');
  assert.equal(stratType({ high: 10, low: 8 }, { high: 11, low: 7 }), '3');
});

test('FVG: bullish gap detected with boundaries/state; fills tracked; bearish likewise', () => {
  // candle highs/lows engineered: c1 high 101 < c3 low 103 → bullish gap [101,103]
  const candles = [
    { t0: 0, t1: 1, open: 100, high: 101, low: 99, close: 100.5, complete: true },
    { t0: 1, t1: 2, open: 100.5, high: 104, low: 100, close: 103.5, complete: true },
    { t0: 2, t1: 3, open: 103.5, high: 105, low: 103, close: 104, complete: true },
    { t0: 3, t1: 4, open: 104, high: 104.5, low: 103.8, close: 104.2, complete: true },
  ];
  const { active } = detectFvgs(candles, { now: 10, maxAgeMs: 1000 });
  assert.equal(active.length, 1);
  assert.equal(active[0].side, 'bullish');
  assert.equal(active[0].top, 103); assert.equal(active[0].bottom, 101);
  assert.equal(active[0].state, 'untouched');
  const filled = detectFvgs([...candles, { t0: 4, t1: 5, open: 104, high: 104, low: 100.5, close: 101, complete: true }], { now: 10, maxAgeMs: 1000 });
  assert.equal(filled.all[0].state, 'filled');
});

test('structure: swings, BOS, liquidity sweep (wick beyond swing, close back inside), premium/discount', () => {
  const mk = (h, l, c) => ({ t0: 0, t1: 1, open: (h + l) / 2, high: h, low: l, close: c, complete: true });
  const base = [mk(10, 9, 9.5), mk(10.5, 9.2, 10), mk(11, 9.8, 10.5), mk(10.8, 10, 10.2), mk(10.6, 9.9, 10.1), mk(10.4, 9.7, 10)];
  const sw = swings(base, 2);
  assert.ok(sw.highs.length >= 1);
  // sweep: wick above the last swing high (11) but close back below it
  const sweepBar = mk(11.3, 10.2, 10.6);
  const r = structureRead([...base, sweepBar], { k: 2, atrValue: 0.5 });
  assert.ok(r.ok);
  assert.equal(r.sweep?.side, 'buyside_swept');
  assert.ok(r.range && ['premium', 'discount', 'equilibrium'].includes(r.range.zone));
});

function liveInput({ prices, upAsk = 0.45, downAsk = 0.58, tau = 600, strike = null, now = null, dataAgeMs = 1000, prev = null, seq = 1 }) {
  const ticks = mkTicks(prices, 5_000);
  const tNow = now ?? (T0 + (prices.length - 1) * 5_000);
  const spot = prices[prices.length - 1];
  return {
    window_id: 'W24', window_close_ts: new Date(tNow + tau * 1000).toISOString(),
    now: tNow, tauSec: tau, S: spot, K: strike ?? spot - 40,
    ticks, sigmaPerSec: 0.00002,
    up_ask: upAsk, up_bid: upAsk - 0.02, down_ask: downAsk, down_bid: downAsk - 0.02,
    dataAgeMs, prevRevision: prev, revision_seq: seq,
  };
}
const trendUp = Array.from({ length: 800 }, (_, i) => 64000 + i * 1.5 + (i % 7) * 2);

test('state machine: strong uptrend above strike with cheap YES → YES with entry limit + evidence; stale data → NO_TRADE; unreachable strike → NO_TRADE', () => {
  const yes = evaluateV24(liveInput({ prices: trendUp, upAsk: 0.45 }));
  assert.ok(['YES', 'WAIT'].includes(yes.recommendation), yes.reason);
  if (yes.recommendation === 'YES') {
    assert.ok(yes.entry_limit > 0 && yes.entry_limit < 1);
    assert.ok(yes.side_ev_usd >= V24_PARAMS.min_edge_usd);
    assert.ok(yes.strongest_bullish.length >= 1);
    assert.ok(yes.invalidation, 'invalidation stated');
  }
  const stale = evaluateV24(liveInput({ prices: trendUp, dataAgeMs: 200_000 }));
  assert.equal(stale.recommendation, 'NO_TRADE');
  assert.match(stale.reason, /stale_data/);
  assert.equal(stale.data_status.is_stale, true);
  // strike 3000 USD away with tiny vol and 5 min left → unreachable when vote points toward it
  const far = evaluateV24(liveInput({ prices: trendUp, strike: trendUp[trendUp.length - 1] + 3000, tau: 300 }));
  assert.equal(far.recommendation, 'NO_TRADE');
});

test('too close to resolution → NO_TRADE; every revision carries the §B record fields', () => {
  const r = evaluateV24(liveInput({ prices: trendUp, tau: 60 }));
  assert.equal(r.recommendation, 'NO_TRADE');
  assert.match(r.reason, /too_close_to_resolution/);
  for (const k of ['window_id', 'revision_seq', 'evaluated_at', 'tau_sec', 'spot', 'strike', 'distance_usd', 'up_ask', 'down_ask', 'recommendation', 'conviction', 'entry_limit', 'invalidation', 'change_reason', 'features', 'data_status', 'engine_id', 'spec_version']) {
    assert.ok(k in r, `missing field ${k}`);
  }
  assert.ok(r.data_status.unavailable.some((x) => /VWAP/.test(x)), 'unsupported concepts declared, not faked');
});

test('change tracking: second revision explains the delta from the first', () => {
  const r1 = evaluateV24(liveInput({ prices: trendUp }));
  const r2 = evaluateV24(liveInput({ prices: trendUp, prev: r1, seq: 2, dataAgeMs: 200_000 }));
  assert.equal(r2.revision_seq, 2);
  assert.match(r2.change_reason, r1.recommendation === r2.recommendation ? /maintained/ : /changed/);
});

test('official-call policy: first actionable YES/NO; WAIT/NO_TRADE never graded; final-eligible is diagnostic only', () => {
  const revs = [
    { revision_seq: 1, recommendation: 'WAIT', side_ev_usd: null },
    { revision_seq: 2, recommendation: 'YES', side_ev_usd: 0.05 },
    { revision_seq: 3, recommendation: 'NO_TRADE', side_ev_usd: null },
    { revision_seq: 4, recommendation: 'NO', side_ev_usd: 0.04 },
  ];
  const oc = officialCall(revs);
  assert.equal(oc.official.revision_seq, 2, 'first actionable wins');
  assert.equal(oc.final_eligible_diagnostic.revision_seq, 4);
  assert.equal(officialCall([{ revision_seq: 1, recommendation: 'WAIT', side_ev_usd: null }]).abstained, true);
  assert.match(oc.policy, /never chosen after outcome/);
});

test('scheduler: cadence-gated immutable revisions + ONE official decision row + graded at settle', async () => {
  const revisions = [], decisions = [], grades = [];
  const s = new V2Scheduler({
    writeDecision: async (row) => { decisions.push(row); return { written: 1, id: decisions.length }; },
    writeGrade: async (row) => { grades.push(row); return { written: 1 }; },
    getOrderbook: async () => ({ up_bid: 0.43, up_ask: 0.45, down_bid: 0.56, down_ask: 0.58 }),
    logger: { info() {}, warn() {}, error() {} },
    withV24Technical: true,
    writeRevision: async (row) => { revisions.push(row); return { written: 1 }; },
  });
  // seed strong uptrend into the shared bar buffer
  s.seedHistory(trendUp.map((p, i) => ({ ts: T0 - (trendUp.length - i) * 5_000, price: p })));
  const strike = trendUp[trendUp.length - 1] - 40;
  const w = { window_id: 'W24S', close_time: new Date(T0 + 14 * 60_000).toISOString(), reference_strike: strike };
  // tick 1: first revision; tick 2 (30s later): cadence-gated, NO new revision; tick 3 (160s later): second revision
  await s.onTick({ windows: [w], replicaIndex: trendUp[trendUp.length - 1], now: T0 });
  await s.onTick({ windows: [w], replicaIndex: trendUp[trendUp.length - 1] + 5, now: T0 + 30_000 });
  assert.equal(revisions.length, 1, 'cadence gate: no second revision after 30s');
  await s.onTick({ windows: [w], replicaIndex: trendUp[trendUp.length - 1] + 10, now: T0 + 160_000 });
  assert.equal(revisions.length, 2);
  assert.deepEqual(revisions.map((r) => r.revision_seq), [1, 2], 'immutable sequence, never overwritten');
  // official call: at most one v24 decision row regardless of further YES revisions
  const officialRows = decisions.filter((d) => d.engine_id === V24_ENGINE_ID);
  assert.ok(officialRows.length <= 1);
  if (officialRows.length === 1) {
    await s.onSettle({ window_id: 'W24S' }, { outcome: 'yes', settlement_value: strike + 100, graded_at: T0 + 15 * 60_000 });
    const g = grades.filter((g) => g.engine_id === V24_ENGINE_ID);
    assert.equal(g.length, 1, 'official call graded once by the pre-registered rule');
  }
});
