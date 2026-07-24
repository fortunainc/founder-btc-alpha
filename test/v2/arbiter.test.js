import test from 'node:test';
import assert from 'node:assert/strict';
import { arbitrate, reachability, classifyRegime, signatureFor, FACTORS, MATRIX_VERSION } from '../../src/v2/arbiter.js';

// Shorthand evidence builder
const E = (side, strength, extra = {}) => ({ side, strength, ...extra });

test('reachability: buckets + monotonic contestedness', () => {
  assert.equal(reachability(2).bucket, 'decided_above');
  assert.equal(reachability(-2).bucket, 'decided_below');
  assert.equal(reachability(0).bucket, 'contested');
  assert.equal(reachability(0).contestedness, 1);
  assert.ok(reachability(0.5).contestedness > reachability(1.2).contestedness);
  assert.equal(reachability(2).contestedness, 0);
});

test('classifyRegime: event / breakout / trend / range', () => {
  assert.equal(classifyRegime({ eventFlag: true, evidence: {} }), 'event');
  assert.equal(classifyRegime({ breakout: { active: true }, evidence: {} }), 'breakout');
  assert.equal(classifyRegime({ volRegime: 'expanding',
    evidence: { structure: E('yes', 0.6, { trend: true }), momentum: E('yes', 0.6, { consistent: true }) } }), 'trend');
  assert.equal(classifyRegime({ volRegime: 'contracting',
    evidence: { momentum: E('yes', 0.7) } }), 'range');
  assert.equal(classifyRegime({ volRegime: 'steady', evidence: { momentum: E('yes', 0.1) } }), 'range');
});

// ── THE THESIS: same conflict, opposite call by regime ──────────────────────────
const CONFLICT = { momentum: E('yes', 0.7), structure: E('no', 0.5, { trend: true }) };

test('THESIS · momentum-YES vs structure-NO resolves TAKE_YES in a TREND', () => {
  const r = arbitrate({ z: 0, volRegime: 'expanding', evidence: { ...CONFLICT } });
  assert.equal(r.regime, 'trend');
  assert.equal(r.decision, 'TAKE_YES', 'in a trend, dominant momentum wins; structure is a pullback');
});

test('THESIS · the SAME conflict resolves TAKE_NO in a RANGE', () => {
  const r = arbitrate({ z: 0, volRegime: 'contracting', evidence: { ...CONFLICT } });
  assert.equal(r.regime, 'range');
  assert.equal(r.decision, 'TAKE_NO', 'in a range, momentum is exhaustion; structure + mean-reversion win');
});

test('abstains (NO_TRADE) when contested evidence is genuinely split', () => {
  const r = arbitrate({ z: 0, volRegime: 'contracting',
    evidence: { order_flow: E('yes', 0.6), s_r: E('no', 0.6) } });
  assert.equal(r.bucket, 'contested');
  assert.equal(r.decision, 'NO_TRADE');
});

test('reachability override: DECIDED window takes the reachable side on weak evidence', () => {
  const r = arbitrate({ z: 2, volRegime: 'steady', evidence: { momentum: E('no', 0.2) } });
  assert.equal(r.bucket, 'decided_above');
  assert.equal(r.decision, 'TAKE_YES');
});

test('reachability override: a strong LEADING opposing push + expanding vol → NO_TRADE', () => {
  const r = arbitrate({ z: 2, volRegime: 'expanding',
    evidence: { order_flow: E('no', 0.7, { leading: true }) } });
  assert.equal(r.bucket, 'decided_above');
  assert.equal(r.decision, 'NO_TRADE');
});

test('event regime while contested → NO_TRADE', () => {
  const r = arbitrate({ z: 0, eventFlag: true, volRegime: 'expanding',
    evidence: { momentum: E('yes', 0.9) } });
  assert.equal(r.regime, 'event');
  assert.equal(r.decision, 'NO_TRADE');
});

test('unconfirmed breakout is treated as a trap (fade)', () => {
  // up-breakout with NO order-flow confirmation ⇒ structure flips to fade (no)
  const r = arbitrate({ z: 0, volRegime: 'expanding',
    breakout: { active: true, side: 'yes' },
    evidence: { momentum: E('yes', 0.4) } });
  assert.equal(r.regime, 'breakout');
  assert.ok(r.ledger.evidence, 'ledger present');
  // no confirming order flow → the arbiter should not take YES on the raw break
  assert.notEqual(r.decision, 'TAKE_YES');
});

test('conflict signature is canonical + order-independent', () => {
  const a = signatureFor('range', 'contested', { momentum: E('yes', 0.7), structure: E('no', 0.5) });
  const b = signatureFor('range', 'contested', { structure: E('no', 0.5), momentum: E('yes', 0.7) });
  assert.equal(a, b);
  assert.match(a, /range·contested·YES=\{momentum:hi\}·NO=\{structure:md\}/);
});

test('ledger record is well-formed and carries NO Kalshi/market fields', () => {
  const r = arbitrate({ z: 0, volRegime: 'contracting', evidence: { ...CONFLICT } });
  const L = r.ledger;
  assert.equal(L.matrix_version, MATRIX_VERSION);
  assert.ok(['trend', 'range', 'breakout', 'event'].includes(L.regime));
  assert.ok(['decided_above', 'contested', 'decided_below'].includes(L.reachability_bucket));
  assert.equal(Object.keys(L.evidence).length, FACTORS.length, 'all 7 factor slots recorded (null if absent)');
  assert.ok(typeof L.conflict_signature === 'string' && L.conflict_signature.length > 0);
  assert.ok(['TAKE_YES', 'TAKE_NO', 'NO_TRADE'].includes(L.decision));
  assert.ok(Number.isFinite(L.conviction) && Number.isFinite(L.agreement));
  const keys = JSON.stringify(L).toLowerCase();
  assert.ok(!keys.includes('kalshi') && !keys.includes('market_p') && !keys.includes('divergence'),
    'the arbiter never references Kalshi price');
});
