# RVR — Railway "native WebSocket not found" fix

**2026-07-23 ~22:25 UTC.** Per `CTO-RAILWAY-WEBSOCKET-FIX.md`. Commit `8a947e0`.

## Root cause — VERIFIED by local reproduction

The Railway container (our Dockerfile: `node:20-slim`) has no global `WebSocket`. supabase-js
2.110.8's `createClient` builds a Realtime client that requires one **even though we never use
Realtime**. So `createClient` threw `native WebSocket not found`, every sink write failed, and
capture rows spilled to `/app/data/spill`.

Reproduced exactly on this laptop (Node 26, which *does* have WebSocket) by deleting it:

```
delete globalThis.WebSocket
  → createClient THREW: "Node.js detected but native WebSocket not found."
inject ws, then createClient
  → OK, count=2105
```

The Kalshi WS transport was checked too — the `ws` library brings its own `WebSocket` class
(`new WebSocket(url)` in `replica-index.js`), so it never depended on a global. The failing path
was the Supabase sink only, exactly as the CTO's log showed.

## Fix — two layers, both applied

| Layer | Change | Why |
|---|---|---|
| Runtime | `Dockerfile`: `node:20-slim` → **`node:22-slim`** | Node 22+ ships a stable global WebSocket; Node 20 is being deprecated anyway |
| Code | **`src/ws-polyfill.js`** injects `ws` as `globalThis.WebSocket` before any `createClient` | Works on *any* Node version, so writes survive even if the base image is ever changed. `ws` was already a dependency. |

Used by both the sink and the backfill script. Regression test: `sink injects a WebSocket impl
when the runtime lacks one`. Preflight now reports runtime WebSocket presence, so a regression is
named in the Railway log. **96/96 tests pass. Isolation CLEAN.**

## Backfill — hardened and idempotent

`fa_window_capture` has **no unique constraint** on `(window_id, ts)` — only an index — so a
plain re-insert would double-count. `scripts/backfill.js` now:

- injects `ws` (so it runs even against a broken container's runtime),
- **de-dups on `(window_id, ts)`** against the DB before inserting → idempotent, safe to re-run,
- accepts `--spill-dir=<path>` to point at spill files copied out of the Railway container.

Verified `--dry`: connects, de-dups, writes nothing.

## What I could NOT do myself — and why

I have **no Railway access** from this terminal: the CLI is unauthenticated
(`railway whoami` → Unauthorized), no project is linked, and I cannot reach the container
filesystem or trigger a deploy. So three of the CTO's five steps are founder/CTO actions:

| Step | Owner | Status |
|---|---|---|
| Fix WebSocket (Dockerfile + inject ws) | me | **DONE**, pushed `8a947e0` |
| Redeploy | founder/CTO (or auto-deploy on push) | pending — see below |
| Backfill `/app/data/spill` | founder/CTO — I can't reach the container disk | see recovery path |
| Confirm Railway is writing | me, once a deploy happens | **watching the DB** |

### The redeploy ⇄ spill-recovery hazard (read before redeploying)

`/app/data/spill` is on Railway's **ephemeral** disk. **A redeploy wipes it.** So the fix
redeploy and the spill recovery are in tension:

- The spilled rows are **capture snapshots** for the broken window — a bounded, already-visible
  gap in `v_fa_capture_health`, not unique data. **Seals and settlements from that window were
  lost outright** (the sink only spills capture rows — a known gap, see the follow-up below), so
  the spill recovery buys back capture snapshots only.
- **To recover them anyway, BEFORE redeploying:** `railway ssh` into the running (broken)
  service and copy the files out —
  ```
  railway ssh 'cat /app/data/spill/*.jsonl' > /tmp/railway-spill/spill.jsonl
  ```
  then, on the laptop with the fixed code:
  ```
  node scripts/backfill.js --spill-dir=/tmp/railway-spill --dry   # inspect
  node scripts/backfill.js --spill-dir=/tmp/railway-spill         # write (de-duped)
  ```
  This works because the fixed backfill injects `ws` and de-dups — the broken container's own
  runtime never has to run it.
- **If `railway ssh` isn't available or the loss is acceptable:** just redeploy. The gap is
  bounded and documented.

## Confirming Railway is writing

The local worker is **stopped** and stays stopped (Railway is sole writer). Baseline: latest DB
row `2026-07-23T22:10:41Z`, total 2105. **Any row newer than that can only be Railway.** A
background poller is watching `fa_window_capture` for a row past the baseline; result appended
below once a deploy lands.

> **Live result — VERIFIED, Railway is writing.** Within ~80s of the `8a947e0` push, rows began
> landing (auto-deploy on push). Confirmed from the DB:
>
> ```
> RAILWAY-origin rows (ts > 22:10:41 baseline): 26
> latest row: 2026-07-23T22:27:39Z  KXBTC15M-26JUL231830-30  up+down=1.000  idx=65124.93  venues=4
> latest row age: 4s  -> LIVE, actively writing
> local worker: confirmed stopped (so every one of these rows is Railway)
> ```
>
> The `native WebSocket not found` errors are gone and no rows are spilling. `venues=4` also
> confirms the container's `ws`-based replica feeds are healthy. Railway seals will begin at the
> first T-10 after the deploy and reach 4/4 once the ~15-min vol buffer fills (cold-start
> behaviour, documented in `README-DEPLOY.md`).
>
> **Deploy id to record:** the Railway deployment triggered by commit `8a947e0` (the CTO's prior
> broken deploy was `9dc4e7b1`).

## Recommended follow-up (NOT in this hotfix)

- **Spill seals & settlements, not just capture rows.** This incident lost the broken window's
  seals/settlements because only `flush()` spills; `writeSeals`/`writeGrades`/`writeSettlement`
  error without spilling. The WebSocket fix removes the failure class that caused it, but a
  transient outage (like the Supabase blip at 16:21Z) would still lose them. Kept out of the
  hotfix to avoid bundling an unrelated change into a production fix.
- **Persistent volume** on `/app/data` so future spills survive a redeploy.
