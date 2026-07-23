-- =====================================================================
-- Founder BTC Alpha — Phase 0 schema v1
-- =====================================================================
-- WRITE-ONLY ARTEFACT: this file is NOT applied by any code in this repo.
-- The CTO applies it manually via the Supabase SQL editor.
--
-- ISOLATION NOTE (dispatch hard rule 1): this schema references ZERO
-- `public.tsm_*` objects. The append-only enforcement trigger is
-- re-implemented locally as `founder_alpha.fa_reject_mutation()`. Any
-- resemblance to a TSM pattern is a re-implementation, not an import.
--
-- Every table is append-only and RLS-enabled with NO permissive policy,
-- i.e. default-deny. The service role bypasses RLS by design in Postgres,
-- which is how the capture worker writes; anon/authenticated get nothing.
-- =====================================================================

BEGIN;

CREATE SCHEMA IF NOT EXISTS founder_alpha;

COMMENT ON SCHEMA founder_alpha IS
  'Phase 0 capture-only research schema for Kalshi KXBTC15M. Append-only. No models, no orders.';

-- ---------------------------------------------------------------------
-- Append-only enforcement (local re-implementation; no external deps)
-- ---------------------------------------------------------------------
CREATE OR REPLACE FUNCTION founder_alpha.fa_reject_mutation()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, pg_temp
AS $fn$
BEGIN
  RAISE EXCEPTION
    'founder_alpha.% is append-only; % is not permitted (attempted by role %)',
    TG_TABLE_NAME, TG_OP, current_user
    USING ERRCODE = '42501';
  RETURN NULL;
END;
$fn$;

COMMENT ON FUNCTION founder_alpha.fa_reject_mutation() IS
  'Raises on UPDATE/DELETE to keep research tables append-only. Local implementation.';

-- =====================================================================
-- 1. fa_window_capture — the per-second/per-5s capture record
-- =====================================================================
CREATE TABLE IF NOT EXISTS founder_alpha.fa_window_capture (
  id                  bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  window_id           text        NOT NULL,
  event_ticker        text,
  ts                  timestamptz NOT NULL,
  captured_at         timestamptz NOT NULL DEFAULT now(),

  -- Kalshi book, YES ("up") side
  up_bid              numeric(8,4),
  up_ask              numeric(8,4),
  up_bid_size         numeric(18,4),
  up_ask_size         numeric(18,4),
  up_depth_2c_bid     numeric(18,4),
  up_depth_2c_ask     numeric(18,4),
  up_mid              numeric(8,4),

  -- Kalshi book, NO ("down") side
  down_bid            numeric(8,4),
  down_ask            numeric(8,4),
  down_bid_size       numeric(18,4),
  down_ask_size       numeric(18,4),
  down_depth_2c_bid   numeric(18,4),
  down_depth_2c_ask   numeric(18,4),
  down_mid            numeric(8,4),

  last_trade_price    numeric(8,4),
  volume              numeric(18,4),
  open_interest       numeric(18,4),

  -- Replica index (approximation of CF Benchmarks BRTI)
  replica_index       numeric(18,2),
  replica_60s_avg     numeric(18,2),
  replica_60s_n       integer,
  replica_venues_used text[],
  replica_venue_count integer,
  replica_weight_share jsonb,

  -- Reference leg: the 60s BRTI average before window OPEN, which Kalshi
  -- exposes as floor_strike once the open minute has elapsed.
  reference_strike    numeric(18,2),
  replica_vs_reference numeric(18,2),

  -- Realized vol from the replica
  rv_1m               double precision,
  rv_5m               double precision,
  rv_15m              double precision,

  -- Context
  session_bucket      text NOT NULL,
  macro_flag          boolean NOT NULL DEFAULT false,
  macro_events        text[],
  seconds_to_close    integer,
  capture_phase       text,          -- 'normal' (5s) | 'final120' (1s)

  quality_flags       jsonb NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT fa_window_capture_session_ck CHECK (
    session_bucket IN ('us_rth','eu','asia','overnight','weekend')
  ),
  CONSTRAINT fa_window_capture_phase_ck CHECK (
    capture_phase IS NULL OR capture_phase IN ('normal','final120')
  ),
  CONSTRAINT fa_window_capture_prices_ck CHECK (
    (up_bid   IS NULL OR (up_bid   >= 0 AND up_bid   <= 1)) AND
    (up_ask   IS NULL OR (up_ask   >= 0 AND up_ask   <= 1)) AND
    (down_bid IS NULL OR (down_bid >= 0 AND down_bid <= 1)) AND
    (down_ask IS NULL OR (down_ask >= 0 AND down_ask <= 1))
  )
);

CREATE INDEX IF NOT EXISTS fa_window_capture_window_ts_idx
  ON founder_alpha.fa_window_capture (window_id, ts);
CREATE INDEX IF NOT EXISTS fa_window_capture_ts_idx
  ON founder_alpha.fa_window_capture (ts);
CREATE INDEX IF NOT EXISTS fa_window_capture_session_idx
  ON founder_alpha.fa_window_capture (session_bucket, ts);
-- Partial index: invariant violations are the rows we actually query for.
CREATE INDEX IF NOT EXISTS fa_window_capture_flagged_idx
  ON founder_alpha.fa_window_capture (window_id, ts)
  WHERE quality_flags <> '{}'::jsonb;

COMMENT ON TABLE founder_alpha.fa_window_capture IS
  'Append-only orderbook + replica snapshots per KXBTC15M window. 5s cadence, 1s in final 120s.';
COMMENT ON COLUMN founder_alpha.fa_window_capture.reference_strike IS
  'Kalshi floor_strike = 60s BRTI mean before window OPEN. Settlement compares the closing 60s mean to this.';

-- =====================================================================
-- 2. fa_forecast_seal — EMPTY IN PHASE 0 (no models are permitted)
-- =====================================================================
CREATE TABLE IF NOT EXISTS founder_alpha.fa_forecast_seal (
  id                 bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  model_id           text        NOT NULL,
  model_version      text        NOT NULL,
  window_id          text        NOT NULL,
  sealed_p           numeric(8,6) NOT NULL,
  executable_prices  jsonb       NOT NULL DEFAULT '{}'::jsonb,
  sealed_at          timestamptz NOT NULL DEFAULT now(),
  -- Stored so the seal-before-close invariant is checkable in-row rather than
  -- depending on a join that may not yet exist.
  window_close_ts    timestamptz,

  CONSTRAINT fa_forecast_seal_p_ck CHECK (sealed_p >= 0 AND sealed_p <= 1),
  -- The whole point of a sealed forecast: it must predate the outcome.
  CONSTRAINT fa_forecast_seal_before_close_ck CHECK (
    window_close_ts IS NULL OR sealed_at < window_close_ts
  ),
  CONSTRAINT fa_forecast_seal_unique UNIQUE (model_id, model_version, window_id)
);

CREATE INDEX IF NOT EXISTS fa_forecast_seal_window_idx
  ON founder_alpha.fa_forecast_seal (window_id);

COMMENT ON TABLE founder_alpha.fa_forecast_seal IS
  'MUST REMAIN EMPTY IN PHASE 0. Phase 0 is capture-only; no forecasts may be written.';

-- =====================================================================
-- 3. fa_settlement_grade — outcome + replica accuracy
-- =====================================================================
CREATE TABLE IF NOT EXISTS founder_alpha.fa_settlement_grade (
  id                          bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  window_id                   text        NOT NULL,
  event_ticker                text,
  window_open_ts              timestamptz,
  window_close_ts             timestamptz,

  settlement_value            numeric(18,2),
  reference_strike            numeric(18,2),
  outcome                     text,

  replica_predicted_settlement numeric(18,2),
  replica_predicted_outcome    text,
  replica_error                numeric(18,2),
  replica_error_bps            double precision,
  replica_outcome_agrees       boolean,

  replica_60s_n                integer,
  session_bucket               text,
  macro_flag                   boolean DEFAULT false,
  rv_5m_at_close               double precision,

  graded_at                   timestamptz NOT NULL DEFAULT now(),
  quality_flags               jsonb NOT NULL DEFAULT '{}'::jsonb,

  CONSTRAINT fa_settlement_grade_outcome_ck CHECK (
    outcome IS NULL OR outcome IN ('yes','no','void')
  ),
  CONSTRAINT fa_settlement_grade_replica_outcome_ck CHECK (
    replica_predicted_outcome IS NULL OR replica_predicted_outcome IN ('yes','no')
  ),
  CONSTRAINT fa_settlement_grade_session_ck CHECK (
    session_bucket IS NULL OR
    session_bucket IN ('us_rth','eu','asia','overnight','weekend')
  ),
  CONSTRAINT fa_settlement_grade_window_unique UNIQUE (window_id)
);

CREATE INDEX IF NOT EXISTS fa_settlement_grade_close_idx
  ON founder_alpha.fa_settlement_grade (window_close_ts);

COMMENT ON TABLE founder_alpha.fa_settlement_grade IS
  'One row per settled window: true outcome vs what the replica would have predicted.';

-- =====================================================================
-- 4. fa_hypothesis_ledger — pre-registration of every claim
-- =====================================================================
CREATE TABLE IF NOT EXISTS founder_alpha.fa_hypothesis_ledger (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  statement     text        NOT NULL,
  metric        text        NOT NULL,
  threshold     numeric     NOT NULL,
  min_sample    integer     NOT NULL,
  regime_scope  jsonb       NOT NULL DEFAULT '{}'::jsonb,
  registered_at timestamptz NOT NULL DEFAULT now(),
  status        text        NOT NULL DEFAULT 'open',
  notes         text,

  CONSTRAINT fa_hypothesis_ledger_status_ck CHECK (
    status IN ('open','supported','refuted','exploratory')
  ),
  CONSTRAINT fa_hypothesis_ledger_min_sample_ck CHECK (min_sample > 0)
);

COMMENT ON TABLE founder_alpha.fa_hypothesis_ledger IS
  'Pre-registered hypotheses. Append-only so a hypothesis cannot be silently reworded after seeing data.';

-- =====================================================================
-- 5. fa_ontology_versions — frozen specs
-- =====================================================================
CREATE TABLE IF NOT EXISTS founder_alpha.fa_ontology_versions (
  id        bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind      text        NOT NULL,
  version   text        NOT NULL,
  spec      jsonb       NOT NULL,
  frozen_at timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT fa_ontology_versions_unique UNIQUE (kind, version)
);

COMMENT ON TABLE founder_alpha.fa_ontology_versions IS
  'Frozen, versioned specs (fee model, replica methodology). Append-only: a new version is a new row.';

-- ---------------------------------------------------------------------
-- Append-only triggers on all five tables
-- ---------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'fa_window_capture',
    'fa_forecast_seal',
    'fa_settlement_grade',
    'fa_hypothesis_ledger',
    'fa_ontology_versions'
  ]
  LOOP
    EXECUTE format('DROP TRIGGER IF EXISTS %I ON founder_alpha.%I', t || '_append_only', t);
    EXECUTE format(
      'CREATE TRIGGER %I BEFORE UPDATE OR DELETE ON founder_alpha.%I
         FOR EACH STATEMENT EXECUTE FUNCTION founder_alpha.fa_reject_mutation()',
      t || '_append_only', t
    );
  END LOOP;
END;
$$;

-- ---------------------------------------------------------------------
-- RLS: enabled, FORCED, and NO policies => default deny for every role
-- except those that bypass RLS (the service role the worker uses).
-- ---------------------------------------------------------------------
DO $$
DECLARE
  t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'fa_window_capture',
    'fa_forecast_seal',
    'fa_settlement_grade',
    'fa_hypothesis_ledger',
    'fa_ontology_versions'
  ]
  LOOP
    EXECUTE format('ALTER TABLE founder_alpha.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE founder_alpha.%I FORCE ROW LEVEL SECURITY', t);
  END LOOP;
END;
$$;

-- Belt and braces: no grants to the public API roles at all.
REVOKE ALL ON ALL TABLES    IN SCHEMA founder_alpha FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA founder_alpha FROM anon, authenticated;
REVOKE ALL ON SCHEMA founder_alpha              FROM anon, authenticated;

-- =====================================================================
-- Views
-- =====================================================================

-- v_fa_replica_error — per settled window, bucketed by session and vol tercile.
CREATE OR REPLACE VIEW founder_alpha.v_fa_replica_error AS
WITH graded AS (
  SELECT
    g.window_id,
    g.window_close_ts,
    g.session_bucket,
    g.macro_flag,
    g.settlement_value,
    g.replica_predicted_settlement,
    g.replica_error,
    g.replica_error_bps,
    g.replica_outcome_agrees,
    g.outcome,
    g.replica_predicted_outcome,
    g.rv_5m_at_close
  FROM founder_alpha.fa_settlement_grade g
  WHERE g.settlement_value IS NOT NULL
    AND g.replica_predicted_settlement IS NOT NULL
),
tercile AS (
  SELECT
    graded.*,
    -- NTILE over the non-null vol population only; windows without a vol
    -- reading are bucketed 'unknown' rather than silently dropped.
    CASE
      WHEN rv_5m_at_close IS NULL THEN NULL
      ELSE NTILE(3) OVER (
        PARTITION BY (rv_5m_at_close IS NULL)
        ORDER BY rv_5m_at_close
      )
    END AS vol_tercile_n
  FROM graded
)
SELECT
  window_id,
  window_close_ts,
  session_bucket,
  macro_flag,
  settlement_value,
  replica_predicted_settlement,
  replica_error,
  replica_error_bps,
  abs(replica_error)     AS abs_replica_error,
  abs(replica_error_bps) AS abs_replica_error_bps,
  outcome,
  replica_predicted_outcome,
  replica_outcome_agrees,
  rv_5m_at_close,
  CASE vol_tercile_n
    WHEN 1 THEN 'low'
    WHEN 2 THEN 'mid'
    WHEN 3 THEN 'high'
    ELSE 'unknown'
  END AS vol_tercile
FROM tercile;

COMMENT ON VIEW founder_alpha.v_fa_replica_error IS
  'Per-window replica error vs true settlement, bucketed by session and vol tercile.';

-- v_fa_capture_health — uptime, snapshot counts, gap census, invariant breaches.
CREATE OR REPLACE VIEW founder_alpha.v_fa_capture_health AS
WITH ordered AS (
  SELECT
    window_id,
    ts,
    (ts AT TIME ZONE 'UTC')::date AS day,
    capture_phase,
    quality_flags,
    ts - LAG(ts) OVER (PARTITION BY window_id ORDER BY ts) AS gap
  FROM founder_alpha.fa_window_capture
)
SELECT
  day,
  count(*)                                         AS snapshots,
  count(DISTINCT window_id)                        AS windows_seen,
  count(*) FILTER (WHERE capture_phase = 'final120') AS final120_snapshots,
  count(*) FILTER (WHERE gap > interval '30 seconds') AS gaps_over_30s,
  COALESCE(
    EXTRACT(EPOCH FROM max(gap) FILTER (WHERE gap > interval '30 seconds')),
    0
  )::numeric(12,2)                                 AS worst_gap_seconds,
  count(*) FILTER (WHERE quality_flags <> '{}'::jsonb) AS rows_with_any_flag,
  count(*) FILTER (WHERE quality_flags ? 'sum_out_of_band')   AS invariant_sum_violations,
  count(*) FILTER (WHERE quality_flags ? 'non_monotonic_ts')  AS invariant_ts_violations,
  count(*) FILTER (WHERE quality_flags ? 'capture_gap')       AS invariant_gap_violations,
  count(*) FILTER (WHERE quality_flags ? 'replica_unavailable') AS replica_unavailable_rows,
  -- Uptime proxy: observed snapshots vs the number expected if every window
  -- seen that day had been captured end-to-end at the specified cadence.
  -- 15-min window = 13 min at 5s (156) + 2 min at 1s batched to 5s (24) = 180.
  round(
    100.0 * count(*) / NULLIF(count(DISTINCT window_id) * 180, 0),
    2
  )                                                AS uptime_pct_of_expected
FROM ordered
GROUP BY day
ORDER BY day DESC;

COMMENT ON VIEW founder_alpha.v_fa_capture_health IS
  'Daily capture health: snapshot counts, >30s gap census, invariant violations, uptime proxy.';

-- =====================================================================
-- Seed rows — frozen ontology versions
-- =====================================================================
INSERT INTO founder_alpha.fa_ontology_versions (kind, version, spec)
VALUES (
  'fee-model',
  'v1',
  jsonb_build_object(
    'series_ticker',            'KXBTC15M',
    'fee_type',                 'quadratic',
    'api_fee_multiplier',       1,
    'quadratic_base_rate',      0.07,
    'effective_taker_multiplier', 0.07,
    'formula',                  'fee_dollars = ceil_to_cent(0.07 * C * P * (1 - P))',
    'rounding',                 'ceil_to_cent, applied to the whole order not per contract',
    'maker_fee_applies',        false,
    'maker_fee_confidence',     'PARTIAL - inferred from absence of an API field, not positively confirmed',
    'worked_examples',          jsonb_build_array(
      jsonb_build_object('price', 0.50, 'contracts', 1, 'raw', 0.0175,   'fee_dollars', 0.02),
      jsonb_build_object('price', 0.20, 'contracts', 1, 'raw', 0.0112,   'fee_dollars', 0.02),
      jsonb_build_object('price', 0.05, 'contracts', 1, 'raw', 0.003325, 'fee_dollars', 0.01)
    ),
    'source',                   'Kalshi GET /trade-api/v2/series/KXBTC15M; fixture 02-series-KXBTC15M.json',
    'verified',                 true
  )
)
ON CONFLICT (kind, version) DO NOTHING;

INSERT INTO founder_alpha.fa_ontology_versions (kind, version, spec)
VALUES (
  'replica-methodology',
  'v1',
  jsonb_build_object(
    'target_index',      'CF Benchmarks BRTI (Bitcoin Real Time Index)',
    'relationship',      'APPROXIMATION - not the licensed index; error is the object of study',
    'venues',            jsonb_build_array('coinbase','kraken','bitstamp','gemini'),
    'inputs',            'public market-data WebSockets, top-of-book bid/ask/size, no API keys',
    'per_venue_mid',     '(bid + ask) / 2',
    'weight',            'w_v = (1 / max(spread_v, 0.01)) * sqrt(max(depth_v, 1e-9))',
    'aggregation',       'index = sum(w_v * mid_v) / sum(w_v)',
    'outlier_rejection', 'drop venues deviating > 50 bps from the cross-venue median mid',
    'staleness_ms',      10000,
    'min_venues',        2,
    'publish_hz',        1,
    'settlement_rule',   'YES if mean(BRTI, 60s before close) >= mean(BRTI, 60s before open)',
    'trailing_average',  '60s simple mean of 1 Hz prints, maintained continuously',
    'doc',               'docs/replica-methodology-v1.md'
  )
)
ON CONFLICT (kind, version) DO NOTHING;

COMMIT;

-- =====================================================================
-- POST-APPLY VERIFICATION (run separately; expect the marked failures)
-- =====================================================================
-- SELECT schemaname, tablename, rowsecurity FROM pg_tables
--   WHERE schemaname = 'founder_alpha';                  -- rowsecurity must be true for all 5
-- SELECT kind, version FROM founder_alpha.fa_ontology_versions;  -- expect 2 rows
-- UPDATE founder_alpha.fa_ontology_versions SET version = 'x';   -- MUST raise 42501
-- DELETE FROM founder_alpha.fa_ontology_versions;                -- MUST raise 42501
-- SELECT count(*) FROM founder_alpha.fa_forecast_seal;           -- MUST be 0 in Phase 0
