// R5/S1 (2026-07-26): /dash auth moves off the URL token. One-time ?token=
// bootstrap → 302 + HttpOnly cookie → clean-URL steady state; Bearer for curl.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startDashboard } from '../src/dashboard.js';

const TOKEN = 't'.repeat(32);
function get(port, path, headers = {}) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path, headers }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }));
    }).on('error', reject);
  });
}
async function withServer(fn) {
  const server = startDashboard({
    getClient: async () => { throw new Error('no db in auth tests'); },
    token: TOKEN, port: 0, logger: { info() {}, warn() {}, error() {} },
  });
  await new Promise((r) => server.on('listening', r));
  try { await fn(server.address().port); } finally { server.close(); }
}

test('bootstrap: valid ?token= → 302 to clean /dash with HttpOnly Secure cookie; token gone from URL', async () => {
  await withServer(async (port) => {
    const r = await get(port, `/dash?token=${TOKEN}`);
    assert.equal(r.status, 302);
    assert.equal(r.headers.location, '/dash');
    const c = r.headers['set-cookie'][0];
    assert.match(c, /^fa_dash=[0-9a-f]{64}; /);
    assert.match(c, /HttpOnly/); assert.match(c, /Secure/); assert.match(c, /SameSite=Lax/); // Lax: survives link-clicks from chat/notes
  });
});

test('steady state: cookie authenticates; no cookie/bad cookie → 401; bad token → 401 (no cookie)', async () => {
  await withServer(async (port) => {
    const boot = await get(port, `/dash?token=${TOKEN}`);
    const cookie = boot.headers['set-cookie'][0].split(';')[0];
    const ok = await get(port, '/dash', { cookie });
    assert.equal(ok.status, 500); // authed → tries DB → our test client throws. NOT 401.
    assert.equal((await get(port, '/dash')).status, 401);
    assert.equal((await get(port, '/dash', { cookie: 'fa_dash=' + 'a'.repeat(64) })).status, 401);
    const bad = await get(port, `/dash?token=WRONG${TOKEN}`);
    assert.equal(bad.status, 401);
    assert.equal(bad.headers['set-cookie'], undefined);
  });
});

test('curl path: Authorization Bearer authenticates; other routes stay 404', async () => {
  await withServer(async (port) => {
    assert.equal((await get(port, '/dash', { authorization: `Bearer ${TOKEN}` })).status, 500); // authed
    assert.equal((await get(port, '/dash', { authorization: 'Bearer nope' })).status, 401);
    assert.equal((await get(port, '/', { authorization: `Bearer ${TOKEN}` })).status, 404);
  });
});
