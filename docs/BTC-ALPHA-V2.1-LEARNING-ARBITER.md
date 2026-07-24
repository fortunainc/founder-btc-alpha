# BTC Alpha V2.1 — The Learning Arbiter (architecture addition)

Design only. Companion to BTC-ALPHA-V2-DIRECTIONAL-ENGINE-DESIGN. Governed by TSM-ENGINE-DOCTRINE.md.

## Requirement
Leave room for the arbitration layer to evolve from RULE-BASED to EVIDENCE-BACKED over time.
Not in V2 / not immediately. But the architecture must make it possible — which means capturing
the training data NOW.

## The one provision added to V2.1: the Arbitration Ledger (append-only)
On every minute-3 decision, persist alongside the seal:
- regime: trend | range | breakout | event
- reachability_bucket: decided_above | contested | decided_below   (from z)
- evidence[]: per factor { side: yes|no|flat, strength: 0..1 } for
  order_flow, momentum, structure, vwap, liquidity, s_r, mtf
- conflict_signature: canonical key of the disagreement
- decision: TAKE_YES | TAKE_NO | NO_TRADE
- applied_weights: which frozen rule-matrix version was used
On settlement (via existing grade join): settled_side, decision_correct.
Cheap: reuses the families jsonb + append-only decision/grade tables. No new infra.

## Conflict signature
signature = ( regime, reachability_bucket, which factors said YES, which said NO,
              coarse strength band of each )
e.g. `trend · contested · YES={momentum} · NO={structure,vwap} · str=high/med`
Group history by signature -> realized win-rate per conflict = the empirical answer to
"which evidence should dominate here."

## Evolution: rule -> evidence, per signature, money-gated
- Prior = frozen rule matrix (V2.1).
- Posterior = realized settle-side win-rate for the signature.
- Blend by empirical-Bayes shrinkage: trust the data in proportion to sample size, per signature.
- Promotion of a learned override requires: min-sample threshold + out-of-sample improvement in
  settle-side accuracy AND net P&L + frozen-version + CTO sign-off. If it doesn't make more money,
  it does not ship. Always reversible: decayed edges revert toward the rule prior.

## Why it is a moat
Rules are copyable; a proprietary, growing record of how each specific evidence-conflict actually
resolved — for this exact question, across thousands of BTC windows and every regime — is not.

## Phasing
- V2.1 (now): rule-based arbiter + Arbitration Ledger captured from day one.
- V2.x: per-signature realized win-rates surfaced + monitored; no override.
- V3: evidence-backed arbiter (rule prior blended with per-signature posterior), money-gated.

Output unchanged: TAKE YES / TAKE NO / NO TRADE.
