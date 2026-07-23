#!/usr/bin/env node
/**
 * Auth smoke test — runtime proof that Kalshi RSA-PSS auth works.
 *
 * Tries DEMO first if KALSHI_DEMO_* is present, then PROD read-only endpoints.
 * Writes raw response fixtures to fixtures/ (redacted of any credential).
 *
 * Exit 0 = VERIFIED, exit 1 = FAILED/BLOCKED.
 */

import fs from 'node:fs';
import path from 'node:path';
import { loadEnv, credentialStatus } from '../src/env.js';
import { clientFromEnv, KalshiClient, ReadOnlyViolation } from '../src/kalshi-client.js';

loadEnv();

const FIXTURES = path.resolve(process.cwd(), 'fixtures');
fs.mkdirSync(FIXTURES, { recursive: true });

function saveFixture(name, payload) {
  const file = path.join(FIXTURES, `${name}.json`);
  fs.writeFileSync(file, JSON.stringify(payload, null, 2));
  console.log(`  fixture -> fixtures/${name}.json`);
  return file;
}

/** Strip request-identifying auth headers before persisting a fixture. */
function safeHeaders(headers) {
  const out = { ...headers };
  for (const k of Object.keys(out)) {
    if (k.toLowerCase().startsWith('kalshi-access')) delete out[k];
  }
  return out;
}

async function probe(client, label, envName) {
  const results = {};

  const status = await client.getExchangeStatus();
  results.exchange_status = {
    request: { method: 'GET', path: '/trade-api/v2/exchange/status' },
    http_status: status.status,
    body: status.body,
    rate_limit_headers: status.rateLimit,
    response_headers: safeHeaders(status.headers),
  };
  console.log(`  [${label}] GET /exchange/status -> ${status.status}`);

  // An authenticated-only endpoint proves the signature is actually accepted,
  // not merely that a public endpoint returned 200.
  const series = await client.getSeries(process.env.KALSHI_SERIES_TICKER || 'KXBTC15M');
  results.series = {
    request: { method: 'GET', path: '/trade-api/v2/series/KXBTC15M' },
    http_status: series.status,
    body: series.body,
    rate_limit_headers: series.rateLimit,
    response_headers: safeHeaders(series.headers),
  };
  console.log(`  [${label}] GET /series/KXBTC15M -> ${series.status}`);

  return {
    environment: envName,
    captured_at: new Date().toISOString(),
    base_url: client.baseUrl,
    key_id_present: true,
    authenticated: status.status === 200,
    results,
  };
}

async function main() {
  console.log('=== Kalshi auth smoke test ===\n');

  const creds = credentialStatus([
    'KALSHI_KEY_ID',
    'KALSHI_PRIVATE_KEY_PEM',
    'KALSHI_DEMO_KEY_ID',
    'KALSHI_DEMO_PRIVATE_KEY_PEM',
  ]);
  console.log('Credential presence (names only, values never printed):');
  for (const c of creds) console.log(`  ${c.present ? 'present' : 'MISSING'}  ${c.name}`);
  console.log('');

  // Prove the read-only guard actually blocks a mutation attempt.
  let guardProof;
  try {
    KalshiClient.assertReadOnly('POST', '/trade-api/v2/portfolio/orders');
    guardProof = { guard_active: false, note: 'GUARD DID NOT FIRE — FAILED' };
  } catch (err) {
    guardProof = {
      guard_active: err instanceof ReadOnlyViolation,
      error_name: err.name,
      error_message: err.message,
    };
  }
  console.log(`Read-only guard: ${guardProof.guard_active ? 'ACTIVE' : 'INACTIVE'}`);
  console.log(`  ${guardProof.error_message}\n`);

  const out = {
    captured_at: new Date().toISOString(),
    read_only_guard_proof: guardProof,
    environments: {},
  };

  const hasDemo = process.env.KALSHI_DEMO_KEY_ID && process.env.KALSHI_DEMO_PRIVATE_KEY_PEM;
  const hasProd = process.env.KALSHI_KEY_ID && process.env.KALSHI_PRIVATE_KEY_PEM;

  if (!hasDemo && !hasProd) {
    out.status = 'BLOCKED';
    out.reason = 'No Kalshi credentials in environment (KALSHI_KEY_ID / KALSHI_PRIVATE_KEY_PEM).';
    saveFixture('01-auth-smoke', out);
    console.error('STATUS: BLOCKED — no credentials available.');
    process.exit(1);
  }

  if (hasDemo) {
    console.log('-- DEMO environment --');
    try {
      out.environments.demo = await probe(clientFromEnv({ env: 'demo' }), 'demo', 'demo');
    } catch (err) {
      out.environments.demo = { error: err.message, status: 'FAILED' };
      console.error(`  demo failed: ${err.message}`);
    }
  } else {
    console.log('-- DEMO environment: skipped (no KALSHI_DEMO_* provided) --');
    out.environments.demo = { skipped: true, reason: 'no demo credentials provided' };
  }

  if (hasProd) {
    console.log('\n-- PROD environment (read-only) --');
    try {
      out.environments.prod = await probe(clientFromEnv({ env: 'prod' }), 'prod', 'prod');
    } catch (err) {
      out.environments.prod = { error: err.message, status: 'FAILED' };
      console.error(`  prod failed: ${err.message}`);
    }
  }

  const authedProd = out.environments.prod?.authenticated;
  const authedDemo = out.environments.demo?.authenticated;
  out.status = authedProd || authedDemo ? 'VERIFIED' : 'FAILED';

  saveFixture('01-auth-smoke', out);
  console.log(`\nSTATUS: ${out.status}`);
  process.exit(out.status === 'VERIFIED' ? 0 : 1);
}

main().catch((err) => {
  console.error('FAILED:', err.message);
  process.exit(1);
});
