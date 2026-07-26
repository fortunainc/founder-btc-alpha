// v2.4 position manager (frozen policy v1): pre/post-entry distinction, exit
// precedence, liquidity honesty, dual-scorecard economics. The Day-1 market's
// revisions are replayed as the canonical DIAGNOSTIC (labeled, not official).
import test from 'node:test';
import assert from 'node:assert/strict';
import { instructionFor, manageMarket, PM_POLICY } from '../../src/v2/technical/position-manager.js';

const R = (seq, rec, { vote = -0.5, conv = 0.5, tau = 600, up_bid = 0.30, down_bid = 0.65 } = {}) =>
  ({ revision_seq: seq, evaluated_at: `2026-07-26T17:0${seq}:00Z`, recommendation: rec, vote, conviction: conv, tau_sec: tau, up_bid, down_bid });

test('post-entry mapping: WAIT with intact thesis → HOLD; WAIT with collapsed conviction → EXIT; opposite signal → EXIT_IMMEDIATELY; τ<90s → HOLD_TO_RESOLUTION', () => {
  assert.equal(instructionFor(R(2, 'WAIT', { vote: -0.45 }), 'NO').action, 'HOLD', 'price-side WAIT ≠ exit');
  assert.equal(instructionFor(R(3, 'WAIT', { vote: -0.1, conv: 0.1 }), 'NO').action, 'EXIT', 'thesis collapse → exit');
  assert.equal(instructionFor(R(3, 'NO_TRADE', { vote: 0.3 }), 'NO').action, 'EXIT', 'vote flipped against NO');
  assert.equal(instructionFor(R(4, 'YES', { vote: 0.5 }), 'NO').action, 'EXIT_IMMEDIATELY');
  assert.equal(instructionFor(R(5, 'NO', { vote: -0.6 }), 'NO').action, 'HOLD');
  assert.equal(instructionFor(R(6, 'WAIT', { tau: 70 }), 'NO').action, 'HOLD_TO_RESOLUTION');
  assert.equal(instructionFor(R(7, 'NO', { down_bid: 0.93, vote: -0.6 }), 'NO').action, 'TAKE_PROFIT');
  const noLiq = instructionFor(R(8, 'NO_TRADE', { vote: 0.1, conv: 0.05, down_bid: null }), 'NO');
  assert.equal(noLiq.action, 'HOLD_TO_RESOLUTION');
  assert.equal(noLiq.liquidity_unavailable, true, 'never fabricate an exit fill');
});

test('Day-1 market replay (DIAGNOSTIC): NO entry @0.70; rev3 conviction collapse → EXIT; managed loss smaller than held loss', () => {
  // Mirrors KXBTC15M-26JUL261315-15: NO(.5) → NO(.55) → WAIT(.25 collapse) → ...
  const revs = [
    R(1, 'NO', { vote: -0.5, conv: 0.5, down_bid: 0.68 }),
    R(2, 'NO', { vote: -0.55, conv: 0.55, down_bid: 0.72 }),
    R(3, 'WAIT', { vote: -0.12, conv: 0.12, down_bid: 0.55 }),   // collapse → EXIT @0.55
    R(4, 'WAIT', { vote: -0.5, conv: 0.5, down_bid: 0.45 }),
    R(5, 'NO_TRADE', { vote: -0.05, conv: 0.05, down_bid: 0.30 }),
  ];
  const m = manageMarket({ revisions: revs, official: { revision_seq: 1, side: 'NO', entry_ask: 0.70 }, outcome: 'yes' });
  assert.equal(m.entered, true);
  assert.equal(m.exit.at_seq, 3);
  assert.equal(m.exit.action, 'EXIT');
  // held: 0 − (0.70+fee 0.02) = −0.72 (the real Day-1 signal loss)
  assert.equal(m.held_to_resolution_net, -0.72);
  // managed: exit proceeds 0.55 − fee(0.55)=0.02 → 0.53; net = 0.53 − 0.72 = −0.19
  assert.equal(m.managed_net, -0.19);
  assert.equal(m.exit_helped, true, 'this is DIAGNOSTIC replay only — official managed record starts prospectively');
  assert.ok(m.mfe_bid >= 0.72 && m.mae_bid <= 0.30);
});

test('scorecards stay separable: signal result (held-to-resolution) and managed result are both reported, never merged', () => {
  const revs = [R(1, 'NO', {}), R(2, 'NO', { down_bid: 0.75 })];
  const m = manageMarket({ revisions: revs, official: { revision_seq: 1, side: 'NO', entry_ask: 0.60 }, outcome: 'no' });
  assert.equal(m.exit, null, 'no exit triggered');
  assert.equal(m.signal_correct, true);
  assert.equal(m.held_to_resolution_net, m.managed_net, 'no exit → identical; still reported as two fields');
  assert.ok(m.held_to_resolution_net > 0);
});

test('no official entry → no managed trade; unresolved market → no result claimed', () => {
  assert.equal(manageMarket({ revisions: [R(1, 'WAIT', {})], official: null }).entered, false);
  const m = manageMarket({ revisions: [R(1, 'NO', {}), R(2, 'NO', {})], official: { revision_seq: 1, side: 'NO', entry_ask: 0.6 }, outcome: null });
  assert.equal(m.managed_net, null);
  assert.equal(m.signal_correct, null);
});
