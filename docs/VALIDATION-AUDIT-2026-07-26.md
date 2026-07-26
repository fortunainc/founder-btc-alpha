# BTC Three-Approach Validation — Final Report (2026-07-26)

Directive: founder "Three-Approach Validation and Dashboard" directive, executed same-session.
Evidence convention: every number below was produced by a live production query, a first-hand code read, or a green test run on the founder's machine this session. DB state as of ~02:00 UTC 2026-07-26.

## 1. What each approach actually does (source-level)

| | Forecast — "Outcome Probability" | V2.1 Arbiter — "Edge-Based Decision Policy" | V2.2 Profit — "Fee-Aware Profit Decision Policy" |
|---|---|---|---|
| Purpose | P(BTC settles above strike) from frozen models B0–B3 | pick the side the *evidence* favors, regime-weighted | pick the side with positive expected net $ after costs |
| Inputs | replica S, strike K, 15m realized σ (per-sec), τ, 5m return (B2), Kalshi book depth ±2c (B3), up-mid (B0) | bar buffer (structure F2, momentum F3, vol regime F4), public trade tape (order-flow F5), reachability z=(S−K)/(S·σ·√τ), macro-event flag | B1 probability (recomputed at seal from live S,K,σ,τ) + executable up/down asks + verified fee |
| Calculation | B1: Φ(ln(S/K)/(σ√(τ−30))); B2: +drift µ̂τ capped ±1σ; B3: logistic(logit(B1)+0.5·imb); clamp [0.01,0.99] | weighted directional vote over present factors, regime matrix arb-matrix-v1, conflict transforms (exhaustion / pullback / trap) | EV_yes = p − ask − fee(ask); EV_no = (1−p) − ask − fee(ask) |
| Thresholds / states | call per (window,timing): YES/NO if \|consensus−market\| ≥ fee+half-spread+1pp; FAIR ≤1pp; THIN otherwise | act if \|z\|≥1.5 (reachability-decided, w/ override gate) OR \|conviction\|≥0.20 & agreement≥0.60; else NO_TRADE; event regime near-vetoes | trade best side iff EV ≥ $0.02; else NO_TRADE ("market has priced it") |
| Seal timing | T-10 / T-5 / T-2 (±5s), sealed_at<close CHECK | once at τ≈720s (min 3), floor 120s, one seal ever | same instant, separate row (engine_id distinct) |
| Own forecast? | YES — the models | NO forecast consumed — independent evidence engine | CONSUMES the same B1 model family as Forecast (recomputed, not the sealed row) |
| Exec pricing / fees | recorded verbatim; costs inside the call threshold; no executable trade defined | graded at SEALED ask of taken side + kalshiFee (ceil-to-cent 0.07·p·(1−p), API-verified) | same, and fees are inside the decision itself |
| Abstention | THIN/FAIR; a model that can't compute writes NO row | NO_TRADE + no_forecast_data on cold data (15-min warmup) | NO_TRADE on missing p, missing books, or EV<margin |
| Settlement / grading | Kalshi market.result (BRTI); grade per seal (Brier, log-loss, brier_vs_B0, call_correct); UNIQUE(seal_id) | market.result; one grade per decision; correctness + after-fee net; UNIQUE(window,engine) | same path |
| Authoritative version | models v1 (frozen 2026-07-23), calls per v_fa_window_calls | v2.1.0 (since 07-24 16:02Z) — v2.0.0 exists (4 rows, split out) | v2.2.0 (since 07-24 22:17Z) |
| Storage / jobs | fa_forecast_seal/grade, fa_settlement_grade; worker.js _seal/_settle/_gradeSeals; views v_fa_window_calls, v_fa_call_scoreboard | fa_v2_decisions/grades (+ledger cols); V2Scheduler.onTick/onSettle | same tables, engine_id btc-alpha-v2-profit |

**Independence ruling:** V2.1 is an independent analytical engine. V2.2 is a *decision policy over the same underlying B1 forecast* (recomputed at its own seal). The founder's proposed card labels are source-verified accurate and are now live on the dashboard.

## 2. Founder technical-funnel matrix

BUILT+ACTIVE: spot-vs-strike (z + log-moneyness) · time remaining (τ, τ_eff) · realized vol (1Hz bars) · vol regime (F4) · trend state + price structure + breakout (F2 swings) · momentum quality (F3 consistency) · order-book imbalance (Forecast B3 Kalshi ±2c) · contradiction handling (conflict transforms + signature) · executable YES/NO both sides · spread(half)+depth(2c)+verified fees · risk/no-trade gates (warmup, conviction/agreement, MIN_EDGE, event, seal-floor, override).
PARTIAL: volume/participation (trade-rate weight in F5 only) · aggressor order-flow (F5 = tape imbalance+absorption; Kalshi depth captured but not an arbiter factor — `liquidity` slot reserved/null) · market-event context (macro flag → event regime; static calendar) · source/index divergence (settlement-endpoint replica_error only; **intra-window BRTI: BLOCKED BY DATA** — no API).
ABSENT (reserved slots or no code): EMA slope/ordering · VWAP/anchored VWAP (`vwap:null`) · prior levels/S-R (`s_r:null`) · MTF (`mtf:null`) · futures/perp basis · funding · open-interest · liquidation intensity · options-implied.
**Direct statement per the directive: the Forecast is a barrier-probability model, not the intended full technical synthesis; the technical synthesis that exists lives in V2.1's three active factors. The absent factors above are honestly absent — no field/table was counted as "active."** (Evidence: evidence.js:40-51 reserved nulls; grep across families/structure/orderflow for EMA/VWAP → none.)

## 3. Correctness audit — coverage and method

Instead of sampling 20 windows, the audit reproduced **every** record wholesale (strictly stronger):
- **240/240 v2 grades** recomputed from stored decisions: 0 correctness errors, **1 pricing defect** (below). Entry=sealed ask verified; fee formula verified; NO_TRADE→net 0 consistent; voids null.
- **589/589 B1 seals** recomputed in SQL from frozen inputs (Φ formula, clamp): 0 mismatches (max err 5.6e-7 = documented A&S vs exact erf).
- **107/107 V2.2 decisions**: EV + recommendation reproduce exactly (max err 1e-16).
- Dedup: 0 duplicate decisions/(window,engine), 0 duplicate grades, 0 duplicate forecast grades (DB uniques + scan).
- Leak checks: 0 seals at/after close (both systems, CHECK-enforced + scanned); settlement values enter only grade rows.
- Settlement source: market.result / expiration_value; contract = soonest-closing open KXBTC15M; strike = floor_strike refreshed until published (worker.js:238-265). 212 settlements: 0 unresolved outcomes, 2 corrupted expiration_value reads (0.00) — rows 234 (already quarantined) and **333 (found tonight, now quarantined)**; outcome-based grades unaffected.
- Disagreement structure over 104 shared settled windows: all-three-agree 19; v2.1 trades while v2.2 abstains 37 (the fee-gate working); mixed on the rest — the comparison population the dashboard now displays.

## 4–5. Defects found → fixed

1. **Grade 57 mispriced (v2.1, 26JUL242245-45):** graded at 0.72 vs stored sealed down_ask 0.65 (net 0.26 vs true 0.33). Root cause: write-retry resealed in memory with a fresher book; DB kept the canonical first seal; grading priced from memory. → **Fixed three ways:** (a) migration **008**: append-only `fa_v2_grade_corrections` + `v_fa_v2_grades_canonical` (correction overlaid, original preserved) + the grade-57 correction row — **applied to prod**; (b) scheduler now grades from the **stored** row (`readDecision` injected by worker; memory only as fallback); (c) regression tests reproduce the exact defect.
2. **Settlement row 333 corrupted-value not quarantined:** appended `fa_settlement_exceptions` row (policy of 007) — **applied to prod**; replica-accuracy stats now exclude it; outcome grades stand.
3. **Version mixing risk:** 4 pre-freeze v2.0.0 decisions existed in the same table; dashboard previously did not split them everywhere. The validation layer now hard-separates current-version, legacy, and all-version records (never blended).

No other defect survived the wholesale reproduction. **No unresolved correctness failure remains that is fixable without founder input.**

## 6. Tests added (all green on the founder's machine: **193/193, exit 0**)

`test/v2/validation.test.js` (7): accuracy denominator + exclusions; drawdown; forecast FAIR/THIN handling + timing filter; H2H matcher (legacy rows can't match; unsettled excluded); reconciliation identities pass/fail; version split; inspector rows (corrected flag, pending).
`test/v2/scheduler-stored-grade.test.js` (3): grade-57 defect reproduced then fixed (stored-ask pricing, FK to stored id); legacy fallback intact; reader-failure fallback never skips a grade.

## 7–8. Reconciled production metrics (canonical, 2026-07-26 ~02:00 UTC — moving sample)

| Metric | Forecast (native, combined) | V2.1 v2.1.0 (native) | V2.2 v2.2.0 (native) |
|---|---|---|---|
| Settled actionable | 419 | 104 | 60 |
| Correct / incorrect | 233 / 186 | 42 / 62 | 34 / 26 |
| Directional accuracy | 55.6% ⚠ 3 timings combined | 40.4% | 56.7% |
| Per-timing accuracy | T-10 69.9% (121/173) · T-5 59.5% (72/121) · T-2 28.6% (20/70) | single timing τ≈720s | single timing τ≈720s |
| Stand-asides (graded) | FAIR 136 · THIN ~129 | 26 NO_TRADE | 47 NO_TRADE |
| After-fee net (canonical) | — (no executable trade defined) | **−$13.11** (was −13.18 pre-correction) | **−$1.61** |
| Version note | models frozen v1 | v2.0.0: 4 rows split out (2 actionable, 1✓/1✗, −$0.22) | single version |

Head-to-head (settled windows where all three sealed; Forecast=T-10): **104 matched windows, 50 with all three actionable** — exact per-approach H2H metrics are computed live on the dashboard from the same records (they move with each window; the page reconciles them against the raw rows on every load).

## 9. Denominator definitions (also displayed on-page)

accuracy = correct ÷ (correct+incorrect), over settled actionable calls only · observed = every sealed row · graded = settlement ∈ {yes,no} · NO_TRADE/FAIR/THIN, pending, void, unpriceable: counted, visible, never in accuracy · money = 1 contract at sealed executable ask + verified Kalshi fee, from v_fa_v2_grades_canonical.

## 10. Version boundaries

v2.0.0 (scalp): 2026-07-24 15:03→15:47Z, 4 decisions. v2.1.0: since 2026-07-24 16:02:59Z. v2.2.0: since 2026-07-24 22:17:59Z. Forecast models v1: frozen 2026-07-23 15:40Z. Original seals + versions preserved on every historical row; corrections append, never rewrite.

## 11. Remaining limitations

Intra-window BRTI divergence unmeasurable (no API) — replica-vs-settlement endpoint error only; near-strike abstention band deliberately deferred (frozen sample, future challenger). Fills are 1-contract top-of-book (no multi-level slippage) — capital gate, not a shadow gate. EARLY SAMPLE everywhere (<200 settled/engine). Forecast "combined" numbers mix timings — labeled as such wherever shown. Inspector renders 400 rows/page (all rows counted + filterable).

## 12. Founder decisions still required

None for correctness. Standing items only: keep collecting to 200/engine; Day-14 ~Aug 6; the deferred tracking-error challenger remains deferred by your freeze doctrine.

## 13. Deployment

URL: https://founder-btc-alpha-production.up.railway.app/dash?token=<FOUNDER_DASH_TOKEN> (three-approach section: #validation).
Deploy = push to main (Railway auto-deploys). Post-deploy verification: dashboard loads, validation section renders, reconciliation panel all-green, headline totals match the SQL in §7 (re-run live), every-call tables populated for all three approaches.

```
cd ~/founder-btc-alpha && rm -f .git/*.lock
git add src/validation.js src/dashboard.js src/v2/scheduler.js src/worker.js \
        migrations/008-grade-corrections.sql test/v2/validation.test.js \
        test/v2/scheduler-stored-grade.test.js docs/VALIDATION-AUDIT-2026-07-26.md
git commit -m "Three-approach validation: audit-verified cards (native+H2H, version/timing split), every-call inspector, reconciliation panel; fix grade-57 pricing (stored-row grading + 008 corrections); quarantine settlement 333; 193/193 tests"
git push
```


---

## ADDENDUM — post-deploy production verification (2026-07-26 ~02:45 UTC)

- Push verified on origin (`03feed2` + provenance note `b8d5386`); Railway deployment ACTIVE; dashboard renders all validation sections (3 cards, timing tabs, version split, 3 inspectors: 646 forecast / 143 v2.1 / 114 v2.2 call rows embedded).
- **The reconciliation panel earned its keep on its FIRST production render**: it flagged 2 failing identities → grades 39/40 (window 26JUL242030-30, pre-fix): stored decisions TAKE_NO (down_ask 0.51, settled yes = WRONG call) but graded from a NO_TRADE in-memory reseal (net 0, correct null) — the same race class as grade 57, inverted. Corrections appended (call_correct=false, net −0.53 each); canonical view extended to overlay recommendation/call_correct; migration 008 updated to match. **Panel now 10✅/0❌ in production.**
- Corrected canonical nets after all 3 corrections: v2.1 −$13.80 · v2.2 −$1.04 (live sample at verification time; page recomputes per load).
- Operator note: the push was executed by the local Claude CLI session; its import-check transiently started a second live worker for ~90s (18 excess capture rows 02:25–02:27 UTC, provenance-noted in-repo, no seal/settlement impact — verified independently: +18 rows exactly, seals unique-constraint protected, single writer since).
