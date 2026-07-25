/**
 * TSM founder-mode / access-and-operating-model configuration.
 *
 * TSM is an INTELLIGENCE / ANALYSIS / RECOMMENDATION platform. It recommends,
 * explains, references an observable market price, states expected economics, and
 * TRACKS how each recommendation subsequently performed. It does NOT place orders,
 * hold assets, move capital, or execute anything. There is no order-entry code in
 * this repository by construction (see kalshi-client.js assertReadOnly denylist).
 *
 * Four INDEPENDENT axes. Changing one must never change another:
 *   - Founder visibility   (what the founder can see)       -> SIGNAL_VISIBILITY
 *   - Validation authority (whether evidence counts)        -> VALIDATION_MODE + per-engine clock
 *   - Beta access          (whether any other human sees)   -> INVITE_ACCESS / CUSTOMER_RELEASE_STATUS
 *   - Capital authority    (whether TSM may act on money)   -> CAPITAL_AUTHORITY / ORDER_EXECUTION
 *
 * "Shadow / validation" must NOT hide, suppress, or dilute the founder experience:
 * the founder sees FULL signal visibility now. Suppression is replaced by labeling.
 */
export const FOUNDER_MODE = Object.freeze({
  ACCESS_MODE: 'FOUNDER_ONLY',
  SIGNAL_VISIBILITY: 'FULL',
  INVITE_ACCESS: 'DISABLED',
  ORDER_EXECUTION: 'NOT_SUPPORTED', // structural: no order-placement code exists
  CAPITAL_AUTHORITY: 'NONE',
  VALIDATION_MODE: 'ACTIVE',
  CUSTOMER_RELEASE_STATUS: 'NOT_RELEASED',
});

export const FOUNDER_BANNER =
  'FOUNDER-ONLY RESEARCH · VALIDATION IN PROGRESS — TSM recommends and tracks; it does not place orders, hold assets, or move capital.';

export const RESEARCH_CHIP = 'FOUNDER-ONLY';

export default FOUNDER_MODE;
