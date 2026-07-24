/**
 * BTC Alpha V2.2 — profit selection (expected-dollar objective).
 *
 * The v2.1 Arbiter picks by CONVICTION — where the mispricing/edge is. v2.2 picks
 * by EXPECTED NET DOLLARS after fees + spread: it takes the side whose
 * probability-weighted payoff beats its executable ask + fee by at least a margin,
 * and ABSTAINS when neither side is positive-EV — even when the directional signal
 * is strong. "Right" is not the objective; "profitable after costs" is. This is the
 * exact gap the shadow ledger shows: v2.1 finds disagreements, but a disagreement the
 * market already priced is not money.
 *
 * Buying YES at ask a_y (pay a_y, settle $1 if BTC>strike):
 *   EV_yes = p*(1 - a_y) - (1 - p)*a_y - fee(a_y) = p - a_y - fee(a_y)
 * Symmetrically  EV_no = (1 - p) - a_n - fee(a_n),  p = P(settle above strike).
 *
 * Pure and deterministic: no I/O, no clock.
 */

export const PROFIT_SPEC_VERSION = 'v2.2.0';
export const PROFIT_ENGINE_ID = 'btc-alpha-v2-profit';

/** FROZEN profit params. MIN_EDGE is the $/contract expected-value margin a side must
 *  clear to be worth taking — it absorbs model error, adverse selection, and the fact
 *  the fill is at the ask (not the mid). */
export const PROFIT_PARAMS = Object.freeze({ MIN_EDGE: 0.02 });

const validPrice = (a) => Number.isFinite(a) && a > 0 && a < 1;
const fmt = (v) => (v == null ? '—' : `$${v.toFixed(3)}`);

/**
 * @param {object} args
 * @param {number|null} args.p_yes    model probability BTC settles above strike (0..1)
 * @param {number|null} args.up_ask   executable YES ask (0..1)
 * @param {number|null} args.down_ask executable NO ask (0..1)
 * @param {(price:number)=>number} args.feeFn  $/contract taker fee at a price
 * @param {number} [args.minEdge]
 * @returns {{recommendation,status,ev_yes,ev_no,chosen_ev,p_yes,min_edge,reason}}
 */
export function selectProfit({ p_yes, up_ask, down_ask, feeFn, minEdge = PROFIT_PARAMS.MIN_EDGE }) {
  const na = (reason, status = 'no_forecast_data') => ({
    recommendation: 'NO_TRADE', status,
    ev_yes: null, ev_no: null, chosen_ev: null,
    p_yes: Number.isFinite(p_yes) ? p_yes : null, min_edge: minEdge, reason,
  });
  if (!Number.isFinite(p_yes) || p_yes <= 0 || p_yes >= 1) return na('No usable probability forecast — staying out.');
  const fee = (a) => { try { return Number(feeFn(a)) || 0; } catch { return 0; } };

  const ev_yes = validPrice(up_ask)   ? Number((p_yes - up_ask - fee(up_ask)).toFixed(6))         : null;
  const ev_no  = validPrice(down_ask) ? Number(((1 - p_yes) - down_ask - fee(down_ask)).toFixed(6)) : null;
  if (ev_yes == null && ev_no == null) return na('No executable price on either side.');

  const cand = [];
  if (ev_yes != null) cand.push(['TAKE_YES', ev_yes]);
  if (ev_no  != null) cand.push(['TAKE_NO',  ev_no]);
  cand.sort((a, b) => b[1] - a[1]);
  const [side, ev] = cand[0];

  if (ev < minEdge) {
    return {
      recommendation: 'NO_TRADE', status: 'ok', ev_yes, ev_no, chosen_ev: ev, p_yes, min_edge: minEdge,
      reason: `Best expected value ${fmt(ev)}/contract is below the ${fmt(minEdge)} margin after fees — the market has already priced it. No trade.`,
    };
  }
  return {
    recommendation: side, status: 'ok', ev_yes, ev_no, chosen_ev: ev, p_yes, min_edge: minEdge,
    reason: `${side === 'TAKE_YES' ? 'YES' : 'NO'} carries a positive expected value of ${fmt(ev)}/contract after fees (model ${(p_yes * 100).toFixed(1)}% vs the ask) — take it.`,
  };
}

export default selectProfit;
