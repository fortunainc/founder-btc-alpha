/**
 * Phase 1 forecaster — frozen models B0..B3.
 *
 * EVERY formula here is transcribed from `founder_alpha.fa_ontology_versions`
 * (kind='model', frozen 2026-07-23 15:40:06Z). Nothing is invented. A change to
 * any formula requires a NEW ontology version row, never an edit here.
 *
 * Frozen specs, verbatim:
 *
 *  b0-market-price-v1
 *    "sealed_p = Kalshi up-contract mid at seal time; the null baseline every
 *     model must beat"
 *
 *  b1-nodrift-diffusion-v1
 *    "sealed_p = Phi(d), d = ln(S/K)/(sigma_eff*sqrt(tau)); S=replica at seal;
 *     K=floor_strike; sigma from rolling 15m realized vol; sigma_eff uses
 *     tau_eff = tau - 30s for the 60s settlement-averaging correction; both
 *     sigma variants logged, only sigma_eff sealed"
 *
 *  b2-momentum-v1
 *    "B1 plus drift term mu_hat*tau in d; mu_hat = signed 5m replica return per
 *     minute, capped at +/-1 sigma"
 *
 *  b3-book-imbalance-v1
 *    "sealed_p = logistic(logit(B1_p) + 0.5*imb); imb=(up_bid_depth-
 *     down_bid_depth)/sum within 2c of mid from Kalshi book"
 *
 * UNITS — the one place the spec needs a documented reading.
 * `sigma` is the realized-vol figure this repo already produces: the standard
 * deviation of log returns between consecutive 1 Hz replica prints, i.e. a
 * PER-SECOND volatility. For `sigma*sqrt(tau)` to be dimensionally coherent,
 * tau is therefore carried in SECONDS throughout. The spec states mu_hat as a
 * "per minute" return; it is converted to per-second (divide by 60) so that
 * `mu_hat*tau` is a pure return like `ln(S/K)`, and the "+/-1 sigma" cap is
 * applied in those same per-second units. Any other reading would leave the
 * drift term off by 60x.
 *
 * HARD RULE: a model that cannot compute from real inputs returns
 * {pass: true, reason}. It is NEVER sealed with a substituted or guessed input.
 */

/** Frozen model identities — must match fa_ontology_versions.version exactly. */
export const MODEL_IDS = {
  B0: 'b0-market-price-v1',
  B1: 'b1-nodrift-diffusion-v1',
  B2: 'b2-momentum-v1',
  B3: 'b3-book-imbalance-v1',
};

/** Frozen seal points, from seal-cadence v1. */
export const SEAL_POINTS = [
  { label: 'T-10', seconds_to_close: 600 },
  { label: 'T-5', seconds_to_close: 300 },
  { label: 'T-2', seconds_to_close: 120 },
];

/** Seal-point matching tolerance, per dispatch. */
export const SEAL_TOLERANCE_S = 5;

/** The 60s settlement-averaging correction: tau_eff = tau - 30s. */
export const AVERAGING_CORRECTION_S = 30;

/** Sealed probabilities are clamped to this range before insert. */
export const P_MIN = 0.01;
export const P_MAX = 0.99;

/**
 * IDENTITY / IDEMPOTENCY STRATEGY — chosen once, stable forever.
 *
 * `fa_forecast_seal` has UNIQUE(model_id, model_version, window_id), which
 * alone would permit only ONE seal per model per window. The seal point is
 * therefore encoded in model_version:
 *
 *     model_id      = 'b1-nodrift-diffusion-v1'   (matches fa_ontology_versions.version)
 *     model_version = 'v1@T-10'                   (spec version @ seal point)
 *
 * Rationale for putting it in model_version rather than model_id: model_id
 * stays a clean foreign key onto the frozen ontology row, so scoreboards can
 * group by model without string surgery, while the unique constraint still
 * yields exactly one row per (model, seal point, window). A re-run inserts
 * nothing new — proven in the idempotency test.
 */
export function modelVersionFor(sealLabel, specVersion = 'v1') {
  return `${specVersion}@${sealLabel}`;
}

// ---------------------------------------------------------------------
// Math
// ---------------------------------------------------------------------

/**
 * Standard normal CDF via Abramowitz & Stegun 7.1.26 erf approximation.
 * Max absolute error ~1.5e-7, far below any decision threshold here.
 */
export function normalCdf(x) {
  if (!Number.isFinite(x)) return null;
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y =
    1 -
    ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t +
      0.254829592) *
      t *
      Math.exp(-z * z);
  return 0.5 * (1 + sign * y);
}

export function logit(p) {
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return null;
  return Math.log(p / (1 - p));
}

export function logistic(x) {
  if (!Number.isFinite(x)) return null;
  return 1 / (1 + Math.exp(-x));
}

export function clampP(p) {
  if (!Number.isFinite(p)) return null;
  return Math.min(P_MAX, Math.max(P_MIN, p));
}

// ---------------------------------------------------------------------
// Models
// ---------------------------------------------------------------------

/**
 * Shared diffusion core for B1/B2/B3.
 * @returns {{pass:true,reason:string}|{d_eff:number,d_plain:number,p_eff:number,p_plain:number,...}}
 */
function diffusionCore({ S, K, sigma, tau, driftPerSecond = 0 }) {
  if (!Number.isFinite(S) || S <= 0) return { pass: true, reason: 'replica_index_unavailable' };
  if (!Number.isFinite(K) || K <= 0) return { pass: true, reason: 'strike_unavailable' };
  if (!Number.isFinite(sigma) || sigma <= 0) return { pass: true, reason: 'realized_vol_unavailable' };
  if (!Number.isFinite(tau) || tau <= 0) return { pass: true, reason: 'tau_nonpositive' };

  const tauEff = tau - AVERAGING_CORRECTION_S;
  if (tauEff <= 0) return { pass: true, reason: 'tau_eff_nonpositive' };

  const logMoneyness = Math.log(S / K);

  const denomEff = sigma * Math.sqrt(tauEff);
  const denomPlain = sigma * Math.sqrt(tau);
  if (!(denomEff > 0) || !(denomPlain > 0)) {
    return { pass: true, reason: 'zero_denominator' };
  }

  // Drift enters the NUMERATOR as mu_hat * tau (B2 only; zero for B1/B3).
  const dEff = (logMoneyness + driftPerSecond * tauEff) / denomEff;
  const dPlain = (logMoneyness + driftPerSecond * tau) / denomPlain;

  const pEff = normalCdf(dEff);
  const pPlain = normalCdf(dPlain);
  if (pEff === null) return { pass: true, reason: 'cdf_undefined' };

  return {
    pass: false,
    d_eff: dEff,
    d_plain: dPlain,
    p_eff: pEff,
    p_plain: pPlain,
    tau,
    tau_eff: tauEff,
    sigma,
    log_moneyness: logMoneyness,
    strike_distance_vol_units: Math.abs(logMoneyness) / denomEff,
  };
}

/** B0 — Kalshi up-contract mid. The null baseline. */
export function modelB0({ upMid }) {
  if (!Number.isFinite(upMid)) return { pass: true, reason: 'up_mid_unavailable' };
  return { pass: false, sealed_p: clampP(upMid), diagnostics: { up_mid: upMid } };
}

/** B1 — no-drift diffusion with the settlement-averaging correction. */
export function modelB1({ S, K, sigma, tau }) {
  const core = diffusionCore({ S, K, sigma, tau, driftPerSecond: 0 });
  if (core.pass) return core;
  return {
    pass: false,
    sealed_p: clampP(core.p_eff), // only sigma_eff variant is sealed
    diagnostics: {
      d_eff: core.d_eff,
      d_plain: core.d_plain,
      p_eff: core.p_eff,
      p_plain: core.p_plain, // logged, never sealed
      tau: core.tau,
      tau_eff: core.tau_eff,
      sigma: core.sigma,
      log_moneyness: core.log_moneyness,
      strike_distance_vol_units: core.strike_distance_vol_units,
    },
  };
}

/**
 * B2 — B1 plus drift.
 * mu_hat = signed 5m replica return per minute, capped at +/-1 sigma.
 * Converted to per-second so `mu_hat * tau` is a pure return.
 */
export function modelB2({ S, K, sigma, tau, ret5m }) {
  if (!Number.isFinite(ret5m)) return { pass: true, reason: 'five_min_return_unavailable' };
  if (!Number.isFinite(sigma) || sigma <= 0) {
    return { pass: true, reason: 'realized_vol_unavailable' };
  }

  const muPerMinute = ret5m / 5; // "signed 5m replica return per minute"
  const muPerSecond = muPerMinute / 60; // dimensional consistency with per-second sigma
  const capped = Math.max(-sigma, Math.min(sigma, muPerSecond)); // "capped at +/-1 sigma"

  const core = diffusionCore({ S, K, sigma, tau, driftPerSecond: capped });
  if (core.pass) return core;

  return {
    pass: false,
    sealed_p: clampP(core.p_eff),
    diagnostics: {
      d_eff: core.d_eff,
      d_plain: core.d_plain,
      p_eff: core.p_eff,
      p_plain: core.p_plain,
      mu_per_minute: muPerMinute,
      mu_per_second_raw: muPerSecond,
      mu_per_second_capped: capped,
      mu_was_capped: Math.abs(muPerSecond) > sigma,
      sigma: core.sigma,
      tau_eff: core.tau_eff,
    },
  };
}

/**
 * B3 — B1 tilted by Kalshi book imbalance.
 * imb = (up_bid_depth - down_bid_depth) / sum, within 2c of mid.
 */
export function modelB3({ S, K, sigma, tau, upDepth2c, downDepth2c }) {
  const b1 = modelB1({ S, K, sigma, tau });
  if (b1.pass) return b1;

  if (!Number.isFinite(upDepth2c) || !Number.isFinite(downDepth2c)) {
    return { pass: true, reason: 'book_depth_unavailable' };
  }
  const sum = upDepth2c + downDepth2c;
  if (!(sum > 0)) return { pass: true, reason: 'zero_book_depth' };

  const imb = (upDepth2c - downDepth2c) / sum;

  // logit() of the UNCLAMPED B1 probability would blow up at 0/1; use the
  // clamped sealed value, which is what B1 actually commits to.
  const l = logit(b1.sealed_p);
  if (l === null) return { pass: true, reason: 'logit_undefined' };

  const p = logistic(l + 0.5 * imb);
  if (p === null) return { pass: true, reason: 'logistic_undefined' };

  return {
    pass: false,
    sealed_p: clampP(p),
    diagnostics: {
      b1_p: b1.sealed_p,
      imbalance: imb,
      up_depth_2c: upDepth2c,
      down_depth_2c: downDepth2c,
      logit_b1: l,
      logit_adjusted: l + 0.5 * imb,
    },
  };
}

// ---------------------------------------------------------------------
// Seal orchestration
// ---------------------------------------------------------------------

/**
 * Which seal point (if any) does `secondsToClose` fall in, within tolerance?
 * Returns null outside every window.
 */
export function sealPointFor(secondsToClose) {
  for (const sp of SEAL_POINTS) {
    if (Math.abs(secondsToClose - sp.seconds_to_close) <= SEAL_TOLERANCE_S) return sp;
  }
  return null;
}

/**
 * Build all four model results for one seal moment.
 *
 * @param {object} ctx
 * @param {number} ctx.secondsToClose
 * @param {object} ctx.book       normalised orderbook (up_mid, depths, bids/asks)
 * @param {number} ctx.replica    replica index at seal
 * @param {number} ctx.strike     floor_strike (K)
 * @param {number} ctx.sigma      rolling 15m realized vol (per-second)
 * @param {number} ctx.ret5m      signed 5m replica return
 * @returns {Array<{model_id,result}>}
 */
export function computeAllModels(ctx) {
  const { book = {}, replica, strike, sigma, ret5m, secondsToClose } = ctx;
  const shared = { S: replica, K: strike, sigma, tau: secondsToClose };

  return [
    { model_id: MODEL_IDS.B0, result: modelB0({ upMid: book.up_mid }) },
    { model_id: MODEL_IDS.B1, result: modelB1(shared) },
    { model_id: MODEL_IDS.B2, result: modelB2({ ...shared, ret5m }) },
    {
      model_id: MODEL_IDS.B3,
      result: modelB3({
        ...shared,
        upDepth2c: book.up_depth_2c_bid,
        downDepth2c: book.down_depth_2c_bid,
      }),
    },
  ];
}

/** Executable prices recorded verbatim at the seal moment. */
export function executablePrices(book = {}) {
  return {
    up_bid: book.up_bid ?? null,
    up_ask: book.up_ask ?? null,
    up_bid_size: book.up_bid_size ?? null,
    up_ask_size: book.up_ask_size ?? null,
    up_depth_2c_bid: book.up_depth_2c_bid ?? null,
    up_depth_2c_ask: book.up_depth_2c_ask ?? null,
    down_bid: book.down_bid ?? null,
    down_ask: book.down_ask ?? null,
    down_bid_size: book.down_bid_size ?? null,
    down_ask_size: book.down_ask_size ?? null,
    down_depth_2c_bid: book.down_depth_2c_bid ?? null,
    down_depth_2c_ask: book.down_depth_2c_ask ?? null,
    up_mid: book.up_mid ?? null,
    down_mid: book.down_mid ?? null,
  };
}

/**
 * Build the fa_forecast_seal rows for one seal moment.
 * Models that PASS produce no row — an absent seal is the honest record that
 * the model declined, and the schema forbids a null sealed_p.
 *
 * @returns {{rows:Array<object>, passes:Array<{model_id,reason}>}}
 */
export function buildSealRows(ctx) {
  const { windowId, windowCloseTs, sealPoint, book, sealedAt } = ctx;
  const results = computeAllModels(ctx);
  const prices = executablePrices(book);

  const rows = [];
  const passes = [];

  for (const { model_id, result } of results) {
    if (result.pass) {
      passes.push({ model_id, reason: result.reason });
      continue;
    }
    rows.push({
      model_id,
      model_version: modelVersionFor(sealPoint.label),
      window_id: windowId,
      sealed_p: Number(result.sealed_p.toFixed(6)),
      executable_prices: {
        ...prices,
        seal_point: sealPoint.label,
        seconds_to_close_at_seal: ctx.secondsToClose,
        replica_index: ctx.replica ?? null,
        strike: ctx.strike ?? null,
        sigma_15m: ctx.sigma ?? null,
        diagnostics: result.diagnostics ?? null,
      },
      sealed_at: sealedAt,
      window_close_ts: windowCloseTs,
    });
  }

  return { rows, passes };
}

// ---------------------------------------------------------------------
// Grading (stats-rules v1)
// ---------------------------------------------------------------------

/** Brier score for a binary outcome. */
export function brier(p, outcomeYes) {
  if (!Number.isFinite(p)) return null;
  const y = outcomeYes ? 1 : 0;
  return (p - y) ** 2;
}

/** Log loss, guarded against infinities by the [0.01,0.99] seal clamp. */
export function logLoss(p, outcomeYes) {
  if (!Number.isFinite(p) || p <= 0 || p >= 1) return null;
  return outcomeYes ? -Math.log(p) : -Math.log(1 - p);
}

/**
 * Actionable threshold, stats-rules v1:
 *   "divergence >= exact_fee + half_spread + 1pp at executable prices"
 *
 * exact_fee is the per-contract taker fee in dollars, which for a $1-notional
 * binary contract IS the fee in probability points.
 */
export function actionableThreshold({ price, halfSpread, takerFeeFn }) {
  if (!Number.isFinite(price) || !Number.isFinite(halfSpread)) return null;
  const fee = takerFeeFn({ price, contracts: 1 });
  if (!Number.isFinite(fee)) return null;
  return fee + halfSpread + 0.01;
}
