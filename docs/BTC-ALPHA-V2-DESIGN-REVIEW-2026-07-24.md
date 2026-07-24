# BTC Alpha V2 — First-3-Minutes Scalping Decision Engine
### CTO Design Review & Technical Implementation Plan
**2026-07-24 · STATUS: DESIGN ONLY — no code written. For founder review & approval before implementation.**

---

## 0. Verdict (TL;DR)

**Feasible, and a genuinely better-framed product — with one honest tradeoff you must own.**

- The 3-minute deadline is comfortably achievable. Compute is trivial (<100ms); the real gates are (a) the strike isn't known until ~1 minute after the window opens, and (b) the engine needs ≥15 minutes of warm price history. Both are satisfied by an always-on worker.
- The single biggest change is a **timing inversion**: today the engine seals **three** forecasts **near the close** (T-10/T-5/T-2). V2 seals **one** decision **near the open** (by minute 3). Everything after is grading.
- **~60% of the required evidence already exists** and is reusable (distance-to-strike, volatility, momentum, the diffusion "distance-vs-time" model, Kalshi pricing). The genuinely new builds are **market structure**, **multi-timeframe agreement**, and **(optionally) real order flow**.
- **The honest caveat:** deciding at minute 3 (≈12 minutes to settlement) is *inherently less accurate* than deciding at T-2. You are trading accuracy for the product you actually want — early, disciplined, one-shot conviction. Whether that's *profitable after fees* is exactly what the 30-day shadow will measure. This is the core product bet and you should own it explicitly.
- This is a **new frozen engine (V2)**. Under your own RVS discipline it cannot mutate frozen Phase-1, so a **governance decision is required** (restart the shadow clock under V2, or run V2 as a challenger beside Phase-1).

---

## 1. What actually changes (concept)

| | Today (Phase 1) | V2 |
|---|---|---|
| **Objective** | Probability disagreement (models vs market) | Scalping decision: above or below strike? |
| **When** | 3 seals near close (T-10/5/2) | 1 seal in first 3 min, then grade only |
| **Output** | YES / NO / FAIR / THIN (probability-driven) | TAKE YES / TAKE NO / NO TRADE (evidence-driven) |
| **Kalshi price** | The center of gravity | The **last** evidence family |
| **Probabilities** | The product | Inputs (evidence), never the headline |

The engine stops asking *"what is the probability?"* and starts asking *"given everything happening right now, does BTC have a realistic path to finish above this strike?"* — and commits once.

---

## 2. Evidence-family audit (exists / reuse / build)

| # | Family | Status | What already exists | What's new | Build cost |
|---|---|---|---|---|---|
| 1 | **Distance to strike** | REUSE + expose | `replica_index` (S), `reference_strike` (K), `log_moneyness`, `strike_distance_vol_units` | $ and % distance, required move per minute / per second (trivial from S, K, τ) | Trivial |
| 2 | **Market structure** | **BUILD NEW** | *(nothing — no swing/trend/sweep detection)* | HH/LL, trend/range, compression, breakout, sweep, rejection, false-breakout, structure bias | Medium (+ curve-fit risk) |
| 3 | **Momentum** | REUSE + extend | `ret5m` (5-min replica return), `rv_*` | 30s / 1m / 3m returns, acceleration, impulse quality, buy/sell strength | Low |
| 4 | **Volatility** | MOSTLY REUSE | `rv_1m` / `rv_5m` / `rv_15m`, expected move `σ·√τ` (in B1) | ATR, expansion/contraction regime, "expected move before settlement" as a $ figure | Low |
| 5 | **Order flow** | PARTIAL / NEW | Kalshi book imbalance (up/down depth, in B3) | *True* BTC aggressor/delta/absorption needs **trade-tape feeds** (new data) | Medium+ (low value at 12-min horizon — see §7) |
| 6 | **Multi-timeframe context** | **BUILD NEW** | *(nothing)* | 1m/3m/5m/15m structure+momentum + an agreement rule (not an average) | Medium |
| 7 | **Distance-vs-time model** | REUSE | **B1 diffusion already IS this** — `Φ(ln(S/K)/(σ_eff·√τ))` | Re-express in $ terms: required move vs projected move ("must move +$47 in 11m; vol projects ±$18 → unlikely") | Trivial |
| 8 | **Kalshi pricing** | REUSE, **DEMOTE** | B0 (market mid) + existing divergence logic | Move it to *last*; over/under-priced framing per side | Trivial |

**Net:** families 1, 3, 4, 7, 8 are largely built (this is the diffusion/momentum/imbalance machinery that already runs). The real engineering is families 2 and 6 (structure + multi-timeframe), both of which depend on a new **rolling bar layer**. Family 5 (real order flow) is the one expensive/uncertain piece — recommend deferring (§7, §9).

---

## 3. Architecture changes

**a. Timing inversion + single early seal.** Add one decision seal at **minute 3 of the window (τ ≈ 720s remaining)**. Retire the three near-close *decision* seals. (Capture continues throughout for grading; see §7 on whether to keep near-close *research* seals.)

**b. Open-phase dense capture.** Today capture is 5s normal / 1s in the final 120s. Add a symmetric **1s "open phase" for the first ~3 minutes**, so the decision is made on fresh, dense data.

**c. Continuous rolling bar/price layer.** A window-independent rolling buffer of the replica price → OHLC bars at 30s/1m/3m/5m/15m. This is what feeds structure, multi-timeframe, momentum, and ATR. Critical insight: BTC price is *continuous* — the 15-min Kalshi boundary is not a price discontinuity — so at minute 3 the 5m/15m lookback is fully available **as long as the worker has been up ≥15 minutes.** The engine already keeps a rolling vol buffer; this extends it to bars.

**d. Decision layer (new — the heart of V2).** Each family emits an independent **directional vote + confidence** (long / short / neutral). A **frozen, pre-registered combination rule** turns the family readings into exactly one of TAKE YES / TAKE NO / NO TRADE — with an explicit **NO TRADE** whenever (i) the path to strike is implausible given vol×time, (ii) families materially conflict, (iii) Kalshi already prices the edge away after fees, or (iv) data/strike isn't ready. A human-readable **reason string** is generated deterministically from the family readings (no LLM, no "AI language").

**e. (Optional) BTC trade-tape ingestion** for real order flow (aggressor delta, absorption) — new WebSocket trade channels. See §7/§9 for the recommendation to defer.

**f. Grading unchanged in spirit.** On settlement, store: recommendation, actual result, correct/incorrect, P&L after fees at the executable ask, the reason string, and the full evidence snapshot. (The paper-P&L view I built for the current dashboard extends directly.)

---

## 4. Data requirements

- **Reused, no new feed:** 4-venue replica index (coinbase/kraken/bitstamp/gemini top-of-book), Kalshi orderbook (up/down bid/ask/depth), strike, realized vol.
- **New, derived (no new feed):** continuous OHLC bars (30s/1m/3m/5m/15m) computed from the existing replica tick stream.
- **New feed, optional:** BTC **trade** channels (e.g. coinbase `matches`) for aggressor/delta/absorption. This is the only genuinely new external dependency, and it's optional.
- **Hard dependency:** `floor_strike` is only published ~1 minute after the window opens (it's the opening 60-second BRTI mean). Nothing distance-based can be decided before that.

---

## 5. Latency & the 3-minute feasibility (the hard requirement)

- **Compute latency:** every family runs in **<100ms** over in-memory buffers. This is not the bottleneck.
- **Real gates:** (i) strike availability at ≈ minute 1; (ii) warm history ≥15 min (met by an always-on worker); (iii) optional trade-tape warmup (seconds).
- **Plan:** seal the decision at **minute 3 (τ ≈ 720s)** — ~2 minutes after the strike is known, ample headroom to pull data, run all families, and commit. If the strike or required data isn't ready by minute 3, the engine returns **NO TRADE** (honest abstention), logged with the reason.
- **Verdict:** the 3-minute deadline is met comfortably, with margin. The constraint was never compute — it's strike timing and warmup, both handled.

---

## 6. Computational cost

Marginal. Rolling bars, multi-horizon returns, structure detection, ATR — all bounded, in-memory, sub-second per tick. No GPU, no heavy models, no new database load beyond one seal + snapshot per window. Fits the current Railway container. The only cost bump is **if** trade-tape ingestion is added (more inbound messages + delta aggregation) — still light, but it's why §9 recommends deferring it until the cheap families prove themselves.

---

## 7. Risks & tradeoffs (read this part)

1. **Accuracy vs earliness — the core bet.** A minute-3 decision (≈12 min to settle) is structurally *less* accurate than a T-2 decision. Your own current data hints at this (the near-close 10-minute reads are your strongest). V2 deliberately gives up late accuracy for early, actionable conviction. **The 30-day shadow's job is to prove whether early conviction is profitable after fees — it may not beat the late reads, and that's an acceptable, measurable outcome.**
2. **Order flow is probably low-value at a 12-minute horizon.** Aggressor/delta/absorption drive *seconds*-scalping; their signal for a 12-min settlement is weak and decays fast. Building trade-tape infra now risks spending the most engineering on the least-predictive family. **Recommend: start with top-of-book + Kalshi imbalance as the order-flow proxy; add real trade-tape only if the cheaper families leave money on the table.**
3. **Market-structure detection invites curve-fitting.** HH/LL/sweep/false-breakout thresholds are parameter-heavy and easy to tune until they look good in hindsight. Under RVS these **must be pre-registered and frozen before the first live seal** — no tuning to backtests.
4. **Single seal, no updates — by design.** If a post-seal liquidity sweep wrong-foots the call, the engine eats it. That's the discipline you asked for; the answer is to grade it honestly, not to add "just one update."
5. **Warmup dependency.** A cold worker (<15 min up) can't compute the higher-timeframe families → it must return NO TRADE until warm. Railway restarts therefore create brief NO-TRADE gaps (logged, honest).

---

## 8. Governance (RVS) — required, because this is a new engine

V2 changes the objective, the timing, and the output. Under your Runtime Verification Standard it **cannot** mutate frozen Phase-1 (frozen scorer versions, pre-registered hypotheses, append-only). So V2 must be a **new frozen engine** with its own pre-registered ontology + hypothesis ledger, frozen before its first live seal, verified by CTO falsification. The open question is what happens to the **shadow clock** (§9, decision A). Phase-1's capture substrate is reusable either way — no data is thrown away.

---

## 9. Assumptions needing founder approval (the forks)

**A. Clock / version governance.** V2 restarts the shadow clock (new engine, new Day-14) — *recommended*, because the objective changed and the old clock now measures the wrong thing — **vs** run V2 as a challenger alongside frozen Phase-1 (keeps the current Aug-6 Day-14, adds V2 as a second track). Keeping the Phase-1 capture substrate is assumed either way.

**B. Order-flow investment.** Start with the top-of-book + Kalshi-imbalance *proxy* and defer real BTC trade-tape ingestion until the cheap families prove insufficient — *recommended* — **vs** build real trade-tape order flow up front (more infra, marginal value at a 12-min horizon).

**C. The accuracy bet.** Confirm you accept that a minute-3 decision will likely be *less* accurate than the current near-close reads, and that the 30-day test measures **profit-after-fees of early conviction**, not raw accuracy. (Not a code fork — a product acknowledgement.)

**D. Near-close research seals.** Drop the near-close seals entirely (pure focus) **vs** keep them as a *labeled research shadow* (not the product) purely to quantify the early-vs-late accuracy gap — *mildly recommended*, it's cheap and tells you exactly what earliness costs.

---

## 10. Phased implementation plan (only after approval)

- **Phase A — the reuse-heavy 80%.** Rolling bar/price layer · open-phase 1s capture · families 1, 3, 4, 7, 8 (distance, momentum, volatility, distance-vs-time, Kalshi-last) · decision layer v0 · single minute-3 seal · grading + reason string. This alone is a working scalping engine on the evidence that already exists.
- **Phase B — the new families.** Market structure (2) + multi-timeframe agreement (6).
- **Phase C — optional.** Real trade-tape order flow (5), only if Phase A/B leave signal on the table.

Every phase: pre-registered hypotheses, frozen version, RVR + independent CTO falsification, shadow-only, `emission_prod = 0`. No date is protected at the expense of verification.

---

*Prepared by CTO. No implementation has begun. On approval of the §9 forks, I'll pre-register V2's ontology + hypotheses, freeze, and build Phase A first.*

---

## FOUNDER DECISIONS — 2026-07-24 (LOCKED)
- **A. Clock governance:** RESTART the shadow clock under V2 (new frozen engine). Phase-1 capture substrate reused. Frozen Phase-1 not mutated.
- **B. Order flow:** BUILD REAL BTC TRADE-TAPE UP FRONT (aggressor/delta/absorption). Phase C moves into the core build, not deferred.
- **C. Success bar:** PROFIT AFTER FEES over 30 days. Accuracy is evidence, not the target. V2 passes if minute-3 conviction is +EV after Kalshi fees + spread — even if raw accuracy is below the near-close reads.
- **D. Near-close seals:** KEEP as a labeled RESEARCH shadow (not the product) to quantify the early-vs-late accuracy gap.

Next (CTO, per RVS): finalize the frozen V2 spec → pre-register V2 ontology + hypotheses (append-only) → freeze → build Phase A (+ trade-tape) → RVR + CTO falsification → shadow. No live seal before the freeze.
