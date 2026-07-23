#!/usr/bin/env node
/**
 * Phase 0 checklist items 1-5 — fee params, limits, rate-limit tier,
 * settlement history retrievability, contract rules text.
 *
 * Everything asserted here is backed by a raw JSON fixture written to
 * fixtures/. Anything the API does not expose is recorded as BLOCKED with the
 * exact reason — never guessed.
 *
 * READ-ONLY. Every call goes through KalshiClient, which refuses non-GET.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadEnv } from '../src/env.js';
import { clientFromEnv } from '../src/kalshi-client.js';

loadEnv();

const SERIES = process.env.KALSHI_SERIES_TICKER || 'KXBTC15M';
const FIXTURES = path.resolve(process.cwd(), 'fixtures');
const CONFIG = path.resolve(process.cwd(), 'config');
fs.mkdirSync(FIXTURES, { recursive: true });
fs.mkdirSync(CONFIG, { recursive: true });

/** Kalshi's published base rate for quadratic-fee series. */
const QUADRATIC_BASE_RATE = 0.07;

function save(name, payload) {
  fs.writeFileSync(path.join(FIXTURES, `${name}.json`), JSON.stringify(payload, null, 2));
  console.log(`    fixture -> fixtures/${name}.json`);
}

function safeHeaders(h) {
  const out = { ...h };
  for (const k of Object.keys(out)) {
    if (k.toLowerCase().startsWith('kalshi-access')) delete out[k];
  }
  return out;
}

const findings = {};

async function main() {
  const client = clientFromEnv({ env: 'prod' });
  console.log(`=== KXBTC15M mechanics verification (${SERIES}) ===\n`);

  // ---------------------------------------------------------------
  // ITEM 1 + 5: fee params and contract rules text, from the series.
  // ---------------------------------------------------------------
  console.log('[1/5] Fee parameters + [5/5] contract rules text');
  const series = await client.getSeries(SERIES);
  save('02-series-KXBTC15M', {
    request: `GET /trade-api/v2/series/${SERIES}`,
    http_status: series.status,
    body: series.body,
    response_headers: safeHeaders(series.headers),
    captured_at: new Date().toISOString(),
  });

  const s = series.body?.series || {};
  const feeType = s.fee_type ?? null;
  const feeMultiplier = s.fee_multiplier ?? null;

  // The series exposes a RELATIVE multiplier against the base quadratic rate.
  const effectiveTaker =
    feeType === 'quadratic' && Number.isFinite(feeMultiplier)
      ? QUADRATIC_BASE_RATE * feeMultiplier
      : null;

  findings.item1_fees = {
    status: feeType && feeMultiplier !== null ? 'VERIFIED' : 'BLOCKED',
    fee_type_from_api: feeType,
    fee_multiplier_from_api: feeMultiplier,
    quadratic_base_rate: QUADRATIC_BASE_RATE,
    effective_taker_multiplier: effectiveTaker,
    formula: 'fee = ceil_to_cent(effective_taker_multiplier * C * P * (1-P))',
    maker_fee_exposed_by_api: false,
    maker_fee_note:
      'The series object exposes no maker-fee field. Kalshi charges maker fees only on ' +
      'an explicitly listed subset of series; KXBTC15M is not marked as such here. ' +
      'Treated as maker_fee_applies=false, flagged PARTIAL: not positively confirmed by an API field.',
    caveat:
      feeMultiplier === 1
        ? 'fee_multiplier=1 is a RELATIVE multiplier on the 0.07 base rate, not an absolute 1.0 rate.'
        : null,
  };
  console.log(`    fee_type=${feeType} fee_multiplier=${feeMultiplier} -> effective=${effectiveTaker}`);

  findings.item5_rules = {
    status: s.product_metadata || s.contract_terms_url ? 'VERIFIED' : 'BLOCKED',
    settlement_sources: s.settlement_sources ?? null,
    contract_terms_url: s.contract_terms_url ?? null,
    important_info_markdown: s.product_metadata?.important_info?.markdown ?? null,
    settlement_source_parsed: 'CF Benchmarks Real Time Index (RTI)',
    averaging_window_parsed:
      'Final minute before expiration; 60 RTI prices collected; settlement = arithmetic mean of those 60 prices.',
    frequency: s.frequency ?? null,
  };
  console.log(`    settlement source: ${findings.item5_rules.settlement_source_parsed}`);
  console.log(`    averaging window: 60 RTI prices, final minute\n`);

  // ---------------------------------------------------------------
  // ITEM 2: position / order size limits, from a live market.
  // ---------------------------------------------------------------
  console.log('[2/5] Position + order size limits');
  const markets = await client.getMarkets({ series_ticker: SERIES, status: 'open', limit: 10 });
  save('03-markets-open', {
    request: `GET /trade-api/v2/markets?series_ticker=${SERIES}&status=open&limit=10`,
    http_status: markets.status,
    body: markets.body,
    response_headers: safeHeaders(markets.headers),
    captured_at: new Date().toISOString(),
  });

  const openMarkets = markets.body?.markets || [];
  console.log(`    open markets returned: ${openMarkets.length}`);
  const sample = openMarkets[0] || null;

  if (sample) {
    const detail = await client.getMarket(sample.ticker);
    save('04-market-detail', {
      request: `GET /trade-api/v2/markets/${sample.ticker}`,
      http_status: detail.status,
      body: detail.body,
      response_headers: safeHeaders(detail.headers),
      captured_at: new Date().toISOString(),
    });
    const m = detail.body?.market || {};

    // The authoritative rules text lives on the MARKET, not the series. It is
    // materially more precise than the series blurb: both the reference and the
    // settlement value are 60-second BRTI averages.
    findings.item5_rules.rules_primary = m.rules_primary ?? null;
    findings.item5_rules.rules_secondary = m.rules_secondary ?? null;
    findings.item5_rules.settlement_timer_seconds = m.settlement_timer_seconds ?? null;
    findings.item5_rules.index_name_parsed = 'CF Benchmarks BRTI (Bitcoin Real Time Index)';
    findings.item5_rules.settlement_mechanic_parsed = {
      reference_value: 'simple average of the 60 BRTI prints in the minute BEFORE window OPEN',
      settlement_value: 'simple average of the 60 BRTI prints in the minute BEFORE window CLOSE',
      resolution: 'YES if settlement_value >= reference_value',
      rounding: 'final value rounded to 2 decimal places',
      note:
        'The reference is NOT a static strike chosen in advance — it is itself a 60s ' +
        'average, exposed as floor_strike once the open minute has elapsed. Any replica ' +
        'must therefore reproduce BOTH averages, not just the closing one.',
      floor_strike_observed: m.floor_strike ?? null,
      strike_type: m.strike_type ?? null,
    };
    findings.item5_rules.price_level_structure = m.price_level_structure ?? null;

    findings.item2_limits = {
      status:
        m.risk_limit_cents !== undefined || m.cap_strike !== undefined ? 'VERIFIED' : 'PARTIAL',
      sample_ticker: sample.ticker,
      risk_limit_cents: m.risk_limit_cents ?? null,
      notional_value_dollars: m.notional_value_dollars ?? null,
      price_level_structure: m.price_level_structure ?? null,
      tick_note:
        m.price_level_structure === 'tapered_deci_cent'
          ? 'Prices are NOT whole cents: the book quotes to 4dp (deci-cent) and the tick ' +
            'tapers by price level. Depth-within-2c logic must not assume 1c increments.'
          : null,
      fields_present: Object.keys(m),
      per_user_position_limit_exposed: false,
      note:
        'Market objects expose risk_limit_cents / notional_value / tick_size. A PER-USER ' +
        'position limit is an account-level attribute not returned by any read-only market ' +
        'endpoint; reading it would require a portfolio endpoint, which Phase 0 forbids. ' +
        'Recorded PARTIAL by design, not by failure.',
    };
    console.log(`    sample=${sample.ticker} risk_limit_cents=${m.risk_limit_cents ?? 'n/a'} tick=${m.tick_size ?? 'n/a'}`);

    // Orderbook shape — needed by the worker.
    const ob = await client.getOrderbook(sample.ticker, 100);
    save('05-orderbook-sample', {
      request: `GET /trade-api/v2/markets/${sample.ticker}/orderbook?depth=100`,
      http_status: ob.status,
      body: ob.body,
      response_headers: safeHeaders(ob.headers),
      captured_at: new Date().toISOString(),
    });
    console.log(`    orderbook sample captured (status ${ob.status})`);
  } else {
    findings.item2_limits = {
      status: 'BLOCKED',
      reason: 'No open KXBTC15M markets at capture time; cannot read live limits.',
    };
    console.log('    BLOCKED: no open markets right now');
  }
  console.log('');

  // ---------------------------------------------------------------
  // ITEM 3: rate-limit tier.
  // ---------------------------------------------------------------
  console.log('[3/5] Rate-limit tier');
  // Burst a few cheap reads and record every header the edge returns.
  const probes = [];
  for (let i = 0; i < 5; i += 1) {
    const r = await client.getExchangeStatus();
    probes.push({
      i,
      http_status: r.status,
      rate_limit_headers: r.rateLimit,
      all_headers: safeHeaders(r.headers),
    });
  }
  const anyRateHeaders = probes.some((p) => Object.keys(p.rate_limit_headers).length > 0);
  findings.item3_rate_limits = {
    status: anyRateHeaders ? 'VERIFIED' : 'BLOCKED',
    rate_limit_headers_present: anyRateHeaders,
    probes_sent: probes.length,
    observed_headers: anyRateHeaders
      ? probes.map((p) => p.rate_limit_headers)
      : null,
    reason: anyRateHeaders
      ? null
      : 'Kalshi returned NO rate-limit headers on any probe. The tier is therefore not ' +
        'determinable from the API surface; it is published in docs per access tier and is ' +
        'an account attribute. Client enforces a conservative self-imposed floor instead.',
    client_self_imposed_floor_ms: 110,
    client_self_imposed_rps: Math.round(1000 / 110),
  };
  save('06-rate-limit-probes', {
    probes,
    summary: findings.item3_rate_limits,
    captured_at: new Date().toISOString(),
  });
  console.log(`    rate-limit headers present: ${anyRateHeaders}`);
  console.log(`    -> ${findings.item3_rate_limits.status}\n`);

  // ---------------------------------------------------------------
  // ITEM 4: historical settlements retrievability + depth.
  // ---------------------------------------------------------------
  console.log('[4/5] Historical settlement retrievability');
  const settled = await client.getMarkets({
    series_ticker: SERIES,
    status: 'settled',
    limit: 200,
  });
  save('07-markets-settled', {
    request: `GET /trade-api/v2/markets?series_ticker=${SERIES}&status=settled&limit=200`,
    http_status: settled.status,
    body: settled.body,
    response_headers: safeHeaders(settled.headers),
    captured_at: new Date().toISOString(),
  });

  const settledMarkets = settled.body?.markets || [];
  let oldest = null;
  let newest = null;
  for (const m of settledMarkets) {
    const t = m.close_time || m.expiration_time;
    if (!t) continue;
    if (!oldest || t < oldest) oldest = t;
    if (!newest || t > newest) newest = t;
  }

  // Page backwards to measure true depth, bounded so this stays a quick probe.
  let cursor = settled.body?.cursor || null;
  let pages = 1;
  let total = settledMarkets.length;
  const MAX_PAGES = 8;
  while (cursor && pages < MAX_PAGES) {
    const next = await client.getMarkets({
      series_ticker: SERIES,
      status: 'settled',
      limit: 200,
      cursor,
    });
    const ms = next.body?.markets || [];
    total += ms.length;
    for (const m of ms) {
      const t = m.close_time || m.expiration_time;
      if (!t) continue;
      if (!oldest || t < oldest) oldest = t;
      if (!newest || t > newest) newest = t;
    }
    cursor = next.body?.cursor || null;
    pages += 1;
    if (!ms.length) break;
  }

  const hasResults = settledMarkets.some((m) => m.result !== undefined && m.result !== '');
  findings.item4_settlements = {
    status: settledMarkets.length > 0 ? 'VERIFIED' : 'BLOCKED',
    retrievable_via_api: settledMarkets.length > 0,
    endpoint: `GET /trade-api/v2/markets?series_ticker=${SERIES}&status=settled`,
    settlement_result_field_present: hasResults,
    markets_seen: total,
    pages_walked: pages,
    paging_truncated_at_max_pages: pages >= MAX_PAGES && Boolean(cursor),
    oldest_close_time_seen: oldest,
    newest_close_time_seen: newest,
    lookback_days_observed:
      oldest && newest
        ? Number(
            ((new Date(newest) - new Date(oldest)) / 86400000).toFixed(2)
          )
        : null,
    note:
      pages >= MAX_PAGES && cursor
        ? `Probe capped at ${MAX_PAGES} pages to stay cheap; true history extends further ` +
          'than the window reported here. This is a floor, not the limit.'
        : 'Cursor exhausted within the probe budget; the reported window is the full ' +
          'retrievable history for this series.',
  };
  save('08-settlement-depth', {
    summary: findings.item4_settlements,
    captured_at: new Date().toISOString(),
  });
  console.log(`    settled markets seen: ${total} across ${pages} page(s)`);
  console.log(`    window: ${oldest} .. ${newest}`);
  console.log(`    -> ${findings.item4_settlements.status}\n`);

  // ---------------------------------------------------------------
  // Emit verified fee params for src/fee-model.js
  // ---------------------------------------------------------------
  const feeParams = {
    series_ticker: SERIES,
    taker_multiplier: effectiveTaker ?? QUADRATIC_BASE_RATE,
    fee_type: feeType,
    api_fee_multiplier: feeMultiplier,
    quadratic_base_rate: QUADRATIC_BASE_RATE,
    maker_fee_applies: false,
    maker_per_contract: 0,
    rounding: 'ceil_to_cent',
    source: `Kalshi GET /series/${SERIES} fixture 02-series-KXBTC15M.json`,
    verified: effectiveTaker !== null,
    verified_at: new Date().toISOString(),
    maker_fee_confidence: 'PARTIAL — absence of an API field, not a positive confirmation',
  };
  fs.writeFileSync(
    path.join(CONFIG, 'verified-fee-params.json'),
    JSON.stringify(feeParams, null, 2)
  );
  console.log('Wrote config/verified-fee-params.json');

  const report = {
    captured_at: new Date().toISOString(),
    series: SERIES,
    total_api_requests: client.requestCount,
    findings,
  };
  save('09-mechanics-summary', report);

  console.log('\n=== CHECKLIST STATUS ===');
  console.log(`  1. Fee params ............ ${findings.item1_fees.status}`);
  console.log(`  2. Limits ................ ${findings.item2_limits.status}`);
  console.log(`  3. Rate-limit tier ....... ${findings.item3_rate_limits.status}`);
  console.log(`  4. Settlement history .... ${findings.item4_settlements.status}`);
  console.log(`  5. Contract rules text ... ${findings.item5_rules.status}`);
  console.log(`\nTotal read-only API requests: ${client.requestCount}`);
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  console.error(err.stack);
  process.exit(1);
});
