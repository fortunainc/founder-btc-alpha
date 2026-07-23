import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { normaliseOrderbook, evaluateInvariants, parseLadder, depthWithin } from '../src/orderbook.js';

const fixturePath = path.resolve('fixtures', '05-orderbook-sample.json');

test('parses the REAL captured Kalshi orderbook fixture', { skip: !fs.existsSync(fixturePath) }, () => {
  const fixture = JSON.parse(fs.readFileSync(fixturePath, 'utf8'));
  const book = normaliseOrderbook(fixture.body);

  assert.ok(book.up_bid > 0 && book.up_bid < 1, 'up_bid in range');
  assert.ok(book.down_bid > 0 && book.down_bid < 1, 'down_bid in range');
  assert.ok(book._levels.yes > 0 && book._levels.no > 0, 'both ladders populated');

  // The complement identity is the core structural claim of the parser.
  assert.ok(Math.abs(book.up_ask - (1 - book.down_bid)) < 1e-9);
  assert.ok(Math.abs(book.down_ask - (1 - book.up_bid)) < 1e-9);

  // A real, uncrossed book must have mids summing to ~1.
  const sum = book.up_mid + book.down_mid;
  assert.ok(sum > 0.97 && sum < 1.03, `mids sum to ~1, got ${sum}`);
});

test('ladders sort best-bid-first and reject untradeable levels', () => {
  const levels = parseLadder([
    ['0.4000', '10'],
    ['0.6000', '20'],
    ['0.5000', '30'],
    ['0.0000', '99'], // untradeable
    ['1.0000', '99'], // untradeable
    ['bad', '1'], // unparseable
  ]);
  assert.equal(levels.length, 3);
  assert.deepEqual(
    levels.map((l) => l.price),
    [0.6, 0.5, 0.4]
  );
});

test('depthWithin sums only levels inside the 2c band', () => {
  const levels = parseLadder([
    ['0.6000', '10'], // best
    ['0.5900', '20'], // 1c away  -> in
    ['0.5800', '30'], // 2c away  -> in (boundary)
    ['0.5700', '40'], // 3c away  -> out
  ]);
  assert.equal(depthWithin(levels, 0.02), 60);
});

test('depthWithin handles deci-cent levels (tapered_deci_cent)', () => {
  const levels = parseLadder([
    ['0.0350', '100'],
    ['0.0340', '200'], // 0.1c away
    ['0.0150', '300'], // 2c away -> boundary, in
    ['0.0140', '400'], // 2.1c away -> out
  ]);
  assert.equal(depthWithin(levels, 0.02), 600);
});

test('empty book yields nulls rather than fabricated prices', () => {
  const book = normaliseOrderbook({ orderbook_fp: { yes_dollars: [], no_dollars: [] } });
  assert.equal(book.up_bid, null);
  assert.equal(book.up_ask, null);
  assert.equal(book.up_mid, null);
  assert.equal(book.down_mid, null);
});

// --- invariants -------------------------------------------------------

test('clean book produces no flags', () => {
  const book = { up_mid: 0.5, down_mid: 0.5, up_bid: 0.49, up_ask: 0.51, down_bid: 0.49, down_ask: 0.51 };
  const flags = evaluateInvariants(book, { prevTs: 1000, ts: 6000, replicaIndex: 65000 });
  assert.deepEqual(flags, {});
});

test('mids summing outside [0.97,1.01] are flagged', () => {
  const low = evaluateInvariants(
    { up_mid: 0.4, down_mid: 0.5, up_bid: null, up_ask: null, down_bid: null, down_ask: null },
    { prevTs: 1000, ts: 6000, replicaIndex: 1 }
  );
  assert.equal(low.sum_out_of_band, 0.9);

  const high = evaluateInvariants(
    { up_mid: 0.6, down_mid: 0.5, up_bid: null, up_ask: null, down_bid: null, down_ask: null },
    { prevTs: 1000, ts: 6000, replicaIndex: 1 }
  );
  assert.equal(high.sum_out_of_band, 1.1);
});

test('band boundaries are inclusive and do not false-positive', () => {
  for (const sum of [0.97, 1.01, 0.99, 1.0]) {
    const flags = evaluateInvariants(
      { up_mid: sum - 0.5, down_mid: 0.5, up_bid: null, up_ask: null, down_bid: null, down_ask: null },
      { prevTs: 1000, ts: 6000, replicaIndex: 1 }
    );
    assert.ok(!('sum_out_of_band' in flags), `sum ${sum} should be clean`);
  }
});

test('non-monotonic timestamps are flagged', () => {
  const flags = evaluateInvariants(
    { up_mid: 0.5, down_mid: 0.5, up_bid: null, up_ask: null, down_bid: null, down_ask: null },
    { prevTs: 6000, ts: 5000, replicaIndex: 1 }
  );
  assert.ok(flags.non_monotonic_ts);
});

test('capture gaps over 30s are flagged with the gap in seconds', () => {
  const flags = evaluateInvariants(
    { up_mid: 0.5, down_mid: 0.5, up_bid: null, up_ask: null, down_bid: null, down_ask: null },
    { prevTs: 0, ts: 45_000, replicaIndex: 1 }
  );
  assert.equal(flags.capture_gap, 45);

  const ok = evaluateInvariants(
    { up_mid: 0.5, down_mid: 0.5, up_bid: null, up_ask: null, down_bid: null, down_ask: null },
    { prevTs: 0, ts: 30_000, replicaIndex: 1 }
  );
  assert.ok(!('capture_gap' in ok), '30s exactly is not a gap');
});

test('missing replica index is flagged, never silently dropped', () => {
  const flags = evaluateInvariants(
    { up_mid: 0.5, down_mid: 0.5, up_bid: null, up_ask: null, down_bid: null, down_ask: null },
    { prevTs: 1000, ts: 6000, replicaIndex: null }
  );
  assert.equal(flags.replica_unavailable, true);
});

test('incomplete book is flagged rather than passed through', () => {
  const flags = evaluateInvariants(
    { up_mid: null, down_mid: 0.5, up_bid: null, up_ask: null, down_bid: null, down_ask: null },
    { prevTs: 1000, ts: 6000, replicaIndex: 1 }
  );
  assert.ok(flags.incomplete_book);
});

test('crossed books are flagged', () => {
  const flags = evaluateInvariants(
    { up_mid: 0.5, down_mid: 0.5, up_bid: 0.6, up_ask: 0.5, down_bid: null, down_ask: null },
    { prevTs: 1000, ts: 6000, replicaIndex: 1 }
  );
  assert.ok(flags.crossed_up);
});
