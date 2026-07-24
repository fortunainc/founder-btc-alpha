import test from 'node:test';
import assert from 'node:assert/strict';
import { TradeTape } from '../../src/v2/tradetape.js';
import { f5OrderFlow } from '../../src/v2/orderflow.js';

const T0 = 1_700_000_000_000;

// Feed n trades over the last `spanMs`, alternating price by `drift`, all same aggressor.
function tape({ n = 20, side = 'buy', start = 65000, drift = 0, size = 1, spanMs = 40_000 }) {
  const tp = new TradeTape();
  const now = T0;
  for (let i = 0; i < n; i += 1) {
    const ts = now - spanMs + Math.round((spanMs * i) / (n - 1));
    tp.add(ts, start + drift * i, size, side);
  }
  return { tp, now };
}

// ---- TradeTape ----
test('TradeTape: delta, imbalance, volume, vwap, rate', () => {
  const tp = new TradeTape();
  tp.add(T0, 65000, 2, 'buy');
  tp.add(T0 + 1000, 65010, 1, 'sell');
  tp.add(T0 + 2000, 65020, 1, 'buy');
  const now = T0 + 2000;
  assert.equal(tp.delta(60_000, now), 2 - 1 + 1); // +2
  assert.equal(tp.volume(60_000, now), 4);
  assert.equal(tp.imbalance(60_000, now), 2 / 4);
  assert.equal(tp.count(60_000, now), 3);
  // vwap = (65000*2 + 65010*1 + 65020*1)/4
  assert.equal(tp.vwap(60_000, now), (65000 * 2 + 65010 + 65020) / 4);
});

test('TradeTape: evicts trades older than maxAge', () => {
  const tp = new TradeTape({ maxAgeMs: 10_000 });
  tp.add(T0, 65000, 1, 'buy');
  tp.add(T0 + 20_000, 65000, 1, 'buy'); // evicts the first
  assert.equal(tp.size, 1);
});

test('TradeTape: ignores invalid trades and unknown aggressor', () => {
  const tp = new TradeTape();
  tp.add(T0, -1, 1, 'buy');       // bad price
  tp.add(T0, 65000, 0, 'buy');    // bad size
  tp.add(T0, 65000, 1, 'unknown'); // no aggressor
  assert.equal(tp.size, 0);
});

// ---- f5OrderFlow ----
test('F5: sustained buying (no absorption) votes YES with real strength', () => {
  const { tp, now } = tape({ n: 30, side: 'buy', drift: 2 }); // price rising with the buying
  const r = f5OrderFlow({ tape: tp, now });
  assert.equal(r.side, 'yes');
  assert.ok(r.strength > 0.3);
  assert.equal(r.detail.absorbing, false);
});

test('F5: sustained selling with falling price votes NO', () => {
  const { tp, now } = tape({ n: 30, side: 'sell', drift: -2 });
  const r = f5OrderFlow({ tape: tp, now });
  assert.equal(r.side, 'no');
});

test('F5: heavy buying that fails to move price = absorption → fades to NO', () => {
  const { tp, now } = tape({ n: 30, side: 'buy', drift: 0 }); // lopsided buy, flat price
  const r = f5OrderFlow({ tape: tp, now });
  assert.equal(r.detail.absorbing, true);
  assert.equal(r.side, 'no', 'buyers absorbed ⇒ fade to the downside');
});

test('F5: too few trades → flat, zero strength', () => {
  const { tp, now } = tape({ n: 4, side: 'buy', drift: 2 });
  const r = f5OrderFlow({ tape: tp, now });
  assert.equal(r.side, 'flat');
  assert.equal(r.strength, 0);
});

test('F5: no trade feed → flat (graceful)', () => {
  const r = f5OrderFlow({ tape: null, now: T0 });
  assert.equal(r.side, 'flat');
  assert.equal(r.key, 'F5_order_flow');
});
