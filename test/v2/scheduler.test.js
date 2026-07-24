import test from 'node:test';
import assert from 'node:assert/strict';
import { V2Scheduler, SEAL_TAU_SEC } from '../../src/v2/scheduler.js';
import { gradeDecision } from '../../src/v2/engine.js';

const T0 = 1_700_000_000_000;
const BOOK = { up_bid: 0.30, up_ask: 0.34, down_bid: 0.64, down_ask: 0.68 };

// Deterministic fakes + capture.
function makeSched(opts = {}) {
  const decisions = [], grades = [];
  let idSeq = 0;
  const obImpl = opts.getOrderbook || (async () => ({ ...BOOK }));
  const s = new V2Scheduler({
    writeDecision: async (row) => { decisions.push(row); return { written: 1, id: ++idSeq }; },
    writeGrade: async (row) => { grades.push(row); return { written: 1 }; },
    getOrderbook: obImpl,
    logger: { info(){}, warn(){}, error(){} },
    ...opts,
  });
  return { s, decisions, grades };
}

// Feed >=16 min of warm history ending at `now` (flat is fine — orchestration tests
// don't depend on the recommendation, only that a well-formed decision is sealed).
function warm(s, now, price = 65088, minutes = 16, stepSec = 10) {
  const n = Math.round((minutes * 60) / stepSec);
  const start = now - n * stepSec * 1000;
  for (let i = 0; i <= n; i += 1) s.ingestTick(start + i * stepSec * 1000, price);
}
const win = (now, stc, strike = 65135) => ({ window_id: 'KXBTC15M-W1', close_time: new Date(now + stc * 1000).toISOString(), reference_strike: strike });

test('no seal before minute 3 (secondsToClose > τ)', async () => {
  const { s, decisions } = makeSched();
  const now = T0; warm(s, now);
  await s.onTick({ windows: [win(now, SEAL_TAU_SEC + 80)], replicaIndex: 65088, now });
  assert.equal(decisions.length, 0);
});

test('seals exactly once at ~minute 3 and never re-seals; row is well-formed', async () => {
  const { s, decisions } = makeSched();
  let now = T0; warm(s, now);
  await s.onTick({ windows: [win(now, SEAL_TAU_SEC)], replicaIndex: 65088, now });
  assert.equal(decisions.length, 1, 'one seal at τ');
  const d = decisions[0];
  assert.equal(d.window_id, 'KXBTC15M-W1');
  assert.equal(d.strike, 65135);
  assert.equal(d.replica_index, 65088);        // S = last replica tick
  assert.equal(d.up_ask, 0.34);                // executable prices flow from the book
  assert.equal(d.down_ask, 0.68);
  assert.equal(d.market_p, 0.32);              // (up_bid+up_ask)/2
  assert.equal(d.engine_id, 'btc-alpha-v2-scalp');
  assert.equal(d.spec_version, 'v2.1.0');
  assert.ok(['TAKE_YES', 'TAKE_NO', 'NO_TRADE'].includes(d.recommendation));
  // subsequent ticks (deeper into the window) must NOT re-seal
  now = T0 + 20_000;
  await s.onTick({ windows: [win(T0, SEAL_TAU_SEC - 20)], replicaIndex: 65090, now });
  assert.equal(decisions.length, 1, 'idempotent — still one seal');
});

test('null strike holds the seal (does not burn it) until the strike publishes', async () => {
  const { s, decisions } = makeSched();
  const now = T0; warm(s, now);
  await s.onTick({ windows: [{ ...win(now, SEAL_TAU_SEC), reference_strike: null }], replicaIndex: 65088, now });
  assert.equal(decisions.length, 0, 'no seal while strike is TBD');
  const now2 = now + 15_000;
  await s.onTick({ windows: [{ ...win(now, SEAL_TAU_SEC - 15), reference_strike: 65135 }], replicaIndex: 65088, now: now2 });
  assert.equal(decisions.length, 1, 'seals once the strike appears (still inside the window)');
});

test('window discovered too late (< floor) is MISSED, never sealed', async () => {
  const { s, decisions } = makeSched();
  const now = T0; warm(s, now);
  await s.onTick({ windows: [win(now, 90)], replicaIndex: 65088, now });       // 90s < 120 floor
  assert.equal(decisions.length, 0);
  await s.onTick({ windows: [win(now, 70)], replicaIndex: 65088, now: now + 20_000 });
  assert.equal(decisions.length, 0, 'stays missed — no late seal');
});

test('a transient orderbook failure does NOT burn the seal — it retries next tick', async () => {
  let calls = 0;
  const { s, decisions } = makeSched({
    getOrderbook: async () => { calls += 1; if (calls === 1) throw new Error('HTTP 502'); return { ...BOOK }; },
  });
  const now = T0; warm(s, now);
  await s.onTick({ windows: [win(now, SEAL_TAU_SEC)], replicaIndex: 65088, now });
  assert.equal(decisions.length, 0, 'first attempt failed, seal not burned');
  await s.onTick({ windows: [win(now, SEAL_TAU_SEC - 10)], replicaIndex: 65088, now: now + 10_000 });
  assert.equal(decisions.length, 1, 'retried and sealed');
});

test('onSettle grades the one decision, links decision_id, matches the engine, and is idempotent', async () => {
  const { s, decisions, grades } = makeSched();
  const now = T0; warm(s, now);
  await s.onTick({ windows: [win(now, SEAL_TAU_SEC)], replicaIndex: 65088, now });
  const sealed = decisions[0];
  const settlement = { outcome: 'no', settlement_value: 64900, graded_at: now + 720_000 };
  const r = await s.onSettle({ window_id: 'KXBTC15M-W1' }, settlement);
  assert.equal(grades.length, 1);
  assert.equal(r.graded, 1);
  const g = grades[0];
  assert.equal(g.decision_id, 1, 'FK linked to the returned decision id');
  // grade must equal an independent gradeDecision() of the sealed row
  const expected = gradeDecision(sealed, settlement);
  assert.equal(g.call_correct, expected.call_correct);
  assert.equal(g.net_pnl, expected.net_pnl);
  assert.equal(g.settled_outcome, 'no');
  // idempotent
  const r2 = await s.onSettle({ window_id: 'KXBTC15M-W1' }, settlement);
  assert.equal(r2.graded, 0);
  assert.equal(grades.length, 1);
});

test('settling a window that was never sealed grades nothing (honest no-op)', async () => {
  const { s, grades } = makeSched();
  const r = await s.onSettle({ window_id: 'NEVER-SEALED' }, { outcome: 'yes', graded_at: T0 });
  assert.equal(r.graded, 0);
  assert.equal(grades.length, 0);
});
