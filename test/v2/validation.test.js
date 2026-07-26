// Three-approach validation — deterministic tests (founder directive 2026-07-26).
// Pins: accuracy denominators, exclusion handling, H2H matching, reconciliation
// identities, drawdown math, and the audit's grade-57 defect class (correction
// overlay semantics + stored-row grading in scheduler.test companion).
import test from 'node:test';
import assert from 'node:assert/strict';
import { v2Metrics, forecastMetrics, headToHead, reconcile, buildValidationModel, buildInspectorRows } from '../../src/validation.js';

const D = (over = {}) => ({
  window_id: 'W1', sealed_at: '2026-07-25T00:03:00Z', engine_id: 'btc-alpha-v2-scalp',
  spec_version: 'v2.1.0', recommendation: 'TAKE_YES', status: 'ok',
  up_ask: 0.6, down_ask: 0.45, settled_outcome: 'yes', call_correct: true,
  entry_price: 0.6, fee: 0.02, net_pnl: 0.38, graded_at: '2026-07-25T00:15:00Z', ...over,
});

test('v2Metrics: accuracy = correct/(correct+incorrect); NO_TRADE, pending, void, unpriceable excluded but counted', () => {
  const calls = [
    D({ window_id: 'A' }),                                                       // correct
    D({ window_id: 'B', call_correct: false, net_pnl: -0.62 }),                  // incorrect
    D({ window_id: 'C', recommendation: 'NO_TRADE', call_correct: null, net_pnl: 0 }), // graded NO_TRADE
    D({ window_id: 'D', settled_outcome: null, call_correct: null, net_pnl: null }),   // pending
    D({ window_id: 'E', settled_outcome: 'void', call_correct: null, net_pnl: null }), // void
    D({ window_id: 'F', call_correct: true, entry_price: null, fee: null, net_pnl: null }), // unpriceable actionable
  ];
  const m = v2Metrics(calls);
  assert.equal(m.settled_actionable, 3);      // A, B, F
  assert.equal(m.correct, 2); assert.equal(m.incorrect, 1);
  assert.equal(m.accuracy_pct, 66.7);
  assert.equal(m.no_trade, 1); assert.equal(m.pending, 1); assert.equal(m.voids, 1);
  assert.equal(m.unpriceable, 1);
  assert.equal(m.net, -0.24);                 // only priced rows: 0.38 - 0.62
  assert.equal(m.observed, 6);
});

test('v2Metrics: max drawdown over cumulative net in graded order', () => {
  const seq = [0.3, -0.5, -0.4, 0.2].map((net, i) => D({
    window_id: 'W' + i, net_pnl: net, call_correct: net > 0,
    graded_at: `2026-07-25T00:0${i}:00Z`,
  }));
  const m = v2Metrics(seq);
  assert.equal(m.max_drawdown, 0.9);          // peak 0.3 → trough -0.6
});

test('forecastMetrics: FAIR/THIN never enter accuracy; timing filter works', () => {
  const F = (over) => ({ window_id: 'W', seal_point: 'T-10', sealed_at: '2026-07-25T00:00:00Z', call: 'YES', outcome: 'yes', call_correct: true, ...over });
  const calls = [
    F({ window_id: 'A' }), F({ window_id: 'B', call: 'NO', call_correct: false }),
    F({ window_id: 'C', call: 'FAIR', call_correct: true }), F({ window_id: 'D', call: 'THIN', call_correct: null }),
    F({ window_id: 'E', seal_point: 'T-2', call: 'YES', call_correct: false }),
    F({ window_id: 'P', outcome: null, call_correct: null }),
  ];
  const all = forecastMetrics(calls);
  assert.equal(all.settled_actionable, 3); assert.equal(all.correct, 1); assert.equal(all.incorrect, 2);
  assert.equal(all.fair, 1); assert.equal(all.thin, 1); assert.equal(all.pending, 1);
  const t10 = forecastMetrics(calls, 'T-10');
  assert.equal(t10.settled_actionable, 2); assert.equal(t10.accuracy_pct, 50);
});

test('headToHead: only windows where all three sealed AND settled; legacy v2.0 rows never match', () => {
  const f = [
    { window_id: 'W1', seal_point: 'T-10', call: 'YES', outcome: 'yes', call_correct: true },
    { window_id: 'W2', seal_point: 'T-10', call: 'NO', outcome: null, call_correct: null },   // unsettled
    { window_id: 'W3', seal_point: 'T-5', call: 'YES', outcome: 'yes', call_correct: true },  // wrong timing
    { window_id: 'W4', seal_point: 'T-10', call: 'THIN', outcome: 'no', call_correct: null }, // THIN still matches (sealed output)
  ];
  const a = [D({ window_id: 'W1' }), D({ window_id: 'W2' }), D({ window_id: 'W4', recommendation: 'NO_TRADE', call_correct: null, net_pnl: 0 }),
    D({ window_id: 'W5', spec_version: 'v2.0.0' })];
  const b = [D({ window_id: 'W1', engine_id: 'btc-alpha-v2-profit', spec_version: 'v2.2.0' }),
    D({ window_id: 'W2', engine_id: 'btc-alpha-v2-profit', spec_version: 'v2.2.0' }),
    D({ window_id: 'W4', engine_id: 'btc-alpha-v2-profit', spec_version: 'v2.2.0', recommendation: 'NO_TRADE', call_correct: null, net_pnl: 0 })];
  const h = headToHead({ forecastCalls: f, v21Calls: a, v22Calls: b });
  assert.deepEqual(h.windows.sort(), ['W1', 'W4']);
  assert.equal(h.v21.settled_actionable, 1);  // W1 actionable; W4 NO_TRADE
});

test('reconcile: identities hold on a consistent model and FAIL loudly on a broken one', () => {
  const calls = [D({ window_id: 'A' }), D({ window_id: 'B', recommendation: 'NO_TRADE', call_correct: null, net_pnl: 0 })];
  const m = v2Metrics(calls);
  const f = forecastMetrics([]);
  const ok = reconcile({ v21: m, v22: v2Metrics([]), fAll: f, v21Calls: calls, v22Calls: [], forecastCalls: [], corrections: 1 });
  assert.ok(ok.every((c) => c.pass), JSON.stringify(ok.filter((c) => !c.pass)));
  const broken = reconcile({ v21: { ...m, correct: 99 }, v22: v2Metrics([]), fAll: f, v21Calls: calls, v22Calls: [], forecastCalls: [], corrections: 0 });
  assert.ok(broken.some((c) => !c.pass));
});

test('buildValidationModel: v2.0.0 legacy rows are split out, never mixed into the current record', () => {
  const data = {
    v2Calls: [
      D({ window_id: 'OLD', spec_version: 'v2.0.0', call_correct: false, net_pnl: -0.6 }),
      D({ window_id: 'NEW' }),
      D({ window_id: 'NEW2', engine_id: 'btc-alpha-v2-profit', spec_version: 'v2.2.0' }),
    ],
    forecastCalls: [], corrections: 0,
  };
  const model = buildValidationModel(data);
  assert.equal(model.v21.observed, 1);            // current-version only
  assert.equal(model.v21LegacyM.observed, 1);     // legacy shown separately
  assert.equal(model.v21All.observed, 2);         // all-version history available
  assert.equal(model.v21.incorrect, 0);           // the legacy loss did NOT leak in
});

test('inspector rows: grade-57 class surfaces as corrected flag; every call present', () => {
  const data = {
    v2Calls: [D({ window_id: 'W1', corrected: true, correction_reason: 'entry_price_not_sealed_ask' }),
      D({ window_id: 'W2', settled_outcome: null, net_pnl: null, call_correct: null })],
    forecastCalls: [{ window_id: 'W1', seal_point: 'T-10', sealed_at: 's', call: 'FAIR', outcome: 'yes', call_correct: true, consensus_p: 0.5, market_p: 0.5, divergence: 0, models_sealed: 4 }],
    corrections: 1,
  };
  const model = buildValidationModel(data);
  const rows = buildInspectorRows(data, model);
  assert.equal(rows.v21.length, 2);
  assert.equal(rows.v21[0].corrected, true);
  assert.equal(rows.v21[1].pending, true);
  assert.equal(rows.forecast.length, 1);
});
