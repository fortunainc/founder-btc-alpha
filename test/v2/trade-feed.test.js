import test from 'node:test';
import assert from 'node:assert/strict';
import { TRADE_VENUES } from '../../src/v2/trade-feed.js';

test('coinbase parser: maker side inverts to taker aggressor', () => {
  const p = TRADE_VENUES.coinbase.parse;
  // maker side 'sell' (resting ask lifted) ⇒ taker BOUGHT
  assert.deepEqual(p({ type: 'match', product_id: 'BTC-USD', side: 'sell', size: '0.5', price: '65000' }),
    { price: 65000, size: 0.5, aggressor: 'buy' });
  // maker side 'buy' (resting bid hit) ⇒ taker SOLD
  assert.deepEqual(p({ type: 'match', product_id: 'BTC-USD', side: 'buy', size: '1', price: '65010' }),
    { price: 65010, size: 1, aggressor: 'sell' });
  // ignore non-match / wrong product / bad numbers
  assert.equal(p({ type: 'ticker', product_id: 'BTC-USD' }), null);
  assert.equal(p({ type: 'match', product_id: 'ETH-USD', side: 'sell', size: '1', price: '1' }), null);
  assert.equal(p({ type: 'match', product_id: 'BTC-USD', side: 'sell', size: '0', price: '65000' }), null);
});

test('kraken parser: side IS the taker aggressor; handles batches', () => {
  const p = TRADE_VENUES.kraken.parse;
  const out = p({ channel: 'trade', data: [
    { symbol: 'BTC/USD', side: 'buy', qty: '0.2', price: '65020' },
    { symbol: 'BTC/USD', side: 'sell', qty: '0.1', price: '65015' },
  ] });
  assert.deepEqual(out, [
    { price: 65020, size: 0.2, aggressor: 'buy' },
    { price: 65015, size: 0.1, aggressor: 'sell' },
  ]);
  assert.equal(p({ channel: 'heartbeat' }), null);
  assert.equal(p({ channel: 'trade', data: [{ symbol: 'BTC/USD', side: 'x', qty: '1', price: '1' }] }), null);
});
