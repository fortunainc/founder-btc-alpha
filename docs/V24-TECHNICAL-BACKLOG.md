# v2.4 TECHNICAL-FAMILY BACKLOG (frozen-window discipline, 2026-07-26)
v2.4 stays FROZEN for its 30-day window (Day 1 = 2026-07-26T16:56:20Z). Any family below
lands only in a separately versioned, registered challenger (v2.5+); v2.4 continues
unchanged as the incumbent comparison.

| Family | Why it may improve a 15-min decision | Source | Latency | License | Difficulty | Objective definition sketch | Decision role | Replayable? | Prospective test |
|---|---|---|---|---|---|---|---|---|---|
| STRAT magnitude targets | Distance objective for reachability + take-profit calibration | existing candles | none | none | LOW | prior bar range projection from trigger bar | target/TP input | YES (ticks stored) | challenger shadow vs v2.4 |
| Distinct CHoCH | First counter-trend break is a REGIME event, stronger than routine BOS | existing candles | none | none | LOW-MED | BOS against the prevailing swing sequence direction | controlling-evidence tier | YES | same |
| Order blocks | Entry-zone precision at institutional origin candles | needs footprint/volume | — | exchange data feed (paid) | HIGH | last opposing candle before displacement, volume-validated | entry refinement | NO (no stored volume) | only after source lands |
| Volume / relative volume | Participation confirms or fades breaks | exchange trades feed (e.g. Coinbase) | seconds | free API (rate-limited) | MED | rolling vol vs same-time-of-day baseline | confirmation weight | partial (from feed start) | capture-first, scored:false |
| Basis / funding | Crowding + squeeze fuel detection | perp venue APIs | seconds-min | ToS review needed | MED | perp-spot spread, funding sign/velocity | regime damper | from feed start | capture-first |
| Open interest / liquidations | Forced-flow prediction near strikes | venue APIs / aggregators | seconds-min | mostly paid | MED-HIGH | OI delta windows; liquidation clusters vs price levels | sweep-anticipation | NO historically | capture-first |
| Order-book imbalance (BTC spot) | Immediate pressure read for the final minutes | venue L2 | sub-second | free w/ limits | MED | top-N bid/ask notional ratio, time-decayed | late-window tiebreak | NO | capture-first |
| Spot-vs-derivs divergence | Leads spot at turns | combo of above | — | mixed | MED | perp-spot return gap z-score | divergence evidence | partial | capture-first |
| Options-implied (BTC) | Forward-looking vol + pin levels | Deribit/paid | min | PAID — founder decision | HIGH | IV term structure + strike gamma walls | vol regime + magnet levels | NO | after purchase only |
Rule: every family enters as CAPTURE-FIRST (recorded, scored:false) before any challenger may score it. Kalshi book imbalance is already COLLECTED_NOT_SCORED in v2.4 revisions.
