/**
 * Kalshi orderbook normalisation for KXBTC15M.
 *
 * Kalshi's book is quoted as BIDS ON BOTH SIDES. `orderbook_fp.yes_dollars` is
 * the ladder of bids to buy YES; `no_dollars` is the ladder of bids to buy NO.
 * There is no explicit ask ladder — an ask on one side is the complement of a
 * bid on the other:
 *
 *     yes_ask = 1 - best_no_bid
 *     no_ask  = 1 - best_yes_bid
 *
 * Verified against fixtures/05-orderbook-sample.json.
 *
 * "up" == YES (BTC price up over the window), "down" == NO.
 *
 * Prices are NOT whole cents: the series uses `tapered_deci_cent`, so levels
 * are quoted to 4dp. Depth-within-2c logic therefore works on a numeric
 * threshold, never on an integer tick count.
 */

/** Parse a [price, size] ladder of strings into sorted numeric levels. */
function parseLadder(raw) {
  if (!Array.isArray(raw)) return [];
  const levels = [];
  for (const entry of raw) {
    if (!Array.isArray(entry) || entry.length < 2) continue;
    const price = Number(entry[0]);
    const size = Number(entry[1]);
    if (!Number.isFinite(price) || !Number.isFinite(size)) continue;
    if (price <= 0 || price >= 1) continue; // 0 and 1 are not tradeable levels
    levels.push({ price, size });
  }
  // Descending price: best bid first.
  levels.sort((a, b) => b.price - a.price);
  return levels;
}

/** Total resting size within `band` dollars of the best price. */
function depthWithin(levels, band = 0.02) {
  if (!levels.length) return 0;
  const best = levels[0].price;
  let total = 0;
  for (const l of levels) {
    if (best - l.price <= band + 1e-9) total += l.size;
    else break; // sorted descending, so we can stop
  }
  return Number(total.toFixed(4));
}

/**
 * Normalise a raw orderbook response body into the capture record's book
 * fields.
 *
 * @param {object} body the parsed `body` of GET /markets/{ticker}/orderbook
 * @param {number} band depth band in dollars (default 2 cents)
 */
export function normaliseOrderbook(body, band = 0.02) {
  const ob = body?.orderbook_fp || body?.orderbook || {};
  const yesBids = parseLadder(ob.yes_dollars ?? ob.yes);
  const noBids = parseLadder(ob.no_dollars ?? ob.no);

  const bestYesBid = yesBids.length ? yesBids[0].price : null;
  const bestNoBid = noBids.length ? noBids[0].price : null;

  // Complement relationship: an ask is the inverse of the opposing bid.
  const yesAsk = bestNoBid !== null ? Number((1 - bestNoBid).toFixed(4)) : null;
  const noAsk = bestYesBid !== null ? Number((1 - bestYesBid).toFixed(4)) : null;

  const upMid =
    bestYesBid !== null && yesAsk !== null
      ? Number(((bestYesBid + yesAsk) / 2).toFixed(4))
      : null;
  const downMid =
    bestNoBid !== null && noAsk !== null
      ? Number(((bestNoBid + noAsk) / 2).toFixed(4))
      : null;

  return {
    up_bid: bestYesBid,
    up_ask: yesAsk,
    up_bid_size: yesBids.length ? yesBids[0].size : null,
    // Size available at the YES ask == size resting as NO bids at its complement.
    up_ask_size: noBids.length ? noBids[0].size : null,
    up_depth_2c_bid: depthWithin(yesBids, band),
    up_depth_2c_ask: depthWithin(noBids, band),
    up_mid: upMid,

    down_bid: bestNoBid,
    down_ask: noAsk,
    down_bid_size: noBids.length ? noBids[0].size : null,
    down_ask_size: yesBids.length ? yesBids[0].size : null,
    down_depth_2c_bid: depthWithin(noBids, band),
    down_depth_2c_ask: depthWithin(yesBids, band),
    down_mid: downMid,

    _levels: { yes: yesBids.length, no: noBids.length },
  };
}

/**
 * Data-quality invariants evaluated at write time.
 * Returns a flags object; empty object means clean.
 *
 * @param {object} book normalised book
 * @param {object} ctx  { prevTs, ts, replicaIndex }
 */
export function evaluateInvariants(book, ctx = {}) {
  const flags = {};

  // 1. Complementary mids must sum to ~1. Outside [0.97, 1.01] is either a
  //    genuine arbitrage or (far more likely) a bad/stale book read.
  if (book.up_mid !== null && book.down_mid !== null) {
    const sum = Number((book.up_mid + book.down_mid).toFixed(4));
    if (sum < 0.97 || sum > 1.01) flags.sum_out_of_band = sum;
  } else {
    flags.incomplete_book = {
      up_mid: book.up_mid,
      down_mid: book.down_mid,
    };
  }

  // 2. Timestamps must advance monotonically within a window.
  if (ctx.prevTs != null && ctx.ts != null && ctx.ts <= ctx.prevTs) {
    flags.non_monotonic_ts = { prev: ctx.prevTs, current: ctx.ts };
  }

  // 3. Capture gaps over 30s mean we lost coverage.
  if (ctx.prevTs != null && ctx.ts != null) {
    const gapMs = ctx.ts - ctx.prevTs;
    if (gapMs > 30_000) flags.capture_gap = Math.round(gapMs / 1000);
  }

  // 4. The replica must be producing a value; a null index makes the row
  //    useless for the error study and must be visible, not silent.
  if (ctx.replicaIndex == null) flags.replica_unavailable = true;

  // 5. A crossed book (bid above ask) is structurally impossible.
  if (book.up_bid !== null && book.up_ask !== null && book.up_bid > book.up_ask) {
    flags.crossed_up = { bid: book.up_bid, ask: book.up_ask };
  }
  if (book.down_bid !== null && book.down_ask !== null && book.down_bid > book.down_ask) {
    flags.crossed_down = { bid: book.down_bid, ask: book.down_ask };
  }

  return flags;
}

export { parseLadder, depthWithin };
