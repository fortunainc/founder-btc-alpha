/**
 * Kalshi fee model — v1.
 *
 * IMPORTANT: the numeric parameters here are DEFAULTS reflecting Kalshi's
 * published general fee schedule. They are superseded at runtime by
 * `config/verified-fee-params.json`, which is written by
 * `scripts/verify-mechanics.js` from live API responses. Nothing in Phase 0
 * may treat these defaults as verified — see docs/RVR-phase0-build.md for the
 * status of each parameter.
 *
 * Published general form (trading/taker fee):
 *
 *     fee_dollars = ceil_to_cent( multiplier * C * P * (1 - P) )
 *
 * where C = contract count, P = price in dollars (0..1). The ceiling is applied
 * to the WHOLE order, not per contract, and always rounds UP to the next cent.
 *
 * Maker fees, where a series charges them, are a flat per-contract rate applied
 * to resting liquidity, also ceiling-rounded to the cent.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Kalshi's published general fee schedule. UNVERIFIED until the fixture says so. */
export const DEFAULT_FEE_PARAMS = {
  series_ticker: 'KXBTC15M',
  taker_multiplier: 0.07,
  maker_fee_applies: false,
  maker_per_contract: 0.0,
  rounding: 'ceil_to_cent',
  source: 'kalshi published general fee schedule (DEFAULT — NOT API-VERIFIED)',
  verified: false,
};

/**
 * Load verified params if the verifier has produced them, else fall back to
 * defaults with `verified: false` so callers can refuse to trust them.
 */
export function loadFeeParams({ configPath } = {}) {
  const file =
    configPath || path.resolve(__dirname, '..', 'config', 'verified-fee-params.json');
  if (fs.existsSync(file)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return { ...DEFAULT_FEE_PARAMS, ...parsed };
    } catch {
      return { ...DEFAULT_FEE_PARAMS };
    }
  }
  return { ...DEFAULT_FEE_PARAMS };
}

/**
 * Round a dollar amount UP to the next whole cent.
 * Uses integer-cent arithmetic with an epsilon guard so that values which are
 * mathematically exact cents (e.g. 0.02) are not pushed to the next cent by
 * binary floating-point representation error.
 */
export function ceilToCent(dollars) {
  if (!Number.isFinite(dollars)) throw new TypeError('ceilToCent: non-finite input');
  if (dollars <= 0) return 0;
  const cents = dollars * 100;
  const EPS = 1e-9;
  const rounded = Math.ceil(cents - EPS);
  return rounded / 100;
}

/** Validate a price is a usable probability in dollars. */
function assertPrice(p) {
  if (!Number.isFinite(p) || p < 0 || p > 1) {
    throw new RangeError(`price must be in [0,1] dollars, received ${p}`);
  }
}

/** Validate a contract count. */
function assertCount(c) {
  if (!Number.isInteger(c) || c < 0) {
    throw new RangeError(`contract count must be a non-negative integer, received ${c}`);
  }
}

/**
 * Taker (trading) fee in dollars for an order.
 * @param {object} args
 * @param {number} args.price      price in dollars, 0..1
 * @param {number} args.contracts  contract count
 * @param {object} [args.params]   fee params (defaults to loaded/verified set)
 */
export function takerFee({ price, contracts, params = loadFeeParams() }) {
  assertPrice(price);
  assertCount(contracts);
  const raw = params.taker_multiplier * contracts * price * (1 - price);
  return ceilToCent(raw);
}

/** Maker fee in dollars, zero unless the verified params say the series charges one. */
export function makerFee({ contracts, params = loadFeeParams() }) {
  assertCount(contracts);
  if (!params.maker_fee_applies) return 0;
  return ceilToCent(params.maker_per_contract * contracts);
}

/**
 * Total round-trip cost of entering at `entryPrice` and exiting at `exitPrice`,
 * both as taker. Used later to size the edge a strategy must clear; in Phase 0
 * it exists only so the capture record can carry a cost estimate alongside it.
 */
export function roundTripTakerFee({ entryPrice, exitPrice, contracts, params = loadFeeParams() }) {
  return (
    takerFee({ price: entryPrice, contracts, params }) +
    takerFee({ price: exitPrice, contracts, params })
  );
}

/**
 * Fee expressed in cents-per-contract, the unit an edge threshold is stated in.
 */
export function feeCentsPerContract({ price, contracts = 1, params = loadFeeParams() }) {
  if (contracts === 0) return 0;
  return (takerFee({ price, contracts, params }) / contracts) * 100;
}

/**
 * Breakeven edge: how far the true probability must sit from the quoted price
 * before a single taker round-trip is profitable, in probability points.
 */
export function breakevenEdge({ price, contracts = 1, params = loadFeeParams() }) {
  const fee = takerFee({ price, contracts, params });
  return fee / contracts;
}

/** Human-readable worked example, used by the tests and the RVR. */
export function workedExample(price, contracts = 1, params = loadFeeParams()) {
  const raw = params.taker_multiplier * contracts * price * (1 - price);
  const fee = ceilToCent(raw);
  return {
    price,
    contracts,
    multiplier: params.taker_multiplier,
    formula: `ceil_to_cent(${params.taker_multiplier} * ${contracts} * ${price} * ${1 - price})`,
    raw_dollars: raw,
    fee_dollars: fee,
    fee_cents_per_contract: (fee / contracts) * 100,
    params_verified: Boolean(params.verified),
  };
}
