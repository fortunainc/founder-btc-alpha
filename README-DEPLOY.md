# Deploying the Phase 0 capture worker (Railway)

Single always-on worker. No HTTP port, no health-check endpoint — Railway keeps it alive via
the restart policy in `railway.json`.

**Nothing here has been deployed.** Deployment is BLOCKED pending founder action; see §6.

---

## 1. Prerequisites

| Requirement | Status |
|---|---|
| Railway project exists | **BLOCKED — founder must create** |
| Railway CLI authenticated | **BLOCKED — `railway whoami` returns "Unauthorized"** |
| Supabase migration applied | **BLOCKED — CTO applies `migrations/001-founder-alpha-v1.sql`** |
| GitHub repo private | **FAILED — repo is currently PUBLIC, see §7** |

Per the dispatch, no `railway login` prompt was issued and no deploy was attempted.

---

## 2. Environment variables

Set these in **Railway → your service → Variables**. Paste them yourself; they must never be
committed, and nothing in this repo will print them back to you.

| Variable | Required | What it is |
|---|---|---|
| `KALSHI_KEY_ID` | yes | Kalshi API key ID (a UUID). Not secret on its own, but treat it as such. |
| `KALSHI_PRIVATE_KEY_PEM` | yes | The RSA private key from Kalshi. **Secret.** See §3 for the format. |
| `SUPABASE_URL` | yes | `https://<project-ref>.supabase.co` |
| `SUPABASE_SERVICE_ROLE_KEY` | yes | Service-role JWT. **Secret** — bypasses RLS, so it is the most dangerous value here. |
| `KALSHI_SERIES_TICKER` | no | Defaults to `KXBTC15M`. |
| `CAPTURE_DRY_RUN` | no | `true` writes JSONL to disk instead of Supabase. Leave unset in production. |

If `SUPABASE_URL` or `SUPABASE_SERVICE_ROLE_KEY` is missing the worker does **not** crash — it
falls back to the dry-run sink and logs a warning. That is deliberate: a misconfigured deploy
should lose no data. It also means **a silently mis-set variable looks like a healthy worker**,
so confirm §5 shows Supabase mode after the first deploy.

---

## 3. Pasting the private key into Railway

The PEM is multi-line, which the Railway UI handles badly. Convert it to a single line with
escaped newlines first.

Run locally, in the repo root:

```bash
node -e 'const fs=require("fs");process.stdout.write(JSON.stringify(fs.readFileSync("kalshi-key.txt","utf8").trim()))'
```

That prints a double-quoted single-line string with `\n` escapes. Copy the **entire** output,
including the surrounding quotes, into the Railway value box.

The worker's env loader (`src/env.js`) accepts three forms — escaped single line (above),
quoted, and a `<<PEM` heredoc block — so the local `.env` and the Railway variable can differ
in shape without any code change.

> The command above prints your private key to the terminal. Run it in a window without
> screen-sharing, and clear your scrollback afterwards.

---

## 4. Exact Railway UI steps

1. **railway.app → New Project → Deploy from GitHub repo** → select `fortunainc/founder-btc-alpha`.
   *(Make the repo private first — §7.)*
2. Railway detects `Dockerfile` and uses it; `railway.json` pins builder, replica count, and
   restart policy. **No build configuration is needed in the UI.**
3. **Settings → Networking** — do **not** generate a domain. This is a worker.
4. **Variables → + New Variable** — add each row from §2. Use *Raw Editor* for the PEM.
5. **Settings → Deploy** — confirm:
   - Start command `node src/worker.js`
   - Replicas **1**. *More than one replica double-writes every row; the tables are
     append-only, so duplicates cannot be cleaned up afterwards.*
   - Restart policy `ON_FAILURE`, max retries 10.
6. **Deploy**, then verify against §5.

---

## 5. Verifying a live deploy

Watch **Deployments → View Logs**. Within ~90 seconds you should see:

```
INFO  === Founder BTC Alpha capture worker ===
INFO  series=KXBTC15M sink=supabase replica=replica-methodology-v1
INFO  macro calendar: 6 events
INFO  discovered window KXBTC15M-... close=... strike=...
INFO  flushed N row(s) (supabase)
INFO  heartbeat uptime=60s index=... venues[coinbase=ok kraken=ok bitstamp=ok gemini=ok] ...
```

Check all four:

- [ ] `sink=supabase` — **not** `dry-run`. Dry-run means §2 variables did not land.
- [ ] All four venues `ok` in the heartbeat. One `STALE` is tolerable (Kraken quotes on change,
      so it ages out during quiet periods); two or more means degraded index quality.
- [ ] `flushed N row(s) (supabase)` appearing about every 5s.
- [ ] A heartbeat every 60s.

Then confirm rows are actually landing, in the Supabase SQL editor:

```sql
SELECT count(*), max(ts) FROM founder_alpha.fa_window_capture;
SELECT * FROM founder_alpha.v_fa_capture_health;
```

`v_fa_capture_health` is the one to watch over time: it censuses >30s gaps and invariant
violations per day.

---

## 6. Blocked items

| # | Blocker | Owner | Unblocks |
|---|---|---|---|
| 1 | Railway project does not exist | Founder | Everything in §4 |
| 2 | Railway CLI unauthenticated (`railway whoami` → Unauthorized) | Founder | CLI-based deploy. Per dispatch, no login prompt was issued. |
| 3 | Supabase migration not applied | CTO | Worker runs but falls back to dry-run |
| 4 | Repo is public | Founder | §7 |

---

## 7. Repo visibility — action required

`gh repo create --private` could not be used: the `gh` CLI is not installed on the build
machine. The repo was created manually and an unauthenticated API probe returned **HTTP 200**,
meaning it is **publicly readable**. Fixture: `fixtures/10-repo-visibility.json`.

No credential material was pushed — a pre-commit scan confirmed zero base64 key bodies and zero
occurrences of the key ID in tracked files, and `kalshi-key.txt` / `.env` have been gitignored
since commit #1. The exposure is of research methodology, not secrets.

Fix:

1. <https://github.com/fortunainc/founder-btc-alpha/settings>
2. **Danger Zone → Change repository visibility → Make private**
3. Re-verify: `node scripts/check-visibility.js` (exits 0 once private)

---

## 8. Cost and scale

At the specified cadence, one window produces ~180 rows (13 min at 5s + 2 min at 1s batched
into 5s flushes). At 96 windows/day that is **~17k rows/day, ~520k/month**.

Writes are batched to at most one insert per 5s regardless of how many snapshots it carries, so
the worker issues ~17k inserts/day, not one per row.

The single always-on container is the dominant cost; the worker is I/O-bound and nearly idle on
CPU.
