// v2.4 dashboard: metric denominators, abstention handling, timeline integrity,
// stale-analysis refusal, reconciliation between metrics and underlying calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import { v24Metrics, v24Timelines, renderV24 } from '../src/v24-dashboard.js';

const NOW = Date.parse('2026-07-26T21:00:00Z');
const G = (w, rec, outcome, correct, net, minsAgo) => ({ window_id: w, engine_id: 'btc-alpha-v24-technical', recommendation: rec, settled_outcome: outcome, call_correct: correct, net_pnl: net, graded_at: new Date(NOW - minsAgo * 60e3).toISOString() });
const R = (w, seq, rec, minsAgo, over = {}) => ({ window_id: w, revision_seq: seq, recommendation: rec, evaluated_at: new Date(NOW - minsAgo * 60e3).toISOString(), conviction: 0.4, reason: 'r', window_close_ts: new Date(NOW - (minsAgo - 15) * 60e3).toISOString(), data_status: { data_age_ms: 1000 }, ...over });

test('metrics: accuracy = correct/(correct+incorrect); WAIT/NO_TRADE counted as abstentions never errors; drawdown + streak', () => {
  const grades = [G('A', 'TAKE_YES', 'yes', true, 0.4, 500), G('B', 'TAKE_NO', 'yes', false, -0.6, 400), G('C', 'TAKE_YES', 'yes', true, 0.3, 300)];
  const revisions = [R('A', 1, 'WAIT', 510), R('A', 2, 'YES', 505), R('B', 1, 'NO', 405), R('C', 1, 'YES', 305), R('D', 1, 'NO_TRADE', 100)];
  const m = v24Metrics({ grades, revisions, nowMs: NOW });
  assert.equal(m.resolved, 3); assert.equal(m.correct, 2); assert.equal(m.incorrect, 1);
  assert.equal(m.accuracy_pct, 66.7); assert.equal(m.accuracy_n, 3);
  assert.equal(m.wait_revisions, 1); assert.equal(m.no_trade_revisions, 1);
  assert.equal(m.markets_covered, 4);
  assert.equal(m.net_usd, 0.1);
  assert.equal(m.max_drawdown_usd, 0.6); // peak 0.4 → trough −0.2
  assert.equal(m.streak, 1);
  // time windows: only D's revision falls in the last 3h; no grades
  const recent = v24Metrics({ grades, revisions, sinceMs: 3 * 3600e3, nowMs: NOW });
  assert.equal(recent.resolved, 0); assert.equal(recent.accuracy_pct, null); assert.equal(recent.no_trade_revisions, 1);
});

test('timelines: revisions grouped per market ascending; nothing dropped or reordered', () => {
  const revs = [R('W1', 2, 'YES', 20), R('W1', 1, 'WAIT', 22), R('W2', 1, 'NO', 5)];
  const t = v24Timelines(revs);
  assert.equal(t[0].window_id, 'W2');
  assert.deepEqual(t[1].revs.map((r) => r.revision_seq), [1, 2]);
});

test('render: every accuracy shows numerator/denominator; stale open-market analysis shows the red refusal banner', () => {
  const grades = [G('A', 'TAKE_YES', 'yes', true, 0.4, 500)];
  const fresh = renderV24({ revisions: [R('A', 1, 'YES', 1)], grades, comparison: [], nowMs: NOW });
  assert.match(fresh, /\(1\/1\)/, 'accuracy carries its sample');
  assert.ok(!/ANALYSIS STALE/.test(fresh));
  const stale = renderV24({ revisions: [R('A', 1, 'YES', 10, { window_close_ts: new Date(NOW + 5 * 60e3).toISOString() })], grades, comparison: [], nowMs: NOW });
  assert.match(stale, /ANALYSIS STALE/, 'stale current recommendation is refused, not presented as current');
  assert.match(stale, /DO NOT treat the recommendation below as current/);
});

test('reconciliation identity: table metrics equal recomputation from the same underlying calls', () => {
  const grades = [G('A', 'TAKE_YES', 'yes', true, 0.4, 50), G('B', 'TAKE_NO', 'no', true, 0.35, 40), G('C', 'TAKE_YES', 'no', false, -0.7, 30)];
  const m1 = v24Metrics({ grades, revisions: [], nowMs: NOW });
  const m2 = v24Metrics({ grades: [...grades], revisions: [], nowMs: NOW });
  assert.deepEqual(m1, m2);
  assert.equal(m1.correct + m1.incorrect, m1.accuracy_n);
  assert.equal(m1.net_usd, Number((0.4 + 0.35 - 0.7).toFixed(2)));
});
