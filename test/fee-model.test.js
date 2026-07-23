import test from 'node:test';
import assert from 'node:assert/strict';
import {
  ceilToCent,
  takerFee,
  makerFee,
  roundTripTakerFee,
  feeCentsPerContract,
  workedExample,
  DEFAULT_FEE_PARAMS,
} from '../src/fee-model.js';

const P = DEFAULT_FEE_PARAMS; // 0.07 taker multiplier, ceil-to-cent

test('ceilToCent rounds strictly up to the next cent', () => {
  assert.equal(ceilToCent(0.0175), 0.02);
  assert.equal(ceilToCent(0.0112), 0.02);
  assert.equal(ceilToCent(0.003325), 0.01);
  assert.equal(ceilToCent(0.0001), 0.01);
});

test('ceilToCent leaves exact cents untouched (no float drift)', () => {
  assert.equal(ceilToCent(0.02), 0.02);
  assert.equal(ceilToCent(0.01), 0.01);
  assert.equal(ceilToCent(1.0), 1.0);
  assert.equal(ceilToCent(0.07), 0.07);
  // 0.29 * 100 === 28.999999999999996 in IEEE754 — must not become 0.30
  assert.equal(ceilToCent(0.29), 0.29);
  assert.equal(ceilToCent(0.57), 0.57);
});

test('ceilToCent handles zero and negatives', () => {
  assert.equal(ceilToCent(0), 0);
  assert.equal(ceilToCent(-0.5), 0);
});

// --- Required worked examples -----------------------------------------
// fee = ceil_to_cent(0.07 * C * P * (1-P))

test('worked example P=0.50, C=1 -> $0.02', () => {
  const w = workedExample(0.5, 1, P);
  assert.equal(w.raw_dollars, 0.07 * 1 * 0.5 * 0.5); // 0.0175
  assert.equal(w.fee_dollars, 0.02);
  assert.equal(takerFee({ price: 0.5, contracts: 1, params: P }), 0.02);
});

test('worked example P=0.20, C=1 -> $0.02', () => {
  const w = workedExample(0.2, 1, P);
  assert.ok(Math.abs(w.raw_dollars - 0.0112) < 1e-12); // 0.07*0.2*0.8
  assert.equal(w.fee_dollars, 0.02);
  assert.equal(takerFee({ price: 0.2, contracts: 1, params: P }), 0.02);
});

test('worked example P=0.05, C=1 -> $0.01', () => {
  const w = workedExample(0.05, 1, P);
  assert.ok(Math.abs(w.raw_dollars - 0.003325) < 1e-12); // 0.07*0.05*0.95
  assert.equal(w.fee_dollars, 0.01);
  assert.equal(takerFee({ price: 0.05, contracts: 1, params: P }), 0.01);
});

test('fee is maximised at P=0.50 and symmetric about it', () => {
  const at50 = 0.07 * 100 * 0.5 * 0.5;
  const at40 = 0.07 * 100 * 0.4 * 0.6;
  const at60 = 0.07 * 100 * 0.6 * 0.4;
  assert.ok(at50 > at40);
  // Multiplication order differs between the two expressions, so compare with
  // tolerance; the fee function itself is asserted exactly below.
  assert.ok(Math.abs(at40 - at60) < 1e-9);
  assert.equal(
    takerFee({ price: 0.4, contracts: 100, params: P }),
    takerFee({ price: 0.6, contracts: 100, params: P })
  );
});

test('ceiling applies to the whole order, not per contract', () => {
  // 100 contracts at P=0.50 -> 0.07*100*0.25 = 1.75 exactly, no rounding up.
  assert.equal(takerFee({ price: 0.5, contracts: 100, params: P }), 1.75);
  // Per-contract ceiling would have produced 100 * 0.02 = $2.00.
  assert.notEqual(takerFee({ price: 0.5, contracts: 100, params: P }), 2.0);
});

test('small orders pay a disproportionate per-contract fee', () => {
  // The ceiling makes 1-lot trades expensive relative to size.
  const one = feeCentsPerContract({ price: 0.5, contracts: 1, params: P });
  const hundred = feeCentsPerContract({ price: 0.5, contracts: 100, params: P });
  // Tolerance, not equality: cents-per-contract is a derived ratio, so it
  // carries IEEE754 noise even though the underlying fee is an exact cent.
  assert.ok(Math.abs(one - 2) < 1e-9); // 2 cents/contract
  assert.ok(Math.abs(hundred - 1.75) < 1e-9); // 1.75 cents/contract
  assert.ok(one > hundred);
});

test('fee at the extremes tends to zero but never negative', () => {
  assert.equal(takerFee({ price: 0, contracts: 1, params: P }), 0);
  assert.equal(takerFee({ price: 1, contracts: 1, params: P }), 0);
  assert.ok(takerFee({ price: 0.01, contracts: 1, params: P }) >= 0);
});

test('zero contracts costs nothing', () => {
  assert.equal(takerFee({ price: 0.5, contracts: 0, params: P }), 0);
});

test('maker fee is zero unless the verified params enable it', () => {
  assert.equal(makerFee({ contracts: 100, params: P }), 0);
  const withMaker = { ...P, maker_fee_applies: true, maker_per_contract: 0.0025 };
  assert.equal(makerFee({ contracts: 100, params: withMaker }), 0.25);
  assert.equal(makerFee({ contracts: 1, params: withMaker }), 0.01); // ceiling
});

test('round trip charges both legs', () => {
  const rt = roundTripTakerFee({
    entryPrice: 0.5,
    exitPrice: 0.2,
    contracts: 100,
    params: P,
  });
  // 1.75 + ceil(0.07*100*0.2*0.8 = 1.12) = 1.75 + 1.12
  assert.ok(Math.abs(rt - 2.87) < 1e-9);
});

test('invalid inputs are rejected rather than silently coerced', () => {
  assert.throws(() => takerFee({ price: 1.5, contracts: 1, params: P }), RangeError);
  assert.throws(() => takerFee({ price: -0.1, contracts: 1, params: P }), RangeError);
  assert.throws(() => takerFee({ price: 0.5, contracts: 1.5, params: P }), RangeError);
  assert.throws(() => takerFee({ price: 0.5, contracts: -1, params: P }), RangeError);
  assert.throws(() => ceilToCent(NaN), TypeError);
});

test('default params are flagged unverified until the API verifier runs', () => {
  assert.equal(DEFAULT_FEE_PARAMS.verified, false);
});
