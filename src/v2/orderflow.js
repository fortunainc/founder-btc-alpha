/**
 * BTC Alpha V2.1 — order flow (F5), from the trade tape.
 *
 * Reads recent aggressor imbalance: net taker buying vs selling. Sustained
 * one-sided aggression is the strongest short-horizon directional tell. When
 * aggression is heavy but price barely moves, the flow is being ABSORBED — a
 * reversal signal, so the vote flips to the fading side. Pure and deterministic.
 *
 * Emits the arbiter evidence shape { key:'F5_order_flow', side, strength, leading, ... }
 * where 'yes' favors BTC finishing ABOVE the strike (net buying).
 */

const WINDOW_MS = 60_000;
const MIN_TRADES = 8;            // below this the read is noise → flat
const TARGET_RATE = 1.0;         // ~1 trade/sec ⇒ full activity weight
const ABSORB_IMB = 0.5;          // this lopsided...
const ABSORB_MOVE_BPS = 3;       // ...yet price moved < 3 bps ⇒ absorption

const clamp01 = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);

export function f5OrderFlow(ctx) {
  const tape = ctx && ctx.tape;
  const now = ctx && ctx.now;
  const flat = (reading, detail = {}) => ({ key: 'F5_order_flow', side: 'flat', strength: 0, leading: true, reading, detail });
  if (!tape || typeof tape.imbalance !== 'function') return flat('order flow: no trade feed');

  const n = tape.count(WINDOW_MS, now);
  if (n < MIN_TRADES) return flat('order flow: too few trades to read', { n });

  const imb = tape.imbalance(WINDOW_MS, now);           // -1..1
  const rate = tape.rate(WINDOW_MS, now);
  const pc = tape.priceChange(WINDOW_MS, now);
  const vwapNow = tape.vwap(WINDOW_MS, now);
  const activity = clamp01(rate / TARGET_RATE);
  const moveBps = (pc != null && vwapNow) ? Math.abs(pc) / vwapNow * 10_000 : null;

  // Absorption: heavy one-sided aggression that fails to move price ⇒ fade it.
  const absorbing = Math.abs(imb) >= ABSORB_IMB && moveBps != null && moveBps < ABSORB_MOVE_BPS;

  let side, strength, reading;
  if (absorbing) {
    side = imb > 0 ? 'no' : 'yes'; // buyers absorbed ⇒ down; sellers absorbed ⇒ up
    strength = clamp01(0.4 * activity + 0.2);
    reading = `order flow: ${imb > 0 ? 'buying' : 'selling'} absorbed (no follow-through) — fade`;
  } else {
    side = imb > 0 ? 'yes' : imb < 0 ? 'no' : 'flat';
    strength = clamp01(Math.abs(imb) * (0.5 + 0.5 * activity));
    reading = side === 'flat' ? 'order flow: balanced'
      : `order flow: net ${imb > 0 ? 'buying' : 'selling'} (${(imb * 100).toFixed(0)}%)`;
  }
  if (side === 'flat') strength = 0;

  return {
    key: 'F5_order_flow', side, strength: Number(strength.toFixed(3)), leading: true,
    reading,
    detail: { imbalance: Number(imb.toFixed(3)), rate: Number(rate.toFixed(2)), n, move_bps: moveBps != null ? Number(moveBps.toFixed(1)) : null, absorbing },
  };
}

export default f5OrderFlow;
