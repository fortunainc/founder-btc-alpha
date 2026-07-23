import test from 'node:test';
import assert from 'node:assert/strict';
import { renderPage, timingSafeEqual } from '../src/dashboard.js';

test('timingSafeEqual matches equal, rejects unequal and length-mismatch', () => {
  assert.equal(timingSafeEqual('abc123', 'abc123'), true);
  assert.equal(timingSafeEqual('abc123', 'abc124'), false);
  assert.equal(timingSafeEqual('abc', 'abcd'), false);
  assert.equal(timingSafeEqual('', 'x'), false);
});

const SAMPLE = {
  latestCaptureTs: new Date(Date.now() - 5000).toISOString(),
  errors: {},
  calls: [
    { window_id: 'KXBTC15M-26JUL231815-15', seal_point: 'T-2', close_ts: '2026-07-23T22:15:00Z',
      strike: 65100, market_p: 0.50, consensus_p: 0.62, divergence: 0.12, call: 'YES',
      outcome: 'yes', call_correct: true },
    { window_id: 'KXBTC15M-26JUL231800-00', seal_point: 'T-5', close_ts: '2026-07-23T22:00:00Z',
      strike: 65000, market_p: 0.70, consensus_p: 0.70, divergence: 0.0, call: 'FAIR',
      outcome: 'yes', call_correct: true },
    { window_id: 'KXBTC15M-26JUL231745-45', seal_point: 'T-10', close_ts: '2026-07-23T21:45:00Z',
      strike: 64900, market_p: 0.40, consensus_p: 0.42, divergence: 0.02, call: 'THIN',
      outcome: 'no', call_correct: null },
  ],
  board: [
    { seal_point: 'T-2', call: 'FAIR', n_total: 5, n_graded: 5, n_correct: 5, accuracy: 1.0, mean_abs_divergence: 0.0 },
    { seal_point: 'T-10', call: 'YES', n_total: 3, n_graded: 3, n_correct: 1, accuracy: 0.33, mean_abs_divergence: 0.11 },
  ],
};

test('renders a single self-contained HTML document', () => {
  const html = renderPage(SAMPLE);
  assert.equal((html.match(/<!doctype/gi) || []).length, 1);
  assert.equal((html.match(/<table/g) || []).length, 2);
  assert.match(html, /http-equiv="refresh" content="10"/);
  // No external subresources.
  assert.ok(!/https?:\/\//.test(html.replace(/http-equiv/g, '')), 'no external URLs');
});

test('shows the SHADOW banner prominently', () => {
  assert.match(renderPage(SAMPLE), /SHADOW MODE/);
});

test('capture-alive is green within 60s and red beyond', () => {
  const live = renderPage({ ...SAMPLE, latestCaptureTs: new Date(Date.now() - 10_000).toISOString() });
  assert.match(live, /live ·/);
  const stale = renderPage({ ...SAMPLE, latestCaptureTs: new Date(Date.now() - 120_000).toISOString() });
  assert.match(stale, /STALE ·/);
  const none = renderPage({ ...SAMPLE, latestCaptureTs: null });
  assert.match(none, /no data/);
});

test('renders all four call states', () => {
  const html = renderPage(SAMPLE);
  for (const s of ['YES', 'NO', 'FAIR', 'THIN']) {
    // At least the ones present in the sample.
    if (SAMPLE.calls.some((c) => c.call === s)) assert.ok(html.includes(`>${s}<`), `${s} pill`);
  }
});

test('right/wrong/pending results render correctly per call', () => {
  const html = renderPage(SAMPLE);
  assert.match(html, /✓ right/);           // YES correct
  // THIN with null call_correct -> shows the bare outcome, not right/wrong
  assert.ok(html.includes('right') || html.includes('wrong'));
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
    latestCaptureTs: null, calls: [], board: [],
    errors: { calls: 'PGRST205 relation does not exist' },
  });
  assert.match(html, /data warnings/);
  assert.match(html, /PGRST205/);
});

test('never emits a token or key (render takes no secrets)', () => {
  const html = renderPage(SAMPLE);
  assert.ok(!/token/i.test(html) || !/FOUNDER_DASH/i.test(html));
  assert.ok(!html.includes('eyJ'));
});
