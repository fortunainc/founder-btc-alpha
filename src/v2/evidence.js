/**
 * BTC Alpha V2.1 — evidence adapter.
 *
 * Maps the live context (price S, strike K, time τ, volatility, bar buffer) and
 * the family readings into the Arbiter's input: the reachability z-score, the
 * volatility regime, an event flag, a breakout flag, and the per-factor evidence
 * vector. This is the ONLY place families are translated into arbiter evidence,
 * so new factors (order flow, VWAP, S/R, MTF) slot in here as they are built.
 *
 * Nothing here reads Kalshi price. Pure and deterministic.
 */

import { f3Momentum, f4Volatility } from './families.js';
import { f2Structure } from './structure.js';

export const WARMUP_MS = 15 * 60_000;

/** Distance to strike in expected-move units: z = (S−K) / (S·σ·√τ). null if unpriceable. */
export function zScore(S, K, sigmaPerSec, tauSec) {
  if (!(S > 0) || !(K > 0) || !(sigmaPerSec > 0) || !(tauSec > 0)) return null;
  const expMove = S * sigmaPerSec * Math.sqrt(tauSec);
  return expMove > 0 ? (S - K) / expMove : null;
}

/** True once there is enough warm history and valid inputs to make a disciplined call. */
export function dataReady(ctx) {
  const warm = ctx.bars && typeof ctx.bars.isWarm === 'function' ? ctx.bars.isWarm(WARMUP_MS, ctx.now) : false;
  return !!warm && ctx.S > 0 && ctx.K > 0 && ctx.tauSec > 0 && ctx.sigmaPerSec > 0;
}

/** Build the arbiter input from the sealed context. */
export function buildArbiterInput(ctx, opts = {}) {
  const f3 = f3Momentum(ctx);
  const f4 = f4Volatility(ctx);
  const f2 = f2Structure(ctx);

  const momSide = f3.vote === 'long' ? 'yes' : f3.vote === 'short' ? 'no' : 'flat';
  const evidence = {
    // ACTIVE today (from data we already have):
    momentum: momSide === 'flat' ? null
      : { side: momSide, strength: Number(f3.confidence.toFixed(3)), leading: true,
          consistent: (f3.detail && f3.detail.consistency != null ? f3.detail.consistency : 0) >= 0.5 },
    structure: f2.side === 'flat' ? null
      : { side: f2.side, strength: f2.strength, trend: f2.trend, leading: false },
    // RESERVED — slot in as each factor is built (order flow, VWAP, S/R, MTF, liquidity):
    order_flow: null, vwap: null, liquidity: null, s_r: null, mtf: null,
  };

  return {
    z: zScore(ctx.S, ctx.K, ctx.sigmaPerSec, ctx.tauSec),
    tauSec: ctx.tauSec,
    volRegime: (f4.detail && f4.detail.regime) || 'steady',
    eventFlag: !!opts.macroEvent,
    breakout: f2.breakout || null,
    evidence,
    readings: { structure: f2.reading, momentum: f3.reading, volatility: f4.reading },
  };
}

export default buildArbiterInput;
