/**
 * Kalshi REST client — READ-ONLY by construction (Phase 0 hard rule 2).
 *
 * Auth (per https://docs.kalshi.com):
 *   KALSHI-ACCESS-KEY        = key id
 *   KALSHI-ACCESS-TIMESTAMP  = unix epoch MILLISECONDS, as a string
 *   KALSHI-ACCESS-SIGNATURE  = base64( RSA-PSS-SHA256( timestamp + method + path ) )
 *
 * The signed message uses the path WITHOUT query parameters, and the method
 * upper-cased. Salt length for PSS is the digest length (32 bytes for SHA256).
 *
 * This module refuses to issue any request that is not a GET, and refuses any
 * path matching the mutation denylist, regardless of caller intent. That guard
 * is enforced at the single choke point every request flows through.
 */

import crypto from 'node:crypto';

const PROD_BASE = 'https://api.elections.kalshi.com';
const DEMO_BASE = 'https://demo-api.kalshi.co';

/**
 * Paths that mutate account state. Phase 0 must never reach any of these.
 * Matched case-insensitively as substrings against the request path.
 */
const MUTATION_DENYLIST = [
  '/orders',
  '/batch_create_orders',
  '/batch_cancel_orders',
  '/positions/close',
  '/portfolio/orders',
  '/portfolio/positions/close',
  '/rfqs',
  '/quotes',
  '/withdrawals',
  '/deposits',
  '/transfers',
];

class ReadOnlyViolation extends Error {
  constructor(message) {
    super(message);
    this.name = 'ReadOnlyViolation';
  }
}

/**
 * Normalise a PEM that may arrive from an env var with literal "\n" sequences
 * (the standard way to carry a multi-line PEM through Railway / .env).
 */
export function normalisePem(raw) {
  if (!raw || typeof raw !== 'string') {
    throw new Error('KALSHI_PRIVATE_KEY_PEM is missing or not a string');
  }
  let pem = raw.trim();
  // Strip surrounding quotes if the env var was quoted.
  if (
    (pem.startsWith('"') && pem.endsWith('"')) ||
    (pem.startsWith("'") && pem.endsWith("'"))
  ) {
    pem = pem.slice(1, -1);
  }
  // Convert escaped newlines to real ones.
  pem = pem.replace(/\\n/g, '\n').trim();
  if (!pem.includes('BEGIN') || !pem.includes('PRIVATE KEY')) {
    throw new Error(
      'KALSHI_PRIVATE_KEY_PEM does not look like a PEM private key ' +
        '(expected a "-----BEGIN ... PRIVATE KEY-----" header)'
    );
  }
  return pem;
}

/**
 * Sign `timestamp + method + path` with RSA-PSS / SHA-256.
 * Exported for unit testing against a throwaway keypair.
 */
export function signRequest({ privateKey, timestampMs, method, path }) {
  const message = `${timestampMs}${method.toUpperCase()}${path}`;
  const signature = crypto.sign('sha256', Buffer.from(message, 'utf8'), {
    key: privateKey,
    padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
    saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST,
  });
  return signature.toString('base64');
}

/**
 * Strip query params from a URL path — the signature covers path only.
 */
export function pathForSigning(pathWithQuery) {
  const q = pathWithQuery.indexOf('?');
  return q === -1 ? pathWithQuery : pathWithQuery.slice(0, q);
}

export class KalshiClient {
  /**
   * @param {object} opts
   * @param {string} opts.keyId
   * @param {string} opts.privateKeyPem
   * @param {'prod'|'demo'} [opts.env]
   * @param {number} [opts.minIntervalMs] client-side rate limiter spacing
   */
  constructor({ keyId, privateKeyPem, env = 'prod', minIntervalMs = 110 }) {
    if (!keyId) throw new Error('KalshiClient: keyId is required');
    this.keyId = keyId;
    this.env = env;
    this.baseUrl = env === 'demo' ? DEMO_BASE : PROD_BASE;
    this.privateKey = crypto.createPrivateKey({
      key: normalisePem(privateKeyPem),
    });
    this.minIntervalMs = minIntervalMs;
    this._lastRequestAt = 0;
    this._chain = Promise.resolve();
    /** @type {object|null} last observed rate-limit headers */
    this.lastRateLimitHeaders = null;
    this.requestCount = 0;
  }

  /** Assert a path is safe for a read-only Phase 0 client. */
  static assertReadOnly(method, path) {
    if (method.toUpperCase() !== 'GET') {
      throw new ReadOnlyViolation(
        `Phase 0 is read-only: refused ${method.toUpperCase()} ${path}`
      );
    }
    const lower = path.toLowerCase();
    for (const banned of MUTATION_DENYLIST) {
      if (lower.includes(banned)) {
        throw new ReadOnlyViolation(
          `Phase 0 is read-only: path "${path}" matches mutation denylist entry "${banned}"`
        );
      }
    }
  }

  /** Serialise requests with a minimum spacing to respect rate limits. */
  _throttle() {
    this._chain = this._chain.then(async () => {
      const since = Date.now() - this._lastRequestAt;
      const wait = this.minIntervalMs - since;
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      this._lastRequestAt = Date.now();
    });
    return this._chain;
  }

  /**
   * Perform an authenticated GET.
   * @returns {Promise<{status:number, body:any, headers:object, rateLimit:object}>}
   */
  async get(pathWithQuery, { retries = 3 } = {}) {
    KalshiClient.assertReadOnly('GET', pathWithQuery);

    let attempt = 0;
    // Retry on 429 and 5xx with exponential backoff.
    for (;;) {
      await this._throttle();
      const timestampMs = Date.now().toString();
      const signPath = pathForSigning(pathWithQuery);
      const signature = signRequest({
        privateKey: this.privateKey,
        timestampMs,
        method: 'GET',
        path: signPath,
      });

      let res;
      try {
        res = await fetch(`${this.baseUrl}${pathWithQuery}`, {
          method: 'GET',
          headers: {
            'KALSHI-ACCESS-KEY': this.keyId,
            'KALSHI-ACCESS-TIMESTAMP': timestampMs,
            'KALSHI-ACCESS-SIGNATURE': signature,
            Accept: 'application/json',
            'User-Agent': 'founder-btc-alpha/0.1 (phase0-capture)',
          },
        });
      } catch (err) {
        if (attempt >= retries) throw err;
        await new Promise((r) => setTimeout(r, 400 * 2 ** attempt));
        attempt += 1;
        continue;
      }

      this.requestCount += 1;
      const headers = Object.fromEntries(res.headers.entries());
      const rateLimit = extractRateLimitHeaders(headers);
      if (Object.keys(rateLimit).length) this.lastRateLimitHeaders = rateLimit;

      const text = await res.text();
      let body;
      try {
        body = text ? JSON.parse(text) : null;
      } catch {
        body = { _raw: text };
      }

      if ((res.status === 429 || res.status >= 500) && attempt < retries) {
        const retryAfter = Number(headers['retry-after']);
        const delay = Number.isFinite(retryAfter)
          ? retryAfter * 1000
          : 500 * 2 ** attempt;
        await new Promise((r) => setTimeout(r, delay));
        attempt += 1;
        continue;
      }

      return { status: res.status, body, headers, rateLimit };
    }
  }

  // ---- read-only endpoint helpers -------------------------------------

  getExchangeStatus() {
    return this.get('/trade-api/v2/exchange/status');
  }

  getSeries(seriesTicker) {
    return this.get(`/trade-api/v2/series/${encodeURIComponent(seriesTicker)}`);
  }

  getEvents(params = {}) {
    return this.get(`/trade-api/v2/events${qs(params)}`);
  }

  getEvent(eventTicker, params = {}) {
    return this.get(
      `/trade-api/v2/events/${encodeURIComponent(eventTicker)}${qs(params)}`
    );
  }

  getMarkets(params = {}) {
    return this.get(`/trade-api/v2/markets${qs(params)}`);
  }

  getMarket(ticker) {
    return this.get(`/trade-api/v2/markets/${encodeURIComponent(ticker)}`);
  }

  /** Orderbook depth for a single market. */
  getOrderbook(ticker, depth = 100) {
    return this.get(
      `/trade-api/v2/markets/${encodeURIComponent(ticker)}/orderbook${qs({ depth })}`
    );
  }

  getTrades(params = {}) {
    return this.get(`/trade-api/v2/markets/trades${qs(params)}`);
  }

  /** Historical settlements for a series/market (read-only). */
  getMarketCandlesticks(seriesTicker, ticker, params = {}) {
    return this.get(
      `/trade-api/v2/series/${encodeURIComponent(seriesTicker)}/markets/${encodeURIComponent(
        ticker
      )}/candlesticks${qs(params)}`
    );
  }
}

export function qs(params) {
  const entries = Object.entries(params).filter(
    ([, v]) => v !== undefined && v !== null && v !== ''
  );
  if (!entries.length) return '';
  const sp = new URLSearchParams();
  for (const [k, v] of entries) sp.append(k, String(v));
  return `?${sp.toString()}`;
}

export function extractRateLimitHeaders(headers) {
  const out = {};
  for (const [k, v] of Object.entries(headers)) {
    const lk = k.toLowerCase();
    if (
      lk.startsWith('x-ratelimit') ||
      lk.startsWith('ratelimit') ||
      lk === 'retry-after' ||
      lk.startsWith('x-rate-limit')
    ) {
      out[lk] = v;
    }
  }
  return out;
}

/** Build a client from environment variables. */
export function clientFromEnv({ env = 'prod' } = {}) {
  const prefix = env === 'demo' ? 'KALSHI_DEMO_' : 'KALSHI_';
  const keyId = process.env[`${prefix}KEY_ID`];
  const pem = process.env[`${prefix}PRIVATE_KEY_PEM`];
  if (!keyId || !pem) {
    const err = new Error(
      `Missing ${prefix}KEY_ID and/or ${prefix}PRIVATE_KEY_PEM in environment`
    );
    err.code = 'MISSING_CREDENTIALS';
    throw err;
  }
  return new KalshiClient({ keyId, privateKeyPem: pem, env });
}

export { ReadOnlyViolation, MUTATION_DENYLIST, PROD_BASE, DEMO_BASE };
