# RVR — Founder BTC Alpha, Phase 1 (frozen models + sealed forecasts)

**Runtime Verification Record.** Statuses are **VERIFIED / FAILED / BLOCKED / PARTIAL** only.
No claim appears without a fixture on disk. Phase 0 RVR: `docs/RVR-phase0-build.md`.

| | |
|---|---|
| Built | 2026-07-23 15:45–16:35 UTC |
| Spec source | `founder_alpha.fa_ontology_versions` (9 rows, frozen 15:40:06Z) — read from the DB, not re-derived |
| Scope | Capture + forecast + grade. **No orders, no capital, no portfolio reads.** |
| Tests | **84/84 passing** (36 new forecaster tests) |

---

## 1. Spec provenance

Every formula was read from the frozen ontology rows and transcribed verbatim into
`src/forecaster.js`, where each appears in the module docstring above its implementation.
Nothing was invented or inferred beyond the one unit convention in §2.

| kind | version |
|---|---|
| model | `b0-market-price-v1`, `b1-nodrift-diffusion-v1`, `b2-momentum-v1`, `b3-book-imbalance-v1` |
| seal-cadence | `v1` — T-10 / T-5 / T-2, 4 models, record executable prices |
| regime-partition | `v1` |
| stats-rules | `v1` — Brier vs B0, BH correction, actionable = fee + half-spread + 1pp |
| fee-model / replica-methodology | `v1` (Phase 0) |

7 hypotheses read from `fa_hypothesis_ledger` (H1–H7, all `open`). No analysis was run against
them — Phase 1 collects the evidence they will later be tested on.

---

## 2. The one interpretive decision, stated plainly

The specs give `sigma` as "rolling 15m realized vol" and `mu_hat` as a "per minute" return,
then combine them as `sigma*sqrt(tau)` and `mu_hat*tau`. Those two cannot both be
dimensionally correct unless the time unit is pinned.

**Resolution:** `sigma` is what this repo already computes — the standard deviation of log
returns between consecutive 1 Hz replica prints, i.e. **per-second**. So `tau` is carried in
**seconds** everywhere, and `mu_hat` is converted from per-minute to per-second (÷60) before
`mu_hat*tau`. The "±1 sigma" cap is applied in those same per-second units.

Any other reading leaves B2's drift term wrong by a factor of 60. This is documented in the
module header and asserted by the test `B2 converts the per-minute drift to per-second (the 60x
trap)`. **If the CTO intended a different convention, it needs a new model version row — not an
edit.**

---

## 3. Idempotency strategy — chosen once, stable forever

`fa_forecast_seal` has `UNIQUE(model_id, model_version, window_id)`, which alone permits only
one seal per model per window. The seal point goes in **`model_version`**:

```
model_id      = 'b1-nodrift-diffusion-v1'   -- matches fa_ontology_versions.version exactly
model_version = 'v1@T-10'                   -- spec version @ seal point
```

**Why model_version and not model_id:** `model_id` stays a clean join key onto the frozen
ontology row, so scoreboards group by model without string surgery, while the unique constraint
still yields exactly one row per (model, seal point, window).

**Runtime proof — VERIFIED.** Replaying the exact existing seal rows twice:

```
seals before replay: 1
count after replay 1: 1
count after replay 2: 1
VERIFIED: re-running a seal point inserts NOTHING (ON CONFLICT DO NOTHING)
```

`ON CONFLICT DO NOTHING` needs only INSERT privilege, so this works under the deliberately
UPDATE-less grant from migration 002.

---

## 4. Seal census — VERIFIED

Fixture: `fixtures/19-phase1-seal-census.json`. Log: `logs/worker-phase1.log`.

**27 seals across 3 windows; 2 windows with the full 3×4.**

| Window | Seals | T-10 | T-5 | T-2 |
|---|---|---|---|---|
| `…231200-00` | 3 | b0:0.765 | b0:0.845 | b0:0.984 |
| `…231215-15` | **12 ✅** | b0:.135 b1:.090 b2:.010 b3:.090 | b0:.017 b1:.010 b2:.010 b3:.011 | b0:.010 b1:.010 b2:.010 b3:.010 |
| `…231230-30` | **12 ✅** | b0:.115 b1:.057 b2:.010 b3:.053 | b0:.155 b1:.143 **b2:.515** b3:.146 | b0:.010 b1:.010 b2:.010 b3:.010 |

### Seal timing vs close — VERIFIED

| Seal point | Target | Every observed lead |
|---|---|---|
| T-10 | 600s | **605s** |
| T-5 | 300s | **305s** |
| T-2 | 120s | **125s** |

All inside the ±5s tolerance. **Seals postdating close: 0** — the schema CHECK holds, and the
worker re-checks the clock *after* the orderbook round-trip and drops a seal that would land
late rather than backdating it.

### The first window sealed B0 only — and that is correct

`…231200-00` produced 3 seals, not 12:

```
SEAL … T-10 T-605s: 1/4 sealed | PASS: b1=realized_vol_unavailable
       b2=five_min_return_unavailable b3=realized_vol_unavailable | p=[b0:0.765]
```

B1/B2/B3 need a rolling 15m realized vol, which requires ~12 minutes of replica buffer. The
worker had been up 1 minute. **Each model declined explicitly with a named reason rather than
substituting a value.** `sealed_p` is NOT NULL in the schema, so there is no way to record a
fabricated probability — the absent row *is* the honest record.

**Operational consequence, documented in `README-DEPLOY.md`:** every Railway restart produces
~12 minutes of B0-only seals. Judge health by whether `n/4` returns to 4/4 within ~15 minutes,
not by the first seal after boot.

---

## 5. Grader — VERIFIED on 2 settled windows

Fixture: `fixtures/20-phase1-grader-verdict.txt`

Migration 003 is **not yet applied in production**, so the live worker logged:

```
ERROR [sink] grade write failed: PGRST205 Could not find the table 'founder_alpha.fa_forecast_grade'
INFO  GRADED KXBTC15M-26JUL231215-15: 0 seal(s) scored vs outcome=no
```

The grader was therefore proven by loading the **real production seals and real settled
outcomes** into a local PG17 cluster with 003 applied, and running the same formulas:

| Window | Seal | Model | sealed_p | outcome | Brier | vs B0 |
|---|---|---|---|---|---|---|
| `…231215-15` | T-10 | b1 | 0.0897 | no | 0.00805 | **−0.01018** |
| `…231215-15` | T-10 | b2 | 0.0100 | no | 0.00010 | **−0.01813** |
| `…231215-15` | T-10 | b3 | 0.0902 | no | 0.00813 | **−0.01009** |
| `…231230-30` | T-10 | b1 | 0.0567 | no | 0.00322 | **−0.01001** |

`brier_vs_b0` is signed: **negative means the model beat the market baseline** at the same
window and seal point.

> **n = 2 windows. This supports no conclusion about any model.** H6 requires n ≥ 1000, H1
> n ≥ 300. These numbers prove the grading pipeline runs end to end — nothing more. The one
> visibly bad seal (B2 at 0.515 when the market said 0.155 and it settled `no`) is exactly the
> kind of event that only means something across hundreds of windows.

---

## 6. Founder verdict feed — VERIFIED, all four states observed

Per the founder addendum, `v_fa_window_calls` carries a **4-state** call. All four appeared
naturally on real data:

| Window | Seal | market_p | consensus | divergence | threshold | call | outcome | right? |
|---|---|---|---|---|---|---|---|---|
| `…231200-00` | T-10 | 0.765 | — | — | 0.035 | **THIN** | yes | — |
| `…231215-15` | T-10 | 0.135 | 0.063 | −0.072 | 0.025 | **NO** | no | ✅ |
| `…231215-15` | T-5 | 0.017 | 0.010 | −0.006 | 0.021 | **FAIR** | no | ✅ |
| `…231215-15` | T-2 | 0.010 | 0.010 | 0.000 | 0.021 | **FAIR** | no | ✅ |
| `…231230-30` | T-10 | 0.115 | 0.040 | −0.075 | 0.025 | **NO** | no | ✅ |
| `…231230-30` | T-5 | 0.155 | 0.268 | +0.113 | 0.025 | **YES** | no | ❌ |

State definitions, as specified:

- **YES** — consensus above market by ≥ threshold (up contract underpriced)
- **NO** — consensus below market by ≥ threshold (up contract overpriced)
- **FAIR** — models and market agree within 1pp; the market is pricing the window correctly
- **THIN** — no models could compute, **or** the disagreement is real but below threshold

**Consensus deliberately excludes B0**, because B0 *is* the market price — including it would
shrink every divergence toward zero by construction.

**FAIR correctness measures the market, not us.** A FAIR call is scored on whether the window
settled with the *market's* favourite, so FAIR accuracy is a probe of the market's own
calibration. `v_fa_call_scoreboard` carries that distinction as an `interpretation` string on
every row, so the number cannot be misread later:

```
FAIR: accuracy here = how often a FAIR window settled with the market's favourite;
      it validates the MARKET's calibration, not ours
THIN: no call made; correctness undefined by design
```

Every row is labelled **`mode = 'SHADOW'`** until Day-14.

---

## 7. Migration 003 — staged for the CTO, verified locally

`migrations/003-forecast-grade.sql`. **Applied and tested on a clean PG17 cluster; NOT applied
to production.**

Contains: `fa_forecast_grade` (+ append-only trigger, RLS forced, service_role grants per the
002 pattern), `v_fa_model_scoreboard` (incl. calibration buckets), `v_fa_model_calibration`,
`v_fa_window_calls`, `v_fa_call_scoreboard`.

| Check | Result |
|---|---|
| 001 → 002 → 003 apply in sequence on a clean cluster | **PASS** |
| `service_role` INSERT / UPDATE | **t / f** (UPDATE withheld: defence in depth behind the trigger) |
| `anon` SELECT | **f** |
| `UPDATE fa_forecast_grade` | **rejected, 42501 append-only** |
| All four views execute | **PASS** |

Grants follow the 002 lesson: privileges were verified as a **non-superuser `service_role`**,
never as `postgres`.

---

## 8. Isolation census — CLEAN

Fixture: `fixtures/13-isolation-census.json`. 50 files scanned.

| Check | Result |
|---|---|
| TSM database objects (`tsm_*`) | **CLEAN** |
| Imports from a TSM repo | **CLEAN** |
| Kalshi order / portfolio endpoints | **CLEAN** |
| Mutating HTTP verbs against Kalshi | **CLEAN** |

Two exclusions, both stated in the census output on every run rather than suppressed:

1. **Guard-proofs** (unchanged from Phase 0) — `assertReadOnly('POST', …/orders)` and its
   recorded refusal. These prove the endpoint is *blocked*.
2. **`fixtures/16-supabase-project-mismatch.json`** — an evidence fixture recording that
   `public.tsm_*` objects exist in the shared Supabase project, captured while investigating
   the credentials. It documents the environment; it does not reference those objects.

Independently confirmed: the only `tsm_` strings in `migrations/` are two `--` comments
*asserting* non-reference. **Zero executable SQL touches `tsm_*`.**

---

## 9. Hard-rule compliance

| Rule | Status | Evidence |
|---|---|---|
| Read-only Kalshi key | ✅ | Client refuses non-GET at the transport choke point |
| No order endpoints | ✅ | Isolation census CLEAN |
| No TSM references | ✅ | §8 |
| Secrets never printed | ✅ | Pre-push scan: no JWT, no key body, no key ID in tracked files |
| Seals predate close | ✅ | 0 of 27 postdate; late seals dropped, never backdated |
| No fabricated inputs | ✅ | 9 explicit PASSes with named reasons; `sealed_p` NOT NULL |
| No orders / no capital | ✅ | Nothing in Phase 1 touches a portfolio or order path |

---

## 10. Status summary

| Item | Status |
|---|---|
| Forecaster implementing 4 frozen models | **VERIFIED** |
| Seal cadence T-10/T-5/T-2 ±5s | **VERIFIED** (605/305/125s observed) |
| ≥2 windows with 3×4 seals | **VERIFIED** (2 windows, 12 seals each) |
| Seals predate close | **VERIFIED** (0 violations) |
| PASS-not-fabricate on missing inputs | **VERIFIED** (9 PASSes) |
| Idempotency on re-run | **VERIFIED** |
| Grader (Brier / log-loss / vs-B0) | **VERIFIED** on 2 settled windows (local cluster) |
| 4-state verdict feed incl. FAIR | **VERIFIED** (all 4 states observed) |
| Migration 003 | **STAGED** — CTO to apply |
| Live grading in production | **BLOCKED** on 003 |
| Railway deploy | **BLOCKED** — no Railway project |
| Repo private | **FAILED** — still public |
| 84/84 tests | **VERIFIED** |

### Blocked — owner and unblock condition

| # | Blocker | Owner |
|---|---|---|
| 1 | **Migration 003 not applied** — grading and all 4 views unavailable in prod | CTO |
| 2 | Railway project does not exist; CLI unauthenticated | Founder |
| 3 | **Repo is PUBLIC** — dispatch §A violation, open since Phase 0 | Founder |
| 4 | `service_role` key rotation (pasted into a transcript) | Founder + CTO — controlled rotation on the morning board |
| 5 | CPI/FOMC calendar dates are placeholders | Founder/CTO |

### What Phase 1 does *not* establish

- **Nothing about whether any model beats the market.** n = 2 windows against hypothesis
  minimums of 200–1000.
- **Nothing about the actionable threshold's profitability.** H2 needs n ≥ 200 at executable
  prices.
- **Nothing about FAIR-state market calibration.** Three FAIR observations.

Phase 1 built the machine that will answer those questions. It has not answered them, and no
row in this repo should be read as if it had.
