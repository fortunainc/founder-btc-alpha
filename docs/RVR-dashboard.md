# RVR — Founder dashboard + Railway WebSocket re-verification

**2026-07-23 ~22:40 UTC.** Commit `8714f4b`.

---

## Task 1 — Railway "native WebSocket not found": DONE (re-verified)

This was shipped last turn in `8a947e0` (full detail in `docs/RVR-railway-websocket-fix.md`).
Re-verified now against the live system:

| Check | Result |
|---|---|
| Fix in code | `ensureWebSocket()` in `src/sink.js` + `scripts/backfill.js`; Dockerfile `node:22-slim` |
| Railway writing | latest `fa_window_capture` row **6s old**, `venues=3–4` — LIVE |
| Local worker | **stopped** — Railway is sole writer |
| Migration 003 | **now applied** (`v_fa_window_calls`, `v_fa_call_scoreboard` both present) |

**Spill backfill — not recoverable, and why.** The `/app/data/spill` rows lived on the old
container's **ephemeral** disk and were wiped when the fix redeployed. I have no Railway
container access to have copied them out first. They were **capture snapshots only** (a bounded,
already-visible gap in `v_fa_capture_health`); that window's seals/settlements were lost outright
because the sink only spills capture rows. `scripts/backfill.js` is now hardened (injects `ws`,
de-dups on `(window_id, ts)`, takes `--spill-dir`) so any *future* spill copied off a container
can be replayed idempotently.

---

## Task 2 — Founder dashboard: VERIFIED locally, staged for Railway

`src/dashboard.js`. One route: `GET /dash?token=<FOUNDER_DASH_TOKEN>`.

### Security posture (this process holds the service_role key)

| Property | How |
|---|---|
| One route only | Every non-`/dash` path/method → 404, no detail |
| Token required | Constant-time compare (`crypto.timingSafeEqual`) |
| Fail-closed | No `FOUNDER_DASH_TOKEN` → HTTP server never binds |
| Read-only | Only SELECTs on `founder_alpha` views; cannot write |
| No key exposure | Page rendered server-side; browser never receives the key |
| No token leakage | Token never logged; request logs omit the query string |
| Hardened headers | CSP `default-src 'none'`, `nosniff`, `no-referrer` |
| XSS-safe | All string fields HTML-escaped (even though data is trusted) |

### Runtime proof (local, against the live DB)

| Request | Result |
|---|---|
| `/dash` (no token) | **401** |
| `/dash?token=wrong` | **401** |
| `/` and `/../.env` | **404** |
| `/dash?token=<valid>` | **200**, 15.5 KB self-contained HTML |
| secret scan of body | no JWT, no token, no Kalshi key, no Supabase URL |
| content | all 4 call states (YES/NO/FAIR/THIN), right/wrong/pending, capture-alive `live · 5s ago`, SHADOW banner, 2 tables, `refresh content="10"`, **0 external URLs** |

### What it shows

- **Window calls** (`v_fa_window_calls`, latest 45): close time (PT), window, seal point, colored
  call, models% (consensus_p), market% (market_p), divergence, and result (✓ right / ✗ wrong /
  pending). FAIR "right" = settled with the market's favourite.
- **Call scoreboard** (`v_fa_call_scoreboard`): per seal-point × call — total, graded, accuracy,
  mean |divergence|.
- **Capture-alive light:** green if a row landed in the last 60s, red + age otherwise.
- **SHADOW banner:** prominent; "no orders · no capital · labeled shadow until Day-14".

Times are Pacific (`America/Los_Angeles`), auto-refreshes every 10s via meta-refresh (the token
in the URL is preserved on reload).

### Deploy integration

Worker starts the dashboard only when `sink=supabase` **and** `FOUNDER_DASH_TOKEN` is set,
listening on `$PORT` (Railway) else `DASH_PORT`. Closed on graceful shutdown. `Dockerfile`
`EXPOSE 8787` + docs; `README-DEPLOY.md §9` has the Railway public-domain steps.

**105/105 tests pass. Isolation CLEAN.** New tests: `test/dashboard.test.js` (auth, render,
capture-alive, all states, XSS-escape, no-secret, graceful degradation).

---

## What needs the founder (I have no Railway access)

The code is deployed via push (`8714f4b` auto-deploys). Two Railway UI steps remain, because I
cannot set env vars or enable a domain from here:

1. **Variables → add `FOUNDER_DASH_TOKEN`** = the value handed off separately (also in the
   gitignored `dash-token.txt`). Redeploys; log shows `[dash] founder dashboard listening…`.
2. **Settings → Networking → Generate Domain.** Final URL:
   `https://<generated-domain>/dash?token=<FOUNDER_DASH_TOKEN>`.

Until the token is set on Railway the dashboard is fail-closed (no server) — capture and sealing
are unaffected either way.
