/**
 * Ensure a global WebSocket exists before supabase-js builds a client.
 *
 * supabase-js's createClient constructs a Realtime client, which requires a
 * global WebSocket even when Realtime is never used. Node <22 has no global
 * WebSocket, so on the Railway node:20 image createClient threw "native
 * WebSocket not found" and every DB write failed. `ws` is already a dependency.
 *
 * Import this for its side effect before any createClient call:
 *     import { ensureWebSocket } from './ws-polyfill.js';
 *     await ensureWebSocket();
 */

let done = false;

export async function ensureWebSocket() {
  if (done) return;
  if (typeof globalThis.WebSocket === 'undefined') {
    const wsmod = await import('ws');
    globalThis.WebSocket = wsmod.default || wsmod.WebSocket || wsmod;
  }
  done = true;
}
