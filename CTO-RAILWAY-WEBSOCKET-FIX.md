# CTO — Railway blocker resolved to root cause (2026-07-23 15:16 PT). Execute now.
PROGRESS: the CTO attached all 4 shared variables to the Railway service (was "0 of 4 in use" — the
values were in Shared Variables but never referenced by the service). Preflight now PASSES; the
missing-env-var crash class is gone.

NEW ROOT CAUSE (from live deploy 9dc4e7b1 logs):
  ERROR [sink] flush failed ... "native WebSocket not found. Ensure you are running Node.js 22+ or
  provide a WebSocket implementation via the transport option."
  ERROR [sink] SPILLED N row(s) to /app/data/spill/*.jsonl (17+ consecutive failures). Data preserved.
The Railway container's Node runtime has no global WebSocket, which the Supabase client (and/or the
Kalshi WS transport) requires. Writes fail; rows spill to disk (nothing lost, but nothing reaches the DB).

FIX (pick the robust one, verify on Railway, RVS):
1. Dockerfile: base image to Node 22+ (e.g. FROM node:22-slim / node:22-alpine) so globalThis.WebSocket
   exists — OR
2. Add the `ws` package and inject it: for supabase-js pass `global: { WebSocket: require('ws') }` /
   set globalThis.WebSocket = require('ws') at worker boot; for the Kalshi client pass ws as the
   transport. Prefer whichever the code actually needs — the log says the SINK flush is the failing path,
   so the Supabase client's transport is the priority; check the Kalshi WS too.
3. Redeploy. Confirm in Railway logs: preflight [OK], sink=supabase live writes, no "WebSocket not found".
4. BACKFILL the spilled rows: replay /app/data/spill/*.jsonl into founder_alpha.fa_window_capture
   (idempotent — the append-only + any dedup must not double-count; if no natural key, de-dup on
   (window_id, ts)). Report how many rows were spilled and backfilled.
5. Confirm from the DB that fa_window_capture receives rows with ts AFTER the redeploy, from Railway
   (local worker is STOPPED — do not restart it; Railway is now the sole writer).
RVR with the deploy id + a live row count from Railway.
