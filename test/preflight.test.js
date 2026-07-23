import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { preflight } from '../src/preflight.js';

const realPem = fs.existsSync('kalshi-key.txt')
  ? fs.readFileSync('kalshi-key.txt', 'utf8').trim()
  : null;

const GOOD = {
  KALSHI_KEY_ID: 'c8b86e37-cd98-4127-ae60-228436dae84c',
  KALSHI_PRIVATE_KEY_PEM: realPem,
  SUPABASE_URL: 'https://abcdef.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'a.b.c',
};

const status = (r, name) => r.checks.find((c) => c.name === name)?.status;

test('healthy config passes', { skip: !realPem }, () => {
  const r = preflight(GOOD);
  assert.equal(r.ok, true);
  assert.equal(r.fatal, null);
  assert.equal(status(r, 'KALSHI_PRIVATE_KEY_PEM'), 'OK');
});

test('PEM with newlines collapsed to spaces is a fatal, NAMED fault', { skip: !realPem }, () => {
  const r = preflight({ ...GOOD, KALSHI_PRIVATE_KEY_PEM: realPem.replace(/\n/g, ' ') });
  assert.equal(r.ok, false);
  assert.match(r.fatal, /newlines lost/);
  assert.equal(status(r, 'KALSHI_PRIVATE_KEY_PEM'), 'FAIL');
});

test('escaped-newline PEM (the correct Railway form) passes', { skip: !realPem }, () => {
  const r = preflight({ ...GOOD, KALSHI_PRIVATE_KEY_PEM: realPem.replace(/\n/g, '\\n') });
  assert.equal(status(r, 'KALSHI_PRIVATE_KEY_PEM'), 'OK');
  assert.equal(r.ok, true);
});

test('truncated PEM (only the header) is fatal', () => {
  const r = preflight({ ...GOOD, KALSHI_PRIVATE_KEY_PEM: '-----BEGIN RSA PRIVATE KEY-----' });
  assert.equal(r.ok, false);
  assert.equal(status(r, 'KALSHI_PRIVATE_KEY_PEM'), 'FAIL');
});

test('missing PEM is fatal', () => {
  const r = preflight({ ...GOOD, KALSHI_PRIVATE_KEY_PEM: undefined });
  assert.equal(r.ok, false);
  assert.match(r.fatal, /missing/);
});

test('missing key id is fatal', () => {
  const r = preflight({ ...GOOD, KALSHI_KEY_ID: undefined });
  assert.equal(r.ok, false);
});

test('dry-run on is a WARN, not fatal — the worker still boots', { skip: !realPem }, () => {
  const r = preflight({ ...GOOD, CAPTURE_DRY_RUN: 'true' });
  assert.equal(r.ok, true); // boots, but...
  assert.equal(status(r, 'CAPTURE_DRY_RUN'), 'WARN'); // ...loudly warns
});

test('SUPABASE_URL ending in /rest/v1 is warned, not fatal', { skip: !realPem }, () => {
  const r = preflight({ ...GOOD, SUPABASE_URL: 'https://abcdef.supabase.co/rest/v1/' });
  assert.equal(status(r, 'SUPABASE_URL'), 'WARN');
  assert.equal(r.ok, true);
});

test('missing Supabase config is a WARN (falls back to dry-run), not fatal', { skip: !realPem }, () => {
  const r = preflight({ ...GOOD, SUPABASE_URL: undefined, SUPABASE_SERVICE_ROLE_KEY: undefined });
  assert.equal(r.ok, true);
  assert.equal(status(r, 'SUPABASE_URL'), 'WARN');
});

test('preflight never returns a secret value in its output', { skip: !realPem }, () => {
  const r = preflight(GOOD);
  const blob = JSON.stringify(r);
  assert.ok(!blob.includes(realPem.slice(50, 90)), 'PEM body must not appear in output');
  assert.ok(!blob.includes('a.b.c'), 'service key must not appear verbatim');
});
