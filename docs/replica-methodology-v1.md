# Replica Index Methodology v1

**Status:** frozen as `replica-methodology-v1` in `founder_alpha.fa_ontology_versions`.

**What this is:** a public-data approximation of the index Kalshi settles KXBTC15M against.

**What this is NOT:** the actual index. CF Benchmarks' BRTI is a licensed product with a
proprietary construction. This document describes a re-implementation built from free public
WebSocket feeds. **The gap between this replica and the true settlement value is the object of
study in Phase 0** — it is not an implementation detail to be hidden, and every persisted row
carries the replica value and its error separately so the gap stays measurable.

---

## 1. What Kalshi actually settles on

From the live API (`fixtures/02-series-KXBTC15M.json`, `fixtures/04-market-detail.json`):

```
settlement_sources: [{ name: "CF Benchmarks", url: "https://www.cfbenchmarks.com/" }]
fee_type:           quadratic
frequency:          fifteen_min
```

And the authoritative per-market rules text:

> If the simple average of the sixty seconds of CF Benchmarks' BRTI before 11:15 PM EDT on
> Jul 22, 2026 is at least the simple average of the sixty seconds of CF Benchmarks' BRTI
> before 11:00 PM EDT on July 22, 2026, then the market resolves to Yes.

### The critical detail

**Both** legs are 60-second averages:

| Leg | Definition |
|---|---|
| Reference | mean of the 60 BRTI prints in the minute **before window open** |
| Settlement | mean of the 60 BRTI prints in the minute **before window close** |
| Resolution | `YES` if `settlement >= reference` |

The reference is **not** a strike chosen in advance. It is itself a computed average, which
Kalshi publishes as `floor_strike` once the opening minute has elapsed. Before that it reads
`Target price: TBD`.

A replica that only reproduces the *closing* average is solving half the problem. This
implementation maintains a continuous trailing 60s mean so that either leg can be read at any
instant, and the worker refreshes `floor_strike` on every discovery pass rather than trusting
the first read.

The final value is rounded to 2 decimal places.

---

## 2. Venues

Four public order-book feeds, no API keys:

| Venue | Endpoint | Channel |
|---|---|---|
| Coinbase | `wss://ws-feed.exchange.coinbase.com` | `ticker` (BTC-USD) |
| Kraken | `wss://ws.kraken.com/v2` | `ticker` (BTC/USD) |
| Bitstamp | `wss://ws.bitstamp.net` | `order_book_btcusd` |
| Gemini | `wss://api.gemini.com/v2/marketdata` | `l2` (BTCUSD) |

Gemini publishes deltas rather than snapshots, so the client maintains local book state and
derives top-of-book from it; that state is discarded and rebuilt on every reconnect, because a
delta stream resumed against a stale book is silently wrong.

**These are not necessarily BRTI's constituent exchanges.** Constituent selection is part of
what makes BRTI proprietary. Venue mismatch is one of the known error sources listed in §6.

---

## 3. The formula

For each venue `v` with a fresh, uncrossed top-of-book:

```
mid_v    = (bid_v + ask_v) / 2
spread_v = ask_v - bid_v
depth_v  = bid_size_v + ask_size_v        (top of book only)

w_v      = (1 / max(spread_v, 0.01)) * sqrt(max(depth_v, 1e-9))
```

Outlier rejection, against the cross-venue **median** mid:

```
drop v if |mid_v - median| / median > 50 bps
```

Aggregate over survivors:

```
index = Σ(w_v · mid_v) / Σ(w_v)
```

Published at **1 Hz**. Rounded to 2dp, matching the settlement convention.

### Why this weighting

Inverse-spread weighting is the BRTI-like property worth reproducing: the venue currently
quoting the tightest market is the one with the most information, and it should dominate. The
`sqrt(depth)` term stops a venue with a one-lot tight quote from outvoting a venue with real
size behind it; the square root damps the influence of depth so a single large resting order
cannot capture the index.

The `max(spread, 0.01)` floor exists solely to prevent a division by zero on a locked book.

### Exclusion rules

| Rule | Threshold | Rationale |
|---|---|---|
| Staleness | quote older than 10s | a dead feed must not silently anchor the index |
| Crossed/locked | `ask <= bid` | structurally impossible; indicates a bad parse or a torn read |
| Outlier | >50 bps from median | one venue dislocating should not move the consolidated print |
| Minimum venues | fewer than 2 survivors | **returns `null`, never a guess** |

The last rule matters most. When the index cannot be computed honestly, the worker writes
`replica_index = null` and sets the `replica_unavailable` quality flag rather than emitting a
number that looks real. A null is analysable; a fabricated print is not.

---

## 4. Trailing averages and volatility

1 Hz prints go into a ring buffer holding one hour.

- **60s mean** — the settlement quantity. Reported with its sample count `n`, so a thin
  average (say `n = 12` after a reconnect) is visibly distinguishable from a full one.
- **Realized volatility** at 1 / 5 / 15 minutes — standard deviation of log returns between
  consecutive 1 Hz prints. Not annualised. Returns `null` below 10 prints or 5 returns, rather
  than reporting a statistic computed from a sample too small to mean anything.

---

## 5. Runtime evidence

`fixtures/11-replica-probe.json`, 75-second live probe:

| Metric | Result |
|---|---|
| Venues connected | 4 / 4 |
| Ticks with a computable index | 73 / 74 (98.6%) |
| Venue participation | coinbase 73, gemini 73, bitstamp 73, kraken 50 |
| 60s average | $65,589.54 (n = 60) |
| Realized vol (1m / 5m) | 3.17e-5 / 3.53e-5 |

Kraken participated in 50 of 73 ticks. Its `ticker` channel publishes on change rather than on
a timer, so during quiet periods its last quote ages past the 10s staleness bound and it is
correctly excluded. This is the exclusion rule working as designed, not a defect — but it does
mean the effective venue set is often three, not four, which §6 counts as an error source.

Independent sanity check: the probe's index (~$65,590) sits close to the `floor_strike` Kalshi
published for the contemporaneous window ($65,776.62). Two independently-derived numbers
agreeing to ~0.3% is weak evidence the replica is not grossly miscalibrated. It is **not**
evidence of settlement-grade accuracy — that requires the graded error distribution in
`v_fa_replica_error` over a real sample, which is exactly what Phase 0 exists to collect.

---

## 6. Known error sources

Ranked by expected contribution. Phase 0 should quantify, not assume, this ordering.

1. **Constituent mismatch.** BRTI's exchange set is not public and near-certainly differs from
   these four.
2. **Weighting mismatch.** BRTI uses a documented but non-trivial volume/liquidity scheme;
   inverse-spread × √depth is an educated approximation.
3. **Depth truncation.** Only top-of-book is used. BRTI incorporates book depth.
4. **Sampling alignment.** 1 Hz local prints will not align exactly with BRTI's own print
   schedule, so the two 60-print sets cover slightly different instants.
5. **Kraken staleness.** Frequent 3-venue operation, per §5.
6. **Clock skew.** Local wall-clock vs the exchange timestamps; no NTP discipline is assumed.
7. **Reconnect gaps.** A venue reconnecting mid-minute thins the average; `replica_60s_n`
   exposes this per row.

---

## 7. Falsifiable success criterion

Phase 0 makes no claim that this replica is accurate. It collects the evidence to decide.

The criterion, to be registered in `fa_hypothesis_ledger` before analysis:

> Over ≥200 settled windows, the absolute replica error `|replica_predicted_settlement −
> settlement_value|` is small relative to the price granularity that matters — and critically,
> `replica_outcome_agrees` is true often enough that the replica can stand in for the true
> index when reconstructing what a strategy would have seen.

`v_fa_replica_error` buckets this by session and volatility tercile, because an error that is
acceptable in quiet overnight trade may be disqualifying during a CPI print.

**If the replica cannot reproduce the settlement outcome reliably, no edge measured against it
is trustworthy, and that is a Phase 0 finding — not a failure to be engineered around.**

---

## 8. Change control

This document is `v1`, frozen in `fa_ontology_versions` alongside the code that implements it.
The table is append-only: a methodology change is a **new row and a new version**, never an
edit. Any captured row can therefore always be traced to the exact methodology in force when
it was written.
