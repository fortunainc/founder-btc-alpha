/**
 * BTC v2.4 POSITION MANAGER — companion experiment btc-v24-position-manager-e1
 * (founder directive 2026-07-26, post-Day-1). READ-ONLY consumer of v2.4's
 * IMMUTABLE revisions — it never writes to, alters, or influences the frozen
 * signal engine or its 0/1 record.
 *
 * ██ FROZEN POLICY v1 (pre-registered BEFORE any managed grading; changing any
 * ██ number below = a NEW experiment version, never an edit) ██
 *
 * ENTRY (mirrors the signal engine's official call — no separate entry rule):
 *   qualifying entry = v2.4 official call (first actionable YES/NO meeting the
 *   executable entry); modeled entry price = that revision's side ASK; entry
 *   fee = kalshiFee(ask). No entry if the official call never fires.
 *
 * POST-ENTRY instruction per subsequent revision, precedence order:
 *   1. tau < 90s                            → HOLD_TO_RESOLUTION (terminal; no
 *      reliable execution inside the cutoff — same 90s bound the signal engine uses)
 *   2. opposite actionable signal (conv≥.25) → EXIT_IMMEDIATELY @ side bid
 *   3. side bid ≥ 0.90                      → TAKE_PROFIT @ side bid (residual
 *      upside < round-trip friction)
 *   4. same-side actionable signal          → HOLD
 *   5. WAIT/NO_TRADE, vote still on our side AND |vote| ≥ 0.20
 *                                           → HOLD (entry PRICE unattractive for
 *      new money ≠ thesis dead for held money)
 *   6. WAIT/NO_TRADE, vote flipped OR |vote| < 0.20
 *                                           → EXIT @ side bid (thesis deteriorated)
 *   7. side bid unavailable                 → HOLD_TO_RESOLUTION, liquidity flag
 *      (never fabricate an exit fill)
 *   No price-only stop-loss in v1 (exits are evidence-driven; max loss = entry
 *   cost). No FLIP, no adds — separate policies if ever justified.
 *
 * ECONOMICS: exit proceeds = bid − kalshiFee(bid); resolution pays $1 correct /
 * $0 incorrect; MFE/MAE tracked from per-revision side-bid marks. Spread cost is
 * inherent (enter at ask, exit at bid); no additional slippage modeled — bids
 * are top-of-book executable marks.
 *
 * OFFICIAL managed grading is PROSPECTIVE: only markets whose official call
 * seals AFTER the registry SHADOW timestamp count. Earlier markets (incl. the
 * Day-1 −$0.72 loss) may be REPLAYED for diagnostics, clearly labeled.
 */
import { kalshiFee } from '../engine.js';

export const PM_POLICY_VERSION = 'v24-position-manager-v1';
export const PM_POLICY = Object.freeze({
  cutoff_tau_sec: 90, exit_conviction_floor: 0.20, opposite_conviction: 0.25, take_profit_bid: 0.90,
});

const fin = (v) => (v == null || v === '' ? null : (Number.isFinite(Number(v)) ? Number(v) : null));
const sideBid = (rev, side) => fin(side === 'YES' ? rev.up_bid : rev.down_bid);

/** Instruction for ONE revision given an open position. Pure. */
export function instructionFor(rev, side) {
  const bid = sideBid(rev, side);
  const tau = fin(rev.tau_sec);
  const vote = fin(rev.vote);
  const conv = fin(rev.conviction) ?? 0;
  const rec = rev.recommendation;
  const ourSign = side === 'YES' ? 1 : -1;
  if (tau != null && tau < PM_POLICY.cutoff_tau_sec) return { action: 'HOLD_TO_RESOLUTION', reason: `inside the ${PM_POLICY.cutoff_tau_sec}s execution cutoff — ride to settlement`, exec_bid: null };
  if ((rec === 'YES' || rec === 'NO') && rec !== side && conv >= PM_POLICY.opposite_conviction) {
    return bid != null ? { action: 'EXIT_IMMEDIATELY', reason: `engine now signals ${rec} against the position (conviction ${(conv * 100).toFixed(0)}%)`, exec_bid: bid }
      : { action: 'HOLD_TO_RESOLUTION', reason: 'reversal signal but NO executable bid — never fabricate a fill', exec_bid: null, liquidity_unavailable: true };
  }
  if (bid != null && bid >= PM_POLICY.take_profit_bid) return { action: 'TAKE_PROFIT', reason: `position bid ${(bid * 100).toFixed(0)}¢ — remaining upside smaller than round-trip friction`, exec_bid: bid };
  if (rec === side) return { action: 'HOLD', reason: 'signal re-affirmed the position side', exec_bid: null };
  const thesisIntact = vote != null && Math.sign(vote) === ourSign && Math.abs(vote) >= PM_POLICY.exit_conviction_floor;
  if ((rec === 'WAIT' || rec === 'NO_TRADE') && thesisIntact) {
    return { action: 'HOLD', reason: `${rec} is about NEW entries (price/confirmation) — the directional thesis still points ${side} (vote ${vote.toFixed(2)})`, exec_bid: null };
  }
  if (bid == null) return { action: 'HOLD_TO_RESOLUTION', reason: 'thesis deteriorated but no executable bid — cannot model an exit', exec_bid: null, liquidity_unavailable: true };
  return { action: 'EXIT', reason: `thesis deteriorated: ${vote == null ? 'no vote' : `vote ${vote.toFixed(2)}`}${conv < PM_POLICY.exit_conviction_floor ? `, conviction ${(conv * 100).toFixed(0)}% below the ${PM_POLICY.exit_conviction_floor * 100}% floor` : ' flipped against the position'}`, exec_bid: bid };
}

/**
 * manageMarket — full managed journey for one market. Pure + deterministic.
 * @param revisions all v2.4 revisions for the window (ascending seq)
 * @param official  the official-call revision info {revision_seq, side:'YES'|'NO', entry_ask}
 * @param outcome   'yes' | 'no' | null (unresolved)
 */
export function manageMarket({ revisions = [], official = null, outcome = null } = {}) {
  if (!official) return { entered: false, reason: 'no qualifying official entry' };
  const side = official.side;
  const entryAsk = fin(official.entry_ask);
  if (entryAsk == null) return { entered: false, reason: 'official entry ask missing' };
  const entryCost = entryAsk + kalshiFee(entryAsk);
  const later = revisions.filter((r) => r.revision_seq > official.revision_seq).sort((a, b) => a.revision_seq - b.revision_seq);
  const timeline = [];
  let exit = null; let mfe = null, mae = null;
  for (const r of later) {
    const mark = sideBid(r, side);
    if (mark != null) { mfe = mfe == null ? mark : Math.max(mfe, mark); mae = mae == null ? mark : Math.min(mae, mark); }
    const ins = instructionFor(r, side);
    timeline.push({ revision_seq: r.revision_seq, evaluated_at: r.evaluated_at, action: ins.action, reason: ins.reason, mark });
    if (!exit && (ins.action === 'EXIT' || ins.action === 'EXIT_IMMEDIATELY' || ins.action === 'TAKE_PROFIT')) {
      exit = { at_seq: r.revision_seq, at: r.evaluated_at, action: ins.action, bid: ins.exec_bid, proceeds: ins.exec_bid - kalshiFee(ins.exec_bid) };
    }
    if (ins.action === 'HOLD_TO_RESOLUTION') break; // terminal
  }
  const round4 = (v) => Number(v.toFixed(4));
  let managedNet = null, heldNet = null, exitHelped = null;
  const won = outcome != null ? ((side === 'YES') === (outcome === 'yes')) : null;
  if (outcome != null) {
    heldNet = round4((won ? 1 : 0) - entryCost);
    managedNet = exit ? round4(exit.proceeds - entryCost) : heldNet;
    if (exit) exitHelped = managedNet > heldNet;
  }
  return {
    policy: PM_POLICY_VERSION, entered: true, side,
    entry: { ask: entryAsk, fee: round4(kalshiFee(entryAsk)), cost: round4(entryCost), at_seq: official.revision_seq },
    timeline, exit,
    mfe_bid: mfe, mae_bid: mae,
    outcome, signal_correct: won,
    held_to_resolution_net: heldNet, managed_net: managedNet, exit_helped: exitHelped,
  };
}
