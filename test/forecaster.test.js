import test from 'node:test';
import assert from 'node:assert/strict';
import {
  normalCdf, logit, logistic, clampP,
  modelB0, modelB1, modelB2, modelB3,
  sealPointFor, buildSealRows, modelVersionFor,
  brier, logLoss, actionableThreshold,
  MODEL_IDS, SEAL_POINTS, AVERAGING_CORRECTION_S, P_MIN, P_MAX,
} from '../src/forecaster.js';
import { takerFee } from '../src/fee-model.js';

// A representative live-ish context.
const BASE = { S: 65000, K: 64900, sigma: 0.00005, tau: 600, ret5m: 0.0004 };

test('normalCdf matches known values', () => {
  assert.ok(Math.abs(normalCdf(0) - 0.5) < 1e-9);
  assert.ok(Math.abs(normalCdf(1.96) - 0.975) < 1e-4);
  assert.ok(Math.abs(normalCdf(-1.96) - 0.025) < 1e-4);
  assert.ok(Math.abs(normalCdf(1) - 0.8413447) < 1e-5);
  assert.ok(normalCdf(8) > 0.9999999);
  assert.ok(normalCdf(-8) < 1e-7);
});

test('logit and logistic are inverses', () => {
  for (const p of [0.05, 0.25, 0.5, 0.75, 0.95]) {
    assert.ok(Math.abs(logistic(logit(p)) - p) < 1e-12);
  }
  assert.equal(logit(0), null);
  assert.equal(logit(1), null);
});

test('clampP enforces the frozen [0.01,0.99] seal range', () => {
  assert.equal(clampP(0.001), P_MIN);
  assert.equal(clampP(0.999), P_MAX);
  assert.equal(clampP(0.5), 0.5);
});

// --- B0 ---------------------------------------------------------------

test('B0 seals the Kalshi up mid verbatim', () => {
  const r = modelB0({ upMid: 0.62 });
  assert.equal(r.pass, false);
  assert.equal(r.sealed_p, 0.62);
});

test('B0 PASSES when the mid is unavailable — never substitutes', () => {
  assert.equal(modelB0({ upMid: null }).pass, true);
  assert.equal(modelB0({ upMid: undefined }).reason, 'up_mid_unavailable');
});

// --- B1 ---------------------------------------------------------------

test('B1 applies the tau_eff = tau - 30s averaging correction', () => {
  const r = modelB1(BASE);
  assert.equal(r.pass, false);
  assert.equal(r.diagnostics.tau, 600);
  assert.equal(r.diagnostics.tau_eff, 600 - AVERAGING_CORRECTION_S);
});

test('B1 seals the sigma_eff variant, and logs the plain one unsealed', () => {
  const r = modelB1(BASE);
  // Sealed value must equal the tau_eff probability, not the plain one.
  assert.ok(Math.abs(r.sealed_p - clampP(r.diagnostics.p_eff)) < 1e-12);
  assert.ok(Number.isFinite(r.diagnostics.p_plain));
  // Shorter effective horizon => larger |d| => p further from 0.5 when S>K.
  assert.ok(r.diagnostics.p_eff > r.diagnostics.p_plain,
    'S>K: the correction should push probability further above 0.5');
});

test('B1 is 0.5 exactly at the money', () => {
  const r = modelB1({ ...BASE, S: 64900, K: 64900 });
  assert.ok(Math.abs(r.sealed_p - 0.5) < 1e-9);
});

test('B1 is monotonic in S', () => {
  const lo = modelB1({ ...BASE, S: 64800 }).sealed_p;
  const at = modelB1({ ...BASE, S: 64900 }).sealed_p;
  const hi = modelB1({ ...BASE, S: 65100 }).sealed_p;
  assert.ok(lo < at && at < hi);
});

test('B1 PASSES on every missing input rather than guessing', () => {
  assert.equal(modelB1({ ...BASE, sigma: null }).reason, 'realized_vol_unavailable');
  assert.equal(modelB1({ ...BASE, sigma: 0 }).reason, 'realized_vol_unavailable');
  assert.equal(modelB1({ ...BASE, S: null }).reason, 'replica_index_unavailable');
  assert.equal(modelB1({ ...BASE, K: null }).reason, 'strike_unavailable');
});

test('B1 PASSES when tau_eff would be non-positive', () => {
  // Inside the final 30s the averaging correction leaves no horizon.
  const r = modelB1({ ...BASE, tau: 25 });
  assert.equal(r.pass, true);
  assert.equal(r.reason, 'tau_eff_nonpositive');
});

// --- B2 ---------------------------------------------------------------

test('B2 adds positive drift above B1 when momentum is positive', () => {
  const b1 = modelB1(BASE).sealed_p;
  const b2 = modelB2({ ...BASE, ret5m: 0.002 }).sealed_p;
  assert.ok(b2 > b1, `expected drift to raise p: b1=${b1} b2=${b2}`);
});

test('B2 subtracts below B1 when momentum is negative', () => {
  const b1 = modelB1(BASE).sealed_p;
  const b2 = modelB2({ ...BASE, ret5m: -0.002 }).sealed_p;
  assert.ok(b2 < b1);
});

test('B2 equals B1 when the 5m return is exactly zero', () => {
  const b1 = modelB1(BASE).sealed_p;
  const b2 = modelB2({ ...BASE, ret5m: 0 }).sealed_p;
  assert.ok(Math.abs(b1 - b2) < 1e-12);
});

test('B2 caps mu_hat at +/-1 sigma, per the frozen spec', () => {
  // A huge 5m return must be clipped to exactly +sigma (per-second units).
  const r = modelB2({ ...BASE, ret5m: 99 });
  assert.equal(r.diagnostics.mu_was_capped, true);
  assert.ok(Math.abs(r.diagnostics.mu_per_second_capped - BASE.sigma) < 1e-18);

  const rNeg = modelB2({ ...BASE, ret5m: -99 });
  assert.ok(Math.abs(rNeg.diagnostics.mu_per_second_capped + BASE.sigma) < 1e-18);
});

test('B2 converts the per-minute drift to per-second (the 60x trap)', () => {
  const ret5m = 0.003;
  const r = modelB2({ ...BASE, ret5m });
  assert.ok(Math.abs(r.diagnostics.mu_per_minute - ret5m / 5) < 1e-15);
  assert.ok(Math.abs(r.diagnostics.mu_per_second_raw - ret5m / 5 / 60) < 1e-18);
});

test('B2 PASSES without a 5m return', () => {
  assert.equal(modelB2({ ...BASE, ret5m: null }).reason, 'five_min_return_unavailable');
});

// --- B3 ---------------------------------------------------------------

test('B3 equals B1 when the book is perfectly balanced', () => {
  const b1 = modelB1(BASE).sealed_p;
  const b3 = modelB3({ ...BASE, upDepth2c: 500, downDepth2c: 500 }).sealed_p;
  assert.ok(Math.abs(b1 - b3) < 1e-9);
});

test('B3 tilts up when up-side depth dominates', () => {
  const b1 = modelB1(BASE).sealed_p;
  const b3 = modelB3({ ...BASE, upDepth2c: 900, downDepth2c: 100 }).sealed_p;
  assert.ok(b3 > b1);
});

test('B3 tilts down when down-side depth dominates', () => {
  const b1 = modelB1(BASE).sealed_p;
  const b3 = modelB3({ ...BASE, upDepth2c: 100, downDepth2c: 900 }).sealed_p;
  assert.ok(b3 < b1);
});

test('B3 applies exactly the frozen 0.5*imb logit shift', () => {
  const up = 800, down = 200;
  const imb = (up - down) / (up + down); // 0.6
  const b1 = modelB1(BASE).sealed_p;
  const expected = logistic(logit(b1) + 0.5 * imb);
  const b3 = modelB3({ ...BASE, upDepth2c: up, downDepth2c: down }).sealed_p;
  assert.ok(Math.abs(b3 - clampP(expected)) < 1e-12);
});

test('B3 PASSES on an empty or missing book', () => {
  assert.equal(modelB3({ ...BASE, upDepth2c: 0, downDepth2c: 0 }).reason, 'zero_book_depth');
  assert.equal(modelB3({ ...BASE, upDepth2c: null, downDepth2c: 5 }).reason, 'book_depth_unavailable');
});

test('B3 inherits a B1 PASS', () => {
  const r = modelB3({ ...BASE, sigma: null, upDepth2c: 500, downDepth2c: 100 });
  assert.equal(r.pass, true);
  assert.equal(r.reason, 'realized_vol_unavailable');
});

// --- seal cadence -----------------------------------------------------

test('seal points match the frozen cadence within +/-5s', () => {
  assert.equal(sealPointFor(600).label, 'T-10');
  assert.equal(sealPointFor(595).label, 'T-10');
  assert.equal(sealPointFor(605).label, 'T-10');
  assert.equal(sealPointFor(300).label, 'T-5');
  assert.equal(sealPointFor(120).label, 'T-2');
});

test('outside tolerance there is no seal point', () => {
  assert.equal(sealPointFor(594), null);
  assert.equal(sealPointFor(606), null);
  assert.equal(sealPointFor(450), null);
  assert.equal(sealPointFor(60), null);
});

test('frozen cadence is exactly T-10 / T-5 / T-2', () => {
  assert.deepEqual(SEAL_POINTS.map((s) => s.label), ['T-10', 'T-5', 'T-2']);
});

// --- seal row construction -------------------------------------------

const SEAL_CTX = {
  windowId: 'KXBTC15M-TEST',
  windowCloseTs: '2026-07-23T16:00:00Z',
  sealedAt: '2026-07-23T15:50:00Z',
  sealPoint: SEAL_POINTS[0],
  secondsToClose: 600,
  replica: 65000,
  strike: 64900,
  sigma: 0.00005,
  ret5m: 0.0004,
  book: {
    up_bid: 0.60, up_ask: 0.62, up_mid: 0.61,
    down_bid: 0.38, down_ask: 0.40, down_mid: 0.39,
    up_depth_2c_bid: 800, down_depth_2c_bid: 400,
  },
};

test('a healthy seal moment produces all four model rows', () => {
  const { rows, passes } = buildSealRows(SEAL_CTX);
  assert.equal(rows.length, 4);
  assert.equal(passes.length, 0);
  assert.deepEqual(
    rows.map((r) => r.model_id).sort(),
    [MODEL_IDS.B0, MODEL_IDS.B1, MODEL_IDS.B2, MODEL_IDS.B3].sort()
  );
});

test('model_version encodes the seal point for idempotency', () => {
  const { rows } = buildSealRows(SEAL_CTX);
  for (const r of rows) assert.equal(r.model_version, 'v1@T-10');
  assert.equal(modelVersionFor('T-2'), 'v1@T-2');
});

test('every sealed row obeys the schema CHECKs', () => {
  const { rows } = buildSealRows(SEAL_CTX);
  for (const r of rows) {
    assert.ok(r.sealed_p >= P_MIN && r.sealed_p <= P_MAX);
    assert.ok(new Date(r.sealed_at) < new Date(r.window_close_ts),
      'seal must predate close (schema-enforced)');
  }
});

test('executable prices are captured at the seal moment', () => {
  const { rows } = buildSealRows(SEAL_CTX);
  const ep = rows[0].executable_prices;
  assert.equal(ep.up_bid, 0.60);
  assert.equal(ep.up_ask, 0.62);
  assert.equal(ep.down_bid, 0.38);
  assert.equal(ep.up_depth_2c_bid, 800);
  assert.equal(ep.seal_point, 'T-10');
  assert.equal(ep.strike, 64900);
});

test('missing vol degrades to B0 only — three models PASS, none fabricated', () => {
  const { rows, passes } = buildSealRows({ ...SEAL_CTX, sigma: null });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].model_id, MODEL_IDS.B0);
  assert.equal(passes.length, 3);
  for (const p of passes) assert.ok(p.reason);
});

test('a fully unusable moment seals nothing at all', () => {
  const { rows, passes } = buildSealRows({
    ...SEAL_CTX, sigma: null, replica: null,
    book: { up_mid: null, up_depth_2c_bid: null, down_depth_2c_bid: null },
  });
  assert.equal(rows.length, 0);
  assert.equal(passes.length, 4);
});

// --- grading ----------------------------------------------------------

test('Brier and log loss are correct', () => {
  assert.ok(Math.abs(brier(0.8, true) - 0.04) < 1e-12);
  assert.ok(Math.abs(brier(0.8, false) - 0.64) < 1e-12);
  assert.ok(Math.abs(logLoss(0.8, true) + Math.log(0.8)) < 1e-12);
  assert.ok(Math.abs(logLoss(0.8, false) + Math.log(0.2)) < 1e-12);
});

test('a perfect forecast scores zero Brier', () => {
  assert.equal(brier(1, true), 0);
  assert.equal(brier(0, false), 0);
});

test('actionable threshold = exact fee + half spread + 1pp', () => {
  // p=0.50 -> fee = ceil_to_cent(0.07*0.25) = $0.02; half spread 0.01; +0.01
  const t = actionableThreshold({ price: 0.5, halfSpread: 0.01, takerFeeFn: takerFee });
  assert.ok(Math.abs(t - (0.02 + 0.01 + 0.01)) < 1e-9);
});

test('threshold widens with the spread', () => {
  const tight = actionableThreshold({ price: 0.5, halfSpread: 0.005, takerFeeFn: takerFee });
  const wide = actionableThreshold({ price: 0.5, halfSpread: 0.05, takerFeeFn: takerFee });
  assert.ok(wide > tight);
});
