# TSM Engine Doctrine — The One Question

**Status: governing principle for every TSM engine — Options, Prediction Markets, BTC. Founder-set, 2026-07-24.**

Every TSM engine exists to answer one decision and make money from it. Nothing else.

> **Everything in the engine exists only to make that one call correct more often.**

That is the lens applied to every factor, model, indicator, data feed, and line of analysis. Each piece must answer a single question:

> **Does this measurably improve our ability to make money by making better decisions?**

If the answer is no, it does not belong in the engine — no matter whether it is interesting, technically impressive, or used by hedge funds.

## What this rules out
- Nothing exists because it's interesting.
- Nothing exists because hedge funds use it.
- Nothing exists because it's technically impressive.
- Nothing exists to make the engine better at *explaining itself*. We optimize to be right and to make money, not to narrate.

## How it is enforced (not assumed)
1. **Ablation earns inclusion.** Every factor must improve out-of-sample, money-graded accuracy versus the engine without it. If removing it doesn't hurt the money, it is cut.
2. **Grade on the real outcome + net P&L after fees** — not on elegance, not on agreement with any market, not on explanatory richness.
3. **Frozen versions, no silent tuning.** Weights and thresholds are pre-registered and frozen; every result is attributable to a version.
4. **Calibration is tracked but subordinate.** Being right about how sure we are matters — but the objective function is the correct call and the money.

## The one question, per engine
- **BTC Alpha:** Will BTC settle ABOVE or BELOW the strike?
- **Options:** Will this setup make money at the stated size, net of costs?
- **Prediction Markets:** Will this event resolve YES or NO, and is our read better than the field?

Every analytical addition to any of these engines is reviewed against the one question above. That review is not optional.
