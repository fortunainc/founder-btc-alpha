/**
 * BTC Alpha V2.2 — profit-selection tests. Verifies the objective is EXPECTED NET
 * DOLLARS after fees, not conviction: it takes positive-EV sides, sizes nothing on
 * negative-EV sides, and — the thesis — ABSTAINS on a strong directional view the
 * market has already priced (where v2.1 would trade).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { selectProfit, PROFIT_ENGINE_ID, PROFIT_SPEC_VERSION } from '../../src/v2/profit.js';
import { kalshiFee, sealProfitDecision, profitProbability } from '../../src/v2/engine.js';

const fee = kalshiFee;

test('takes YES when model prob clears the ask + fee by the margin', () => {
  const r = selectProfit({ p_yes: 0.90, up_ask: 0.60, down_ask: 0.42, feeFn: fee });
  assert.equal(r.recommendation, 'TAKE_YES');
  assert.ok(r.chosen_ev >= r.min_edge, `ev ${r.chosen_ev} >= ${r.min_edge}`);
  assert.ok(r.ev_yes > r.ev_no, 'YES is the higher-EV side');
});

test('THESIS: a strong YES view the market has already priced → NO TRADE (v2.1 would trade)', () => {
  // model is 85% YES (a strong directional call) but YES already costs 0.88 and NO costs 0.14 →
  // buying YES is negative EV, buying NO is below the margin. Correct answer: stand down.
  const r = selectProfit({ p_yes: 0.85, up_ask: 0.88, down_ask: 0.14, feeFn: fee });
  assert.equal(r.recommendation, 'NO_TRADE');
  assert.equal(r.status, 'ok');            // not a data gap — a priced-in call
  assert.ok(r.ev_yes < 0, 'YES is negative EV despite the strong signal');
  assert.ok(r.chosen_ev < r.min_edge);
});

test('takes NO when the cheap side is the profitable one', () => {
  const r = selectProfit({ p_yes: 0.20, up_ask: 0.30, down_ask: 0.62, feeFn: fee });
  assert.equal(r.recommendation, 'TAKE_NO');   // (1-0.20) - 0.62 - fee ≈ 0.17 > margin
  assert.ok(r.ev_no > r.ev_yes);
});

test('fee is subtracted — a bare-breakeven gross edge does NOT clear the net margin', () => {
  // gross YES edge = 0.90-0.88 = 0.02, but the fee pushes net EV below MIN_EDGE
  const r = selectProfit({ p_yes: 0.90, up_ask: 0.88, down_ask: 0.10, feeFn: fee });
  assert.equal(r.recommendation, 'NO_TRADE');
  assert.ok(r.ev_yes < r.min_edge, 'net-of-fee EV under the margin');
});

test('no probability → honest abstention (no_forecast_data), never a guessed side', () => {
  for (const p of [null, undefined, NaN, 0, 1]) {
    const r = selectProfit({ p_yes: p, up_ask: 0.5, down_ask: 0.5, feeFn: fee });
    assert.equal(r.recommendation, 'NO_TRADE');
    assert.equal(r.status, 'no_forecast_data');
  }
});

test('sealProfitDecision produces a schema-shaped row with the profit engine_id + EV diagnostics', () => {
  // S well above K with low vol → high YES prob; give a cheap YES ask so it acts.
  const row = sealProfitDecision({
    window_id: 'W-TEST', now: Date.parse('2026-07-24T20:00:00Z'), window_close_ts: '2026-07-24T20:12:00Z',
    S: 64500, K: 64000, tauSec: 600, sigmaPerSec: 0.00008,
    up_ask: 0.55, down_ask: 0.47, up_bid: 0.53, down_bid: 0.45, market_p: 0.54, is_replay: true,
  });
  assert.equal(row.engine_id, PROFIT_ENGINE_ID);
  assert.equal(row.spec_version, PROFIT_SPEC_VERSION);
  assert.ok(['TAKE_YES', 'TAKE_NO', 'NO_TRADE'].includes(row.recommendation));
  assert.ok(['ok', 'no_forecast_data'].includes(row.status));
  assert.ok(Number.isFinite(row.evidence.p_model), 'p_model recorded');
  assert.equal(row.evidence.objective, 'expected_net_dollars_after_fees');
  // p_model must equal the diffusion model directly
  const p = profitProbability({ S: 64500, K: 64000, sigmaPerSec: 0.00008, tauSec: 600 });
  assert.ok(Math.abs(row.evidence.p_model - p) < 1e-9);
});
