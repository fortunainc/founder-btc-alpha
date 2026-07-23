import test from 'node:test';
import assert from 'node:assert/strict';
import { SupabaseSink } from '../src/sink.js';

test('sink injects a WebSocket impl when the runtime lacks one', async () => {
  // Simulate a Node <22 container: no global WebSocket.
  const saved = globalThis.WebSocket;
  delete globalThis.WebSocket;
  try {
    const sink = new SupabaseSink({ url: 'https://x.supabase.co', serviceRoleKey: 'a.b.c' });
    // _ensureClient must polyfill WebSocket before createClient, not throw.
    await sink._ensureClient();
    assert.equal(typeof globalThis.WebSocket, 'function',
      'sink must have injected a WebSocket implementation');
  } finally {
    if (saved) globalThis.WebSocket = saved;
  }
});

test('sink reuses the client once built', async () => {
  const sink = new SupabaseSink({ url: 'https://x.supabase.co', serviceRoleKey: 'a.b.c' });
  const a = await sink._ensureClient();
  const b = await sink._ensureClient();
  assert.equal(a, b);
});
