import test from 'node:test';
import assert from 'node:assert/strict';
import { BarBuilder } from '../../src/v2/bars.js';
import { f1Distance, f7DistanceVsTime, f8Kalshi } from '../../src/v2/families.js';
import { decide } from '../../src/v2/decision.js';

const T0 = 1_700_000_000_000;

// Build >=16 min of warm history that moves linearly from `start` to `end`.
function warmBars(start, end, minutes = 16, stepSec = 10) {
  const b = new BarBuilder();
  const n = Math.round((minutes * 60) / stepSec);
  for (let i = 0; i <= n; i += 1) b.add(T0 + i * stepSec * 1000, start + (end - start) * (i / n));
  return { bars: b, now: T0 + n * stepSec * 1000 };
}
// vol calibrated so the F7 projected band ≈ $18 at tau=720s for price S
const lowVol = (S) => 18 / (S * Math.sqrt(720));

// ---- BarBuilder ---------------------------------------------------------

test('BarBuilder: returnOver, warmth, realized vol', () => {
  const { bars, now } = warmBars(64000, 65000);
  const r60 = bars.returnOver(60_000, now);
  assert.ok(r60 > 0, 'rising series => positive return');
  assert.equal(bars.isWarm(15 * 60_000, now), true);
  const fresh = new BarBuilder();
  fresh.add(T0, 64000); fresh.add(T0 + 1000, 64010);
  assert.equal(fresh.isWarm(15 * 60_000, T0 + 1000), false);
  const vol = bars.realizedVolPerSec(600_000, 30_000, now);
  assert.ok(vol != null && Number.isFinite(vol) && vol >= 0);
  assert.equal(fresh.realizedVolPerSec(600_000, 30_000, T0 + 1000), null);
});

// ---- F1 distance --------------------------------------------------------

test('F1: distance to strike is signed (above>0 when S>K)', () => {
  const a = f1Distance({ S: 65200, K: 65135, tauSec: 720 });
  assert.equal(a.detail.above, 65200 - 65135);
  assert.equal(a.detail.side, 'above');
  const b = f1Distance({ S: 65088, K: 65135, tauSec: 720 });
  assert.equal(b.detail.side, 'below');
  assert.equal(b.vote, 'neutral'); // context family
});

// ---- F7 hard gate -------------------------------------------------------

test('F7: below strike by $47 with a ±$18 band => YES implausible, votes short', () => {
  const S = 65088, K = 65135;
  const f7 = f7DistanceVsTime({ S, K, tauSec: 720, sigmaPerSec: lowVol(S) });
  assert.equal(f7.detail.currentSide, 'NO');
  assert.ok(Math.abs(f7.detail.projected - 18) < 0.5);
  assert.equal(f7.detail.yesPlausible, false);
  assert.equal(f7.detail.noPlausible, true);
  assert.equal(f7.vote, 'short');
});

test('F7: near the strike, both sides are plausible', () => {
  const S = 65130, K = 65135;
  const f7 = f7DistanceVsTime({ S, K, tauSec: 720, sigmaPerSec: lowVol(S) });
  assert.equal(f7.detail.yesPlausible, true);
  assert.equal(f7.detail.noPlausible, true);
  assert.equal(f7.vote, 'neutral');
});

// ---- F8 cost veto -------------------------------------------------------

test('F8: ask above the ceiling fails costOk', () => {
  const ok = f8Kalshi({ market_p: 0.4, up_ask: 0.50, down_ask: 0.54, half_spread: 0.01 }, 'long');
  assert.equal(ok.detail.costOk, true);
  const bad = f8Kalshi({ market_p: 0.4, up_ask: 0.97, down_ask: 0.06, half_spread: 0.01 }, 'long');
  assert.equal(bad.detail.costOk, false);
  const wide = f8Kalshi({ market_p: 0.4, up_ask: 0.50, down_ask: 0.54, half_spread: 0.09 }, 'long');
  assert.equal(wide.detail.costOk, false);
});

// ---- decide() end-to-end -----------------------------------------------

test('decide: cold (no warm history) => NO_TRADE, honest abstention', () => {
  const b = new BarBuilder();
  b.add(T0, 65088); b.add(T0 + 1000, 65090);
  const d = decide({ S: 65088, K: 65135, tauSec: 720, bars: b, sigmaPerSec: lowVol(65088),
    market_p: 0.30, up_ask: 0.34, down_ask: 0.68, half_spread: 0.02, now: T0 + 1000 });
  assert.equal(d.recommendation, 'NO_TRADE');
  assert.equal(d.status, 'no_forecast_data');
});

test('decide: founder example (below strike, flat) => TAKE_NO', () => {
  const { bars, now } = warmBars(65088, 65088);
  const d = decide({ S: 65088, K: 65135, tauSec: 720, bars, sigmaPerSec: lowVol(65088),
    market_p: 0.30, up_ask: 0.34, down_ask: 0.68, half_spread: 0.02, now });
  assert.equal(d.recommendation, 'TAKE_NO');
  assert.match(d.reason, /Recommendation: TAKE NO\./);
});

test('decide: near strike with rising momentum => TAKE_YES', () => {
  const { bars, now } = warmBars(64800, 65130); // ends near the strike, trending up
  const d = decide({ S: 65130, K: 65135, tauSec: 720, bars, sigmaPerSec: lowVol(65130),
    market_p: 0.48, up_ask: 0.50, down_ask: 0.54, half_spread: 0.01, now });
  assert.equal(d.recommendation, 'TAKE_YES');
});

test('decide: near strike but flat => NO_TRADE (no conviction)', () => {
  const { bars, now } = warmBars(65130, 65130);
  const d = decide({ S: 65130, K: 65135, tauSec: 720, bars, sigmaPerSec: lowVol(65130),
    market_p: 0.49, up_ask: 0.50, down_ask: 0.54, half_spread: 0.01, now });
  assert.equal(d.recommendation, 'NO_TRADE');
});

test('decide: F8 cost veto flips a would-be TAKE_YES to NO_TRADE', () => {
  const { bars, now } = warmBars(64800, 65130);
  const d = decide({ S: 65130, K: 65135, tauSec: 720, bars, sigmaPerSec: lowVol(65130),
    market_p: 0.94, up_ask: 0.97, down_ask: 0.05, half_spread: 0.01, now }); // ask over ceiling
  assert.equal(d.recommendation, 'NO_TRADE');
});

test('decide: gate says only-NO but momentum is strongly up => NO_TRADE (conflict)', () => {
  const { bars, now } = warmBars(64400, 65088); // strong up-move, still well below strike
  const d = decide({ S: 65088, K: 65135, tauSec: 720, bars, sigmaPerSec: lowVol(65088),
    market_p: 0.30, up_ask: 0.34, down_ask: 0.68, half_spread: 0.02, now });
  assert.equal(d.recommendation, 'NO_TRADE');
});

test('decide: output contract is exactly one of the 3 states, with a reason', () => {
  const { bars, now } = warmBars(65088, 65088);
  const d = decide({ S: 65088, K: 65135, tauSec: 720, bars, sigmaPerSec: lowVol(65088),
    market_p: 0.30, up_ask: 0.34, down_ask: 0.68, half_spread: 0.02, now });
  assert.ok(['TAKE_YES', 'TAKE_NO', 'NO_TRADE'].includes(d.recommendation));
  assert.ok(['TAKE YES', 'TAKE NO', 'NO TRADE'].includes(d.badge));
  assert.equal(typeof d.reason, 'string');
  assert.ok(d.reason.length > 0);
});

test('decide: reason never states a probability as the headline', () => {
  const { bars, now } = warmBars(65088, 65088);
  const d = decide({ S: 65088, K: 65135, tauSec: 720, bars, sigmaPerSec: lowVol(65088),
    market_p: 0.30, up_ask: 0.34, down_ask: 0.68, half_spread: 0.02, now });
  // no "62%", "0.62", "probability", "odds" leading the recommendation
  assert.doesNotMatch(d.reason.split('Recommendation:')[0], /\bprobabilit|\bodds\b|%\s*(chance|likely)/i);
});
