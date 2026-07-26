// AUDIT FIX regression (grade 57, 2026-07-26): grading must price from the STORED
// decision row, not the in-memory object. Reproduces the exact defect: a write-retry
// reseals in memory with a fresher (worse) book while the DB keeps the first seal.
import test from 'node:test';
import assert from 'node:assert/strict';
import { V2Scheduler } from '../../src/v2/scheduler.js';

function mkScheduler({ stored, writes, grades }) {
  return new V2Scheduler({
    writeDecision: async (row) => { writes.push(row); return { written: 1, id: writes.length }; },
    writeGrade: async (row) => { grades.push(row); return { written: 1 }; },
    getOrderbook: async () => { throw new Error('unused'); },
    readDecision: stored ? async (windowId, engineId) => stored[engineId] ?? null : null,
    logger: { info() {}, warn() {}, error() {} },
  });
}

test('onSettle grades from the STORED row when a reader is provided (grade-57 defect fixed)', async () => {
  const writes = [], grades = [];
  const stored = {
    'btc-alpha-v2-scalp': {
      id: 41, window_id: 'W', engine_id: 'btc-alpha-v2-scalp', recommendation: 'TAKE_NO',
      up_ask: '0.360000', down_ask: '0.650000', up_bid: '0.30', down_bid: '0.60',
    },
  };
  const s = mkScheduler({ stored, writes, grades });
  const st = s._state('W');
  // the in-memory decision carries the RETRY book (down_ask 0.72) — the defect input
  st.sealed = true;
  st.decision = { window_id: 'W', engine_id: 'btc-alpha-v2-scalp', recommendation: 'TAKE_NO', up_ask: 0.42, down_ask: 0.72 };
  st.decisionId = 999; // memory id is stale too

  await s.onSettle({ window_id: 'W' }, { outcome: 'no', settlement_value: 64000, graded_at: Date.now() });
  assert.equal(grades.length, 1);
  const g = grades[0];
  assert.equal(g.entry_price, 0.65);            // stored ask, NOT the in-memory 0.72
  assert.equal(g.fee, 0.02);
  assert.equal(g.net_pnl, 0.33);                // 1 − 0.65 − 0.02
  assert.equal(g.decision_id, 41);              // FK to the canonical stored row
});

test('onSettle falls back to memory when no reader is provided (legacy behavior intact)', async () => {
  const writes = [], grades = [];
  const s = mkScheduler({ stored: null, writes, grades });
  const st = s._state('W');
  st.sealed = true;
  st.decision = { window_id: 'W', engine_id: 'btc-alpha-v2-scalp', recommendation: 'TAKE_YES', up_ask: 0.6, down_ask: 0.45 };
  await s.onSettle({ window_id: 'W' }, { outcome: 'yes', settlement_value: 64000, graded_at: Date.now() });
  assert.equal(grades[0].entry_price, 0.6);
  assert.equal(grades[0].net_pnl, 0.38);        // 1 − 0.6 − 0.02
});

test('onSettle survives a reader failure (falls back to memory, never skips the grade)', async () => {
  const writes = [], grades = [];
  const s = new V2Scheduler({
    writeDecision: async () => ({ written: 1, id: 1 }),
    writeGrade: async (row) => { grades.push(row); return { written: 1 }; },
    getOrderbook: async () => { throw new Error('unused'); },
    readDecision: async () => { throw new Error('db down'); },
    logger: { info() {}, warn() {}, error() {} },
  });
  const st = s._state('W');
  st.sealed = true;
  st.decision = { window_id: 'W', engine_id: 'btc-alpha-v2-scalp', recommendation: 'NO_TRADE' };
  await s.onSettle({ window_id: 'W' }, { outcome: 'yes', settlement_value: 64000, graded_at: Date.now() });
  assert.equal(grades.length, 1);
  assert.equal(grades[0].net_pnl, 0);           // NO_TRADE grades net 0
});
