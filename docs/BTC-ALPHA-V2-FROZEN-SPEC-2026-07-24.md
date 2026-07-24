# BTC Alpha V2 — Scalping Decision Engine · FROZEN SPECIFICATION
**Engine id:** `btc-alpha-v2-scalp` · **Spec version:** v2.0.0 · **2026-07-24**
**Status: FREEZE CANDIDATE — to be pre-registered (append-only) before any live seal.**
Governance: new frozen engine (founder decision A, 2026-07-24). Frozen Phase-1 untouched. `emission_prod = 0`. Shadow only until Day-14. Success bar = **profit after fees** (decision C).

---

## 1. The single decision
For each new KXBTC15M window, produce exactly ONE sealed output — `TAKE YES` / `TAKE NO` / `NO TRADE` — answering: *does BTC have a realistic path to finish above the strike?* Sealed once, then grading only. No updates.

## 2. Seal timing (hard)
- **Seal at τ = 720s remaining (minute 3 of the window).** One seal per window.
- Preconditions to seal a directional call: strike known (floor_strike published, ~min 1) · replica index live (≥2 venues) · ≥15 min continuous history warm · trade-tape connected. If any missing at τ=720s → **NO TRADE** (reason: data-not-ready), logged.
- Open-phase capture densifies to 1s for the first 180s so the seal reads fresh data.

## 3. Evidence families — each emits {vote ∈ long/short/neutral, confidence ∈ 0..1, reading (human text)}
All families are pure functions over frozen inputs. Weights/params below are FROZEN at pre-registration; no tuning to backtests.

- **F1 Distance-to-strike** (reuse). Inputs S=replica, K=strike, τ. Outputs $ dist, % dist, required move/min, required move/sec. Vote: neutral (context family; feeds F7). Confidence from |%dist|.
- **F2 Market structure** (new; needs bar layer). Bars 1m/3m/5m. Detect trend (HH/HL vs LH/LL), range/compression (ATR-normalized range), last event (breakout / rejection / sweep / false-breakout). Vote = structure bias (long if uptrend/bullish break toward strike side; short if opposite); confidence from cleanliness of structure.
- **F3 Momentum** (reuse+extend). Returns over 30s/1m/3m/5m + acceleration (Δreturn) + impulse quality (run vs chop). Vote = signed momentum toward/away from strike; confidence from consistency across horizons.
- **F4 Volatility** (reuse+extend). rv_1m/5m/15m, ATR, expansion/contraction regime, **expected move to settlement = σ_eff·√τ in $**. Vote: neutral (feeds F7); confidence = regime clarity. Contributes the "is the required move even reachable" magnitude.
- **F5 Order flow** (new, real trade-tape — decision B). Aggressor delta (buy vs sell taker volume), absorption, book imbalance (Kalshi + spot top-of-book). Vote = who controls (long if net aggressive buying), confidence from delta magnitude/persistence. **Pre-registered as LOW weight** at 12-min horizon; kept for research value.
- **F6 Multi-timeframe** (new). Structure+momentum computed per 1m/3m/5m/15m; vote = long only if ≥3 of 4 timeframes agree directionally (NOT an average); confidence from degree of agreement; neutral/conflict → pushes toward NO TRADE.
- **F7 Distance-vs-time GATE** (reuse of B1 diffusion, re-expressed in $). required_move = K − S (signed). projected_move = z·σ_eff·√τ (z frozen). **Hard gate:** if required_move to the YES side exceeds projected_move band → YES path implausible (blocks TAKE YES; supports TAKE NO), and symmetrically. This is a MAJOR input, not a tiebreaker.
- **F8 Kalshi pricing** (reuse, LAST). Compare V2 directional lean to market up-mid; is the favored side over/under-priced after fee+half-spread? Vote confirms only if the edge survives cost; if the market already prices the lean away → downgrade toward NO TRADE.

## 4. Decision rule (frozen)
1. Compute all families.
2. **F7 gate first:** if the favored direction's required move is outside the projected band by > tolerance → that direction is forbidden.
3. **Directional consensus:** sum weighted votes of F2,F3,F5,F6 (structure/momentum/flow/MTF), gated by F7, into a net directional score in [−1,+1]. Weights frozen (structure & MTF highest; flow lowest).
4. **NO TRADE if any:** F7 says the path is implausible both ways OR net |directional score| < conviction_floor (frozen) OR F6 timeframes conflict OR F8 shows the edge doesn't clear fees+spread OR data-not-ready.
5. Else **TAKE YES / TAKE NO** = sign of the gated directional score.
6. Emit a deterministic reason string (§5). No probability is shown as the headline.

## 5. Reason string (deterministic template, no jargon/AI language)
`"BTC would need to {move $X} in {mins} min. {Momentum reading}. {Structure reading}. {Volatility reading}. Path to strike is {plausible/unlikely}. Market is {over/under}-estimating the chance of finishing above the strike. Recommendation: {TAKE YES/NO/NO TRADE}."`

## 6. Storage & grading
Per window, seal: recommendation, all family readings + votes + confidences, full evidence snapshot, reason string, executable ask at seal. On settlement: actual result, correct/incorrect, **P&L after Kalshi fees at the executable ask** (primary), reason. New table `founder_alpha.fa_v2_decisions` (append-only) + grading view; reuse the paper-P&L methodology already built.

## 7. Pre-registered hypotheses (frozen — the test)
- **H1 (PRIMARY):** minute-3 V2 recommendations are **net profitable after Kalshi fees + half-spread at executable prices** over the 30-day shadow (n≥ pre-registered floor). *Pass = mean net P&L per actioned trade > 0 with cluster-robust CI excluding 0.*
- **H2:** TAKE-YES/NO calls beat a random-side baseline and a always-follow-market baseline on net P&L.
- **H3:** the F7 distance-vs-time gate improves net P&L vs the same engine with F7 disabled (ablation).
- **H4:** abstention is disciplined — NO-TRADE windows would have been net-negative or sub-fee on average (i.e., staying out was correct).
- **H5 (research, decision D):** quantify accuracy gap between the minute-3 seal and the retained near-close research seals (how much earliness costs).
- **H6:** order flow (F5) adds measurable net-P&L; if its ablation delta ≈ 0 over 30 days, F5 is deprecated (documented, not silently kept).
All read at Day-14 (CONTINUE / EXTEND / RESTART) and Day-30 (PASS / FAIL / EXTEND). Thin data → EXTEND.

## 8. What is removed / retired
- The 3 near-close **decision** seals (T-10/5/2) are retired as the product; retained only as a labeled **research shadow** (decision D).
- YES/NO/FAIR/THIN probability-divergence framing is demoted to F8 evidence, never the headline.

## 9. Ontology to pre-register (append-only rows)
`fa_ontology_versions`: v2 engine id + spec hash + seal-timing + family weights + gate params + fee model ref. `fa_hypothesis_ledger`: H1–H6 with pre-committed pass criteria + Day-14/Day-30 read rules. Frozen timestamp recorded; no edits after freeze (append a new version to change anything).

*CTO, 2026-07-24 — freeze candidate. On pre-registration + freeze, build Phase A (bars + F1/F3/F4/F7/F8 + decision v0 + seal + grading), then F2/F6, then F5 trade-tape. Each: RVR + CTO falsification, shadow only.*
