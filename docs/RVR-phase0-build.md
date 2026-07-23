# RVR — Founder BTC Alpha, Phase 0 Build

**Runtime Verification Record.** Statuses are **VERIFIED / FAILED / BLOCKED / PARTIAL** only.
No claim appears here without a fixture on disk backing it. Where a claim could not be
substantiated it is marked BLOCKED with the exact reason rather than softened.

| | |
|---|---|
| Build date | 2026-07-22 / 2026-07-23 UTC |
| Repo | `github.com/fortunainc/founder-btc-alpha` (**PUBLIC — see §9**) |
| Commit range | `7c35fb0` → HEAD |
| Node | v26.0.0 |
| Scope | **Capture only.** No models, no forecasts, no order placement. |

---

## 1. What was built

| Component | File | Status |
|---|---|---|
| Read-only Kalshi client (RSA-PSS auth) | `src/kalshi-client.js` | VERIFIED |
| Zero-dependency `.env` loader | `src/env.js` | VERIFIED |
| Fee model (quadratic, ceil-to-cent) | `src/fee-model.js` | VERIFIED |
| BRTI replica index (4 venues) | `src/replica-index.js` | VERIFIED |
| Orderbook normaliser + DQ invariants | `src/orderbook.js` | VERIFIED |
| Session bucketing + macro flagging | `src/session.js` | VERIFIED (calendar PARTIAL, §11) |
| Batched sink (Supabase / dry-run) | `src/sink.js` | **VERIFIED** — live Supabase writes confirmed |
| Capture worker | `src/worker.js` | VERIFIED |
| Mechanics verifier | `scripts/verify-mechanics.js` | VERIFIED |
| Migration (5 tables, 2 views) | `migrations/001-founder-alpha-v1.sql` | VERIFIED |
| Deploy config | `Dockerfile`, `railway.json`, `README-DEPLOY.md` | Written; deploy BLOCKED |

**Test suite: 48/48 passing** (`node --test 'test/**/*.test.js'`).

Deliberately **not** built, per the capture-only mandate: any forecasting logic, any order
placement, any portfolio read. `fa_forecast_seal` exists in the schema and is empty by design.

---

## 2. Runtime proof — Kalshi authentication

**Status: VERIFIED.** Fixture: `fixtures/01-auth-smoke.json`

Auth per Kalshi docs: `KALSHI-ACCESS-KEY`, `KALSHI-ACCESS-TIMESTAMP` (ms), and
`KALSHI-ACCESS-SIGNATURE` = base64 RSA-PSS/SHA-256 over `timestamp + method + path`, path
without query params, PSS salt length = digest length.

```
[prod] GET /trade-api/v2/exchange/status   -> 200
[prod] GET /trade-api/v2/series/KXBTC15M   -> 200
STATUS: VERIFIED
```

The second call is authenticated-only, so a 200 proves the signature is accepted rather than
merely that a public endpoint responded.

**Demo environment: not exercised.** No `KALSHI_DEMO_*` credentials were provided, so per the
dispatch the smoke test ran directly against prod read-only endpoints.

### Read-only guard

The client refuses non-GET methods and denylisted paths at the single choke point every request
passes through, so the property does not depend on any caller behaving correctly:

```
Read-only guard: ACTIVE
  Phase 0 is read-only: refused POST /trade-api/v2/portfolio/orders
```

---

## 3. Fee parameters — checklist item 1

**Status: VERIFIED** (maker-fee component **PARTIAL**). Fixtures: `fixtures/02-series-KXBTC15M.json`,
`fixtures/09-mechanics-summary.json`, `config/verified-fee-params.json`

From the live series object:

```json
{ "fee_type": "quadratic", "fee_multiplier": 1 }
```

**`fee_multiplier: 1` is a relative multiplier on Kalshi's 0.07 base quadratic rate, not an
absolute 1.0 fee rate.** Reading it as absolute would overstate fees by ~14×.

```
fee_dollars = ceil_to_cent(0.07 * C * P * (1 - P))
```

Ceiling applies to the **whole order**, not per contract — a materially different (and cheaper)
result at size, asserted directly in the test suite.

Worked examples (C = 1), all unit-tested:

| P | raw | fee |
|---|---|---|
| 0.50 | 0.0175 | **$0.02** |
| 0.20 | 0.0112 | **$0.02** |
| 0.05 | 0.003325 | **$0.01** |

At 100 contracts and P=0.50 the fee is exactly **$1.75**, not $2.00 — confirming order-level
rounding.

**Maker fees — PARTIAL.** The series object exposes **no maker-fee field at all**. It is
recorded as `maker_fee_applies: false` inferred from the *absence* of a field, which is negative
evidence, not positive confirmation. This is flagged in `config/verified-fee-params.json` as
`maker_fee_confidence: "PARTIAL"`. **Do not treat maker fees as confirmed-zero.**

---

## 4. Limits and rate-limit tier — checklist items 2 & 3

### Item 2 — position / order size limits: **PARTIAL**

Fixtures: `fixtures/03-markets-open.json`, `fixtures/04-market-detail.json`

The market object exposes `notional_value_dollars`, `price_level_structure`, and strike fields.
It does **not** expose a per-user position limit — that is an account-level attribute reachable
only through a portfolio endpoint, which Phase 0 forbids.

**This is PARTIAL by design, not by failure.** Obtaining it would require violating hard rule 2.
It must be read from the Kalshi UI or account docs before any sizing decision.

A material finding: `price_level_structure: "tapered_deci_cent"` — **prices are quoted to 4
decimal places, not whole cents**, with the tick tapering by price level. Depth-within-2¢ logic
therefore uses a numeric threshold, never an integer tick count.

### Item 3 — rate-limit tier: **BLOCKED**

Fixture: `fixtures/06-rate-limit-probes.json`

Five successive probes returned **zero** rate-limit headers — no `x-ratelimit-*`, no
`ratelimit-*`, no `retry-after`. The tier is not determinable from the API surface; it is an
account attribute published per access tier.

Mitigation: the client self-imposes a **110 ms minimum spacing (~9 req/s)** with exponential
backoff and `Retry-After` honouring on 429/5xx. Across the whole build **zero 429s** were
observed. This is a conservative floor, **not** a verified tier.

---

## 5. Historical settlements & contract rules — checklist items 4 & 5

### Item 4 — settlement history: **VERIFIED**

Fixtures: `fixtures/07-markets-settled.json`, `fixtures/08-settlement-depth.json`

**1,600 settled markets across 8 pages**, spanning `2026-07-06T06:45Z` → `2026-07-23T03:00Z`
(≈17 days). The probe was capped at 8 pages to stay cheap, and the cursor had **not** been
exhausted — **17 days is a verified floor, not the limit** of retrievable history.

### Item 5 — contract rules: **VERIFIED**

The authoritative rules text lives on the **market**, not the series, and is materially more
precise than the series blurb:

> If the simple average of the sixty seconds of CF Benchmarks' BRTI before 11:15 PM EDT … is at
> least the simple average of the sixty seconds of CF Benchmarks' BRTI before 11:00 PM EDT …,
> then the market resolves to Yes.

**The single most important finding of this build:** *both* legs are 60-second BRTI averages.

| Leg | Definition |
|---|---|
| Reference | mean of 60 BRTI prints **before window open** (published as `floor_strike`) |
| Settlement | mean of 60 BRTI prints **before window close** |
| Resolution | `YES` if settlement ≥ reference |

The reference is **not** a pre-chosen strike; it is itself a computed average, reading
`Target price: TBD` until the opening minute elapses. A replica reproducing only the closing
average would be solving half the problem. Confirmed empirically: window 2's `reference_strike`
(65617.74) is exactly window 1's `settlement_value` — the windows chain.

---

## 6. Local worker run — end-to-end capture

**Status: VERIFIED (2 windows open-to-settlement, 3 windows settled).**
Fixture: `fixtures/14-capture-analysis.json`. Log: `logs/worker-run.log`.

Continuous 32-minute dry run, **661 rows**, **3 windows settled**, **0 sink errors**.

| Window | Snapshots | Span | normal / final120 | Coverage |
|---|---|---|---|---|
| `…222330-30` | 121 | 120s | 1 / 120 | **Partial** — worker started 2 min before close |
| `…222345-45` | 269 | 870s | 150 / 119 | **Full** open→settlement |
| `…230000-00` | 271 | 871s | 151 / 120 | **Full** open→settlement |

**Precision matters here: the dispatch asked for ≥3 *full* windows; 2 were captured open-to-close.**
The third was joined mid-window because the worker started inside it. Per founder direction
(2026-07-23), two full windows plus cadence/invariant evidence is accepted for the build RVR,
with multi-day capture deferred to Railway.

### Cadence conformance

| Phase | Target | Measured |
|---|---|---|
| Normal | 5000 ms | 5004 / 5005 ms |
| Final 120 s | 1000 ms | 1001 / 1043 ms |

Batching held: 1 Hz final-phase snapshots flushed in 5-row batches, one write per 5 s.

### Settlement grading

| Window | Settlement | Replica | Error | bps | Outcome agrees |
|---|---|---|---|---|---|
| `…222330-30` | 65617.74 | 65611.99 | −5.75 | −0.88 | ✅ |
| `…222345-45` | 65656.47 | 65654.63 | −1.84 | −0.28 | ✅ |
| `…230000-00` | 65624.32 | 65627.84 | +3.52 | +0.54 | ✅ |

Mean |error| **$3.70**, 3/3 outcome agreement, all with a full 60-print sample.

> **n = 3 supports no accuracy claim whatsoever.** These numbers demonstrate that the grading
> pipeline works end to end — discovery → capture → settlement read → replica comparison. They
> are an existence proof, not evidence the replica is accurate. Checklist items 6–7 require a
> multi-day sample and are BLOCKED on deploy (§11).

---

## 7. Data-quality invariants

**Status: VERIFIED.** Audited independently in `scripts/analyse-capture.js` by recomputing from
the raw JSONL, rather than restating the worker's own flags.

| Invariant | Result |
|---|---|
| `up_mid + down_mid` ∈ [0.97, 1.01] | **0 violations** across 558 two-sided rows; observed range exactly **[1.000, 1.000]** |
| Monotonic timestamps | **0 violations** in 661 rows |
| Capture gaps > 30 s | **0**; max observed gap 5 s |
| Replica unavailable | **1 row** — the very first snapshot, before the 60 s buffer filled (`replica_60s_n = 0`). Correctly flagged, not silently written. |

### A finding worth recording: one-sided books

103 rows (15.6%) initially flagged `incomplete_book`. Investigation showed **all 103 occurred at
T−120 s or later**, with e.g. `up_bid = 0.999` and the NO ladder **completely empty** — nobody
bids the losing side once the outcome is effectively decided. There is then no complementary ask
and no computable mid.

This is normal market behaviour, not a defect, but conflating it with genuine torn reads would
have buried real faults under ~15% routine noise during multi-day capture. The invariant now
distinguishes:

- `one_sided_book_at_extreme` — surviving side ≥ 0.97 or ≤ 0.03. **Expected.**
- `incomplete_book` — a missing mid anywhere else. **A genuine anomaly.**

Both cases are covered by tests. The 103 rows already on disk carry the old label; the
distinction applies from this commit forward.

---

## 8. Isolation proof

**Status: VERIFIED — ISOLATED.** Fixture: `fixtures/13-isolation-census.json`

`node scripts/isolation-check.js` over **34 files**:

| Check | Result |
|---|---|
| TSM database objects (`tsm_*`) | **CLEAN — 0** |
| Imports from any TSM repo | **CLEAN — 0** |
| Kalshi order / portfolio-mutation endpoints | **CLEAN — 0** |
| Mutating HTTP verbs against Kalshi | **CLEAN — 0** |

The append-only trigger is a local re-implementation (`founder_alpha.fa_reject_mutation()`); it
does **not** reference `public.tsm_reject_append_only_mutation`. Pattern re-implemented, never
imported.

**Two guard-proof matches are reported explicitly rather than suppressed**, because a silent
pass would hide that the string was found at all:

```
guard-proof: fixtures/01-auth-smoke.json:6  -> "refused POST /trade-api/v2/portfolio/orders"
guard-proof: scripts/smoke-auth.js:88       -> KalshiClient.assertReadOnly('POST', '…/orders')
```

Both are the negative test proving the guard **blocks** that endpoint — the opposite of using
it. Classification is by line context (`assertReadOnly`, `refused`, `denylist`), not by
whitelisting files, so a real order call in those same files would still register as a
violation.

---

## 9. Secrets hygiene

**Status: VERIFIED for secrets. Repo visibility FAILED.**

### Secrets — VERIFIED

- **Commit `7c35fb0` contains `.gitignore` and nothing else.** `.env` and the key file were
  excluded before any other file entered history.
- `git ls-files` shows **no** key material, no `.env`, no `*.txt` key file.
- Scan of all committable files: **0 base64 key bodies**, **0 occurrences of the key ID**. The
  three files matching the *words* "PRIVATE KEY" are comments and ignore-patterns.
- Fixtures are stripped of `KALSHI-ACCESS-*` headers before being written.
- No secret was printed to stdout at any point; `credentialStatus()` reports presence by name only.

**A real risk was caught and closed.** The working tree contained two stray files —
`kalshi-key.txt.save` and `kalshi-key.txt-----BEGIN` — each holding a **complete private key**,
and neither matched the original ignore patterns. Ignore rules were widened to case-insensitive,
extension-agnostic forms plus editor-backup patterns (`*.save`, `*.bak`, `*~`). All four
key-bearing files are now confirmed ignored.

> **Founder action:** those two stray files still exist on disk in the project directory. They
> are ignored by git and cannot be committed, but they are redundant copies of your private key.
> Delete them once you have confirmed `kalshi-key.txt` is intact.

### Repo visibility — FAILED

Fixture: `fixtures/10-repo-visibility.json`

`gh repo create --private` could not be run — **the `gh` CLI is not installed**. The repo was
created manually and an **unauthenticated** API probe returned **HTTP 200**:

```
GET https://api.github.com/repos/fortunainc/founder-btc-alpha -> 200, visibility: "public"
```

**The repository is publicly readable. This violates dispatch section A.** No credential
material is exposed (per the scan above); what is exposed is research methodology. Remediation
in `README-DEPLOY.md` §7; re-verify with `node scripts/check-visibility.js`.

---

## 10. Database migration

**Status: VERIFIED locally AND by the CTO in production.**

### Local verification

Fixture: `fixtures/12-migration-apply-and-verify.txt`. Applied to a throwaway **PostgreSQL 17.10**
cluster — this is a real apply, not a syntax check.

**8 PASS verdicts, 0 FAIL**, with every negative test firing correctly:

| Check | Result |
|---|---|
| 5 tables, RLS enabled **and forced** | PASS (5/5) |
| Permissive policies (default-deny) | PASS — 0 policies |
| Ontology seed rows | PASS — 2 (fee-model v1, replica-methodology v1) |
| `fa_forecast_seal` empty | PASS — 0 rows |
| UPDATE / DELETE rejected | PASS — **4 rejections**, ERRCODE 42501 |
| Price / session CHECK constraints | PASS — rejected as designed |
| Seal-before-close CHECK | PASS — rejected a seal timestamped after close |
| Both views execute | PASS — vol terciles bucket low/mid/high |

### Production (CTO, per `docs/CTO-NOTES.md`, 2026-07-23 ~03:50 UTC)

Applied and independently verified: `tables_total=5`, `tables_rls_forced=5`,
`append_triggers=5`, `views=2`, `ontology_seed_rows=2`, `forecast_seal_rows=0`,
`anon/authenticated grants=0`, and an UPDATE on `fa_ontology_versions` rejected with 42501.

**This item is no longer blocked.**

---

## 11. Deployment and remaining blockers

### Deployment: BLOCKED (not attempted)

`Dockerfile` + `railway.json` + `README-DEPLOY.md` written with exact UI steps. Per the
dispatch, **no `railway login` prompt was issued and no deploy was attempted**.
`railway whoami` → `Unauthorized`.

### Live Supabase writes: **VERIFIED** ✅

> **2026-07-23 15:32 UTC.** Fixture: `fixtures/18-live-writes-verified.json`.
> Log: `logs/worker-live.log`. Unblocked by the CTO applying
> `migrations/002-grant-service-role.sql`.
>
> Worker restarted **without** `--dry-run`:
>
> ```
> INFO  [sink] using Supabase sink (schema founder_alpha)
> INFO  series=KXBTC15M sink=supabase replica=replica-methodology-v1
> INFO  discovered window KXBTC15M-26JUL231145-45 close=…15:45:00Z strike=64823.58
> INFO  flushed 1 row(s) (supabase)
> ```
>
> **Runtime proof — rows are in the table:**
>
> | Check | Result |
> |---|---|
> | `founder_alpha.fa_window_capture` row count | **37 and climbing** |
> | `v_fa_capture_health` | **returns data** (see below) |
> | `v_fa_replica_error` | 0 rows — by design, no window has *settled* since live writes began |
> | `fa_forecast_seal` | **0 rows** — Phase 0 invariant holds |
>
> `v_fa_capture_health` for 2026-07-23:
>
> ```json
> { "snapshots": 34, "windows_seen": 1, "gaps_over_30s": 0, "worst_gap_seconds": 0,
>   "rows_with_any_flag": 0, "invariant_sum_violations": 0, "invariant_ts_violations": 0,
>   "invariant_gap_violations": 0, "replica_unavailable_rows": 0,
>   "uptime_pct_of_expected": 18.89 }
> ```
>
> **Live invariants: all zero.** `up_mid + down_mid = 1.000` exactly on every row; four venues
> contributing; `sink=supabase` confirmed, not dry-run.
>
> **`uptime_pct_of_expected: 18.89` is correct arithmetic, not a defect.** The worker joined an
> in-progress window, so 34 observed snapshots are measured against a full-window expectation of
> 180. It normalises once whole windows are captured. Flagging it because an 18.89% uptime figure
> read in isolation would look alarming.
>
> **Still on disk, not yet backfilled:** 10,492 capture rows and 49 settlements from the
> overnight dry run. Load with `node scripts/backfill.js --dry`, then without `--dry`. Not done
> automatically — these tables are append-only, so an accidental double-run cannot be undone.
> Note those rows carry the pre-fix `incomplete_book` label rather than
> `one_sided_book_at_extreme` (§7).

### How this was unblocked — superseded diagnosis, retained for the record

> **Re-verified 2026-07-23 ~07:15 UTC.** Fixtures: `fixtures/17-grant-verification.txt`,
> `migrations/002-grant-service-role.sql`
>
> **The CTO's fix worked.** The error moved from `PGRST106` (schema not exposed) to `42501`
> (schema exposed, permission denied) — proof the Data API now serves `founder_alpha`.
>
> **The isolation concern is withdrawn.** Per the CTO ruling, `founder_alpha` living inside the
> TSM project is the approved architecture: isolation is at the **schema** level (separate
> schema, RLS forced, zero grants to `anon`/`authenticated`, append-only). Dispatch hard rule 1
> forbids *referencing `public.tsm_*` objects and importing TSM code* — both satisfied, census
> CLEAN (§8). It does not mandate a separate project. My inference went beyond the text.
>
> **The remaining blocker is a defect in migration 001, which I wrote.** 001 revoked privileges
> from `anon`/`authenticated` but never **granted** any to `service_role`. In Postgres,
> `BYPASSRLS` and object privileges are independent: bypassing RLS does not confer schema
> `USAGE`. Supabase's default grants cover `public`, not a new schema. Hence:
>
> ```
> 42501  permission denied for schema founder_alpha
> ```
>
> **Why my own verification missed it — worth recording.** 001's suite ran as the `postgres`
> superuser, which bypasses privilege checks entirely. It could *never* have caught a missing
> grant. A verification that runs with more authority than production is not a verification of
> production. 002's suite runs as a real non-superuser `service_role`.
>
> **The fix is written and proven.** On a clean PG17 cluster the production error was reproduced
> exactly, then resolved:
>
> | Role | schema USAGE | SELECT | INSERT | UPDATE | DELETE |
> |---|---|---|---|---|---|
> | `service_role` | ✅ | ✅ | ✅ | ❌ | ❌ |
> | `anon` | ❌ | ❌ | ❌ | ❌ | ❌ |
> | `authenticated` | ❌ | ❌ | ❌ | ❌ | ❌ |
>
> UPDATE/DELETE are withheld deliberately — defence in depth, so append-only survives even if a
> trigger is ever dropped. Isolation posture is unchanged.
>
> **Action: CTO applies `migrations/002-grant-service-role.sql`.** I cannot apply DDL through
> PostgREST. After that, live writes need no code change — restart without `--dry-run`.
>
> **Sink item remains BLOCKED**, not VERIFIED: `fa_window_capture` is still empty, so there is
> no live row count to cite as proof.
>
> **Data is safe.** The worker has been capturing continuously in dry-run: **9,204 capture rows
> and 41 settlements** on disk, zero loss, ready for `scripts/backfill.js`.
>
> One trap avoided: `data/spill/` contained only 10 **synthetic** rows from testing the spill
> path (`window_id: "T"`). Replaying those into an append-only table would have injected
> permanently undeletable junk. Quarantined to `*.jsonl.quarantine`, which the backfill glob
> ignores.

### Superseded diagnosis — wrong-project isolation risk (WITHDRAWN)

> Fixture `fixtures/16-supabase-project-mismatch.json` recorded a suspected project mismatch.
> **Withdrawn:** same-project/schema-level isolation is the approved design. The `PGRST106`
> evidence in that fixture was accurate; the isolation conclusion drawn from it was not.
>
> **1 — the schema is still not exposed.** Polled 10 times over 180 s, via both `supabase-js`
> and raw PostgREST with `Accept-Profile: founder_alpha`. Every response: `PGRST106`, hint
> `Only the following schemas are exposed: public, graphql_public`.
>
> **2 — these credentials point at the TSM production database.** The API root advertises
> **36 `tsm_*` objects** — `tsm_decision_receipts`, `tsm_audit_events`,
> `tsm_evidence_snapshots`, `rpc/tsm_record_canonical_decision`, `rpc/delete_user_data`, and
> more — plus unrelated product tables (`referrals`, `beta_agreements`, `trade_ingestions`).
> **Zero `fa_*` objects are visible.**
>
> This conflicts directly with **dispatch hard rule 1** (full isolation from TSM). Writing
> Phase 0 capture data here would co-locate the research system with production trading
> infrastructure.
>
> **Most likely explanation, and it reconciles both findings:** the CTO exposed `founder_alpha`
> on the correct isolated project, but the `SUPABASE_URL` / `SERVICE_ROLE_KEY` supplied to this
> build point at the TSM project.
>
> **Credential scope — HIGH.** The supplied `service_role` key bypasses RLS across this entire
> project, including TSM production tables and destructive RPCs, and it was pasted into a chat
> transcript. Rotate it.
>
> **No data was written to this project.** Only failed `SELECT` probes and one OpenAPI `GET`.
> The sink item is therefore **left at BLOCKED**: there is no live row count, and recording
> VERIFIED without one would defeat the purpose of this document.

### Original diagnosis (superseded by the above)

Fixture: `fixtures/15-supabase-live-attempt.json`

Credentials were supplied (2026-07-23 ~04:10 UTC) and are **valid** — they are *not* the
blocker:

- REST root → **HTTP 200**
- `public` schema probe → `PGRST205` (table-not-found), i.e. PostgREST reachable, key accepted
- JWT decodes as `role=service_role`, `ref=hahgdljmkbbykneclinf`

Writing to the target schema fails:

```
PGRST106  Invalid schema: founder_alpha
          Only the following schemas are exposed: public, graphql_public
```

**Root cause:** `founder_alpha` exists and is verified in production (§10), but is not in
PostgREST's exposed-schemas list, so the Data API refuses to serve it. This is a project
setting; a service-role key cannot change it.

Two incidental corrections made while wiring this up:

1. The supplied `SUPABASE_URL` was the REST endpoint (`…supabase.co/rest/v1/`). `supabase-js`
   appends `/rest/v1` itself, so it was normalised to the base project URL; left as given it
   would have requested `/rest/v1/rest/v1/…`.
2. **Sink robustness (real production risk, now fixed).** Failed flushes were re-queued
   in memory with no bound. A sustained Supabase outage on Railway would have grown the queue
   until the container OOMed — losing exactly the data the requeue was meant to protect. The
   sink now spills to `data/spill/*.jsonl` after 3 consecutive failures or >5,000 pending rows.
   Verified: 10 rows spilled, pending returned to 0, zero rows lost.

**Interim state:** the worker was restarted in dry-run and is capturing continuously to
`data/capture/*.jsonl`. No data is being lost. `scripts/backfill.js` loads everything on disk
into Supabase once the schema is exposed (`--check` preflight, `--dry` report, then live).

Note the deliberate failure mode: **missing Supabase config does not crash the worker**, it
silently falls back to dry-run. That prevents data loss but means a mis-set variable *looks*
healthy. `README-DEPLOY.md` §5 makes confirming `sink=supabase` a required post-deploy check.

### Macro calendar: PARTIAL

`data/macro-calendar.json`, 6 events over 60 days.

- **NFP × 2 — `rule_derived`.** First Friday at 08:30 ET, computed exactly and DST-verified.
- **CPI × 2, FOMC × 2 — `estimated` PLACEHOLDERS.** CPI's exact day varies; FOMC follows no
  arithmetic rule. These are positioned on typical days and **must be replaced with official
  BLS/Federal Reserve dates** before any regime analysis depends on them. A naive placeholder
  initially landed a CPI on a Saturday; the generator now snaps off weekends, but that does not
  make the dates correct — only plausible.

---

## 12. Checklist status summary

| # | Item | Status | Evidence |
|---|---|---|---|
| 1 | Fee params (taker multiplier, maker fees) | **VERIFIED** (maker PARTIAL) | `02`, `09`, `config/` |
| 2 | Position / order size limits | **PARTIAL** | `03`, `04` |
| 3 | API rate-limit tier | **BLOCKED** | `06` |
| 4 | Historical settlements retrievable | **VERIFIED** | `07`, `08` |
| 5 | Contract rules (source + averaging window) | **VERIFIED** | `02`, `04` |
| 6 | Replica error vs true settlement | **BLOCKED on deploy** | `14` (n=3, existence proof only) |
| 7 | Capture uptime over ≥3 days | **BLOCKED on deploy** | — |
| — | Kalshi auth | **VERIFIED** | `01` |
| — | Fee model + unit tests | **VERIFIED** | 48/48 tests |
| — | Migration written + applied | **VERIFIED** | `12`, CTO notes |
| — | Worker end-to-end capture | **VERIFIED** (2 full windows) | `14`, `logs/` |
| — | Data-quality invariants | **VERIFIED** | `14` |
| — | Isolation (zero TSM, zero order endpoints) | **VERIFIED** | `13` |
| — | Secrets hygiene | **VERIFIED** | git log + scans |
| — | Repo private | **FAILED** | `10` |
| — | Railway deploy | **BLOCKED** | — |

### Blocked items — owner and unblock condition

| # | Blocker | Owner | Unblocks |
|---|---|---|---|
| 1 | **Repo is PUBLIC** (must be private) | Founder | Dispatch §A compliance |
| 2 | Railway project does not exist | Founder | Deployment |
| 3 | Railway CLI unauthenticated | Founder | CLI deploy |
| ~~4~~ | ~~`service_role` lacks GRANTs~~ — **RESOLVED**: CTO applied migration 002; live writes VERIFIED, 37+ rows in `fa_window_capture`. | — | ✅ Done |
| 4b | Rotate the `service_role` key (pasted into a chat transcript). CTO accepted; scheduled as a **controlled** rotation since it powers TSM prod Vercel env + crons. | Founder + CTO | Credential hygiene |
| 5 | Rate-limit tier not exposed by API | Kalshi | Item 3 |
| 6 | Per-user position limit needs a forbidden endpoint | Founder (read from UI) | Item 2 → VERIFIED |
| 7 | ≥3 days continuous capture | Deploy | Items 6–7 |
| 8 | CPI/FOMC dates are placeholders | Founder/CTO | Macro flag correctness |

### What this build does *not* establish

- **That a statistical edge exists.** Phase 0 captures; it does not analyse.
- **That the replica is accurate.** n = 3 with a mean |error| of $3.70 is an existence proof of
  the pipeline, nothing more. The falsifiable criterion is in
  `docs/replica-methodology-v1.md` §7.
- **That maker fees are zero.** Inferred from a missing field.
- **That 17 days is the settlement history limit.** It is a verified floor.
