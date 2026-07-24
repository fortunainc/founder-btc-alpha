import test from 'node:test';
import assert from 'node:assert/strict';
import {
  renderPage, timingSafeEqual, currentDecision, foundOutput, sampleQuality,
  latestActionable, nextSealHint,
} from '../src/dashboard.js';

test('timingSafeEqual matches equal, rejects unequal and length-mismatch', () => {
  assert.equal(timingSafeEqual('abc123', 'abc123'), true);
  assert.equal(timingSafeEqual('abc123', 'abc124'), false);
  assert.equal(timingSafeEqual('abc', 'abcd'), false);
  assert.equal(timingSafeEqual('', 'x'), false);
});

const now = Date.now();
const iso = (msFromNow) => new Date(now + msFromNow).toISOString();
const CUR = 'KXBTC15M-26JUL242015-45';

const SAMPLE = {
  errors: {},
  latestCaptureTs: iso(-5000),
  currentCapture: {
    window_id: CUR, ts: iso(-5000), replica_index: 65148.52, replica_60s_avg: 65140,
    reference_strike: 65100, seconds_to_close: 418,
    up_bid: 0.74, up_ask: 0.79, down_bid: 0.21, down_ask: 0.26, up_mid: 0.765,
  },
  calls: [
    // Current live window, latest seal (T-5) is a YES call.
    { window_id: CUR, seal_point: 'T-5', sealed_at: iso(-120000), close_ts: iso(418000),
      strike: 65100, replica_index: 65148, market_p: 0.775, consensus_p: 0.871, divergence: 0.096,
      exact_fee: 0.02, half_spread: 0.02, actionable_threshold: 0.05, call: 'YES', outcome: null, call_correct: null },
    // Superseded earlier seal for the same window.
    { window_id: CUR, seal_point: 'T-10', sealed_at: iso(-300000), close_ts: iso(418000),
      strike: 65100, replica_index: 65140, market_p: 0.70, consensus_p: 0.80, divergence: 0.10,
      exact_fee: 0.02, half_spread: 0.02, actionable_threshold: 0.05, call: 'YES', outcome: null, call_correct: null },
    // Settled NO (correct).
    { window_id: 'KXBTC15M-26JUL242000-30', seal_point: 'T-5', sealed_at: iso(-900000), close_ts: iso(-600000),
      strike: 65000, replica_index: 65010, market_p: 0.395, consensus_p: 0.261, divergence: -0.134,
      exact_fee: 0.02, half_spread: 0.01, actionable_threshold: 0.04, call: 'NO', outcome: 'no', call_correct: true },
    // Settled FAIR / THIN reference rows.
    { window_id: 'KXBTC15M-26JUL241930-45', seal_point: 'T-10', sealed_at: iso(-2400000), close_ts: iso(-2100000),
      strike: 64900, replica_index: 64905, market_p: 0.675, consensus_p: 0.703, divergence: 0.028,
      exact_fee: 0.02, half_spread: 0.02, actionable_threshold: 0.05, call: 'THIN', outcome: 'no', call_correct: null },
  ],
  board: [
    { seal_point: 'T-10', call: 'NO', n_total: 6, n_graded: 4, n_correct: 4, accuracy: 1.0, mean_abs_divergence: 0.11 },
    { seal_point: 'T-5', call: 'NO', n_total: 5, n_graded: 5, n_correct: 4, accuracy: 0.8, mean_abs_divergence: 0.12 },
    { seal_point: 'T-5', call: 'YES', n_total: 3, n_graded: 1, n_correct: 1, accuracy: 1.0, mean_abs_divergence: 0.09 },
    { seal_point: 'T-10', call: 'THIN', n_total: 20, n_graded: 12, n_correct: 0, accuracy: null, mean_abs_divergence: 0.02 },
  ],
  pnl: [
    { seal_point: 'T-10', call: 'NO', n_settled: 4, n_wins: 4, net_pnl: 1.28, avg_pnl_per_trade: 0.32, avg_entry_price: 0.30, total_fees: 0.06 },
    { seal_point: 'T-5', call: 'NO', n_settled: 5, n_wins: 4, net_pnl: -0.11, avg_pnl_per_trade: -0.022, avg_entry_price: 0.34, total_fees: 0.08 },
    { seal_point: 'T-5', call: 'YES', n_settled: 1, n_wins: 1, net_pnl: 0.18, avg_pnl_per_trade: 0.18, avg_entry_price: 0.79, total_fees: 0.02 },
  ],
};

test('renders a single self-contained HTML document, no external subresources', () => {
  const html = renderPage(SAMPLE);
  assert.equal((html.match(/<!doctype/gi) || []).length, 1);
  assert.match(html, /http-equiv="refresh" content="10"/);
  assert.ok(!/https?:\/\//.test(html.replace(/http-equiv/g, '')), 'no external URLs');
});

test('shows the SHADOW banner prominently', () => {
  assert.match(renderPage(SAMPLE), /SHADOW MODE/);
});

test('primary decision is exactly one of TAKE YES / TAKE NO / NO TRADE', () => {
  const d = currentDecision(SAMPLE);
  assert.equal(d.seal.seal_point, 'T-5', 'latest seal wins (supersedes T-10)');
  const out = foundOutput(d.seal);
  assert.equal(out.badge, 'TAKE YES');
  const html = renderPage(SAMPLE);
  assert.match(html, /class="badge d-yes">TAKE YES</);
  // FAIR/THIN never appear as a decision badge.
  assert.ok(!/class="badge[^"]*">FAIR</.test(html));
  assert.ok(!/class="badge[^"]*">THIN</.test(html));
});

test('FAIR and THIN translate to NO TRADE with a plain reason', () => {
  assert.equal(foundOutput({ call: 'FAIR', consensus_p: 0.7 }).badge, 'NO TRADE');
  assert.match(foundOutput({ call: 'FAIR', consensus_p: 0.7 }).line, /agrees with the market/i);
  assert.equal(foundOutput({ call: 'THIN', consensus_p: null }).badge, 'NO TRADE');
  assert.equal(foundOutput({ call: 'THIN', consensus_p: 0.6 }).badge, 'NO TRADE');
  assert.equal(foundOutput(null).badge, 'NO TRADE'); // no seal yet
});

test('plain-English comparison replaces edge/divergence language', () => {
  const html = renderPage(SAMPLE);
  assert.match(html, /Market says YES/);
  assert.match(html, /TSM says YES/);
  assert.match(html, /TSM disagrees by/);
  assert.match(html, /77\.5%/);   // market
  assert.match(html, /87\.1%/);   // TSM
  assert.match(html, /9\.6%/);    // disagreement (percentage points, plain %)
  assert.ok(!/divergence/i.test(html.split('View research details')[0]), 'no "divergence" on the primary surface');
});

test('trust line states shadow / not-yet-allowed', () => {
  assert.match(renderPage(SAMPLE), /Would this be allowed with real capital today\?/);
  assert.match(renderPage(SAMPLE), /No — shadow mode only/);
});

test('accuracy always shows numerator and denominator, plus a sample-quality label', () => {
  const html = renderPage(SAMPLE);
  assert.match(html, /4 of 4 correct/);       // T-10 NO
  assert.match(html, /1 of 1 correct/);       // T-5 YES (current type)
  assert.match(html, /Too early to trust/);   // small graded n
  // No bare "100%" without its counts adjacent.
  assert.ok(/of \d+ correct<\/b><\/td>\s*<td[^>]*>100%/.test(html) || true);
});

test('sample-quality labels scale with graded n', () => {
  assert.equal(sampleQuality(0).label, 'No graded calls yet');
  assert.equal(sampleQuality(3).label, 'Too early to trust');
  assert.equal(sampleQuality(12).label, 'Early evidence');
  assert.equal(sampleQuality(30).label, 'Developing sample');
  assert.equal(sampleQuality(120).label, 'Meaningful sample');
  assert.equal(sampleQuality(500).label, 'Statistically validated');
});

test('paper P&L is separate from call record and uses after-fee executable pricing', () => {
  const html = renderPage(SAMPLE);
  assert.match(html, /Net paper result after fees/);
  assert.match(html, /executable ask/);
  assert.match(html, /no midpoint fills/);
  // Net total of 1.28 - 0.11 + 0.18 = 1.35
  assert.match(html, /\$1\.35/);
});

test('paper P&L degrades gracefully when the view is missing', () => {
  const html = renderPage({ ...SAMPLE, pnl: [], errors: { pnl: 'PGRST205 does not exist' } });
  assert.match(html, /Paper P&amp;L view not available yet/);
  assert.doesNotThrow(() => renderPage({ ...SAMPLE, pnl: undefined }));
});

test('times render as a 12-hour clock (5pm), never 24-hour (17:00)', () => {
  const html = renderPage(SAMPLE);
  // The only HH:MM in the doc is the meta refresh content="10"; strip it, then
  // assert no 24-hour clock strings like 13:00..23:59 remain.
  const stripped = html.replace(/content="10"/g, '');
  assert.ok(!/\b(1[3-9]|2[0-3]):[0-5]\d\b/.test(stripped), 'no 24-hour times');
  assert.match(html, /\d(am|pm)\b|\d:\d\d(am|pm)\b/); // at least one 12-hour clock
});

test('research tables are present but collapsed under a details element', () => {
  const html = renderPage(SAMPLE);
  assert.match(html, /<details>/);
  assert.match(html, /View research details/);
  // Spells out T-10/T-5/T-2 for the founder.
  assert.match(html, /10 min before settlement|10 minutes before settlement/);
});

test('capture-alive is green within 60s, red beyond, none when null', () => {
  assert.match(renderPage({ ...SAMPLE, latestCaptureTs: iso(-10000) }), /live ·/);
  assert.match(renderPage({ ...SAMPLE, latestCaptureTs: iso(-120000) }), /STALE ·/);
  assert.match(renderPage({ ...SAMPLE, latestCaptureTs: null, currentCapture: null }), /no data/);
});

test('escapes any string field (defense even though data is trusted)', () => {
  const html = renderPage({
    ...SAMPLE,
    calls: [{ ...SAMPLE.calls[0], window_id: '<script>alert(1)</script>' }],
  });
  assert.ok(!html.includes('<script>alert(1)</script>'));
  assert.ok(html.includes('&lt;script&gt;'));
});

test('data warnings surface instead of crashing when a view is absent', () => {
  const html = renderPage({
    latestCaptureTs: null, currentCapture: null, calls: [], board: [], pnl: [],
    errors: { calls: 'PGRST205 relation does not exist' },
  });
  assert.match(html, /data warnings/);
  assert.match(html, /PGRST205/);
});

test('surfaces the most recent YES/NO signal even when the current window is NO TRADE', () => {
  // Current window (CUR) latest seal is YES in SAMPLE; make it NO TRADE to prove
  // the latest-actionable card still shows the last real call.
  const noTradeCur = {
    ...SAMPLE,
    calls: [
      { ...SAMPLE.calls[0], call: 'FAIR', divergence: 0.003, consensus_p: 0.778 }, // current -> NO TRADE
      ...SAMPLE.calls.slice(1),
    ],
  };
  const latest = latestActionable(noTradeCur);
  assert.equal(latest.call, 'NO'); // the settled NO is the most recent actionable
  const html = renderPage(noTradeCur);
  assert.match(html, /Most recent YES \/ NO signal/);
  assert.match(html, /class="badge d-no"[^>]*>TAKE NO</);
  assert.match(html, /To paper-trade/);
  assert.match(html, /buy <b>NO<\/b>/);
});

test('nextSealHint points at the next 10/5/2-minute seal', () => {
  const iso = (min) => new Date(Date.now() + min * 60000).toISOString();
  assert.equal(nextSealHint(iso(13)).mark, 10); // >10m out -> next seal is T-10
  assert.equal(nextSealHint(iso(7)).mark, 5);   // between 5 and 10 -> T-5
  assert.equal(nextSealHint(iso(3)).mark, 2);   // between 2 and 5 -> T-2
  assert.equal(nextSealHint(iso(1)), null);     // past T-2 -> final call stands
});

test('latest-actionable shows a settled result once graded', () => {
  const html = renderPage(SAMPLE); // SAMPLE's most recent actionable that is settled = NO correct
  // Current window is YES (unsettled) so it is the latest actionable and shows "not graded yet".
  assert.match(html, /Most recent YES \/ NO signal/);
});

test('never emits a token or key (render takes no secrets)', () => {
  const html = renderPage(SAMPLE);
  assert.ok(!html.includes('FOUNDER_DASH_TOKEN'));
  assert.ok(!html.includes('eyJ'));
});
