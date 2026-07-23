-- =====================================================================
-- Founder BTC Alpha — 003: forecast grading + founder verdict feed
-- =====================================================================
-- WRITE-ONLY ARTEFACT: staged for the CTO to apply via the Supabase SQL editor.
-- Follows the 002 pattern: append-only trigger + explicit service_role grants
-- (BYPASSRLS does not confer schema USAGE or table privileges).
--
-- Adds:
--   fa_forecast_grade      per-seal scoring vs realised outcome
--   v_fa_model_scoreboard  per model x seal-point x day, incl. calibration
--   v_fa_model_calibration standalone decile view (same data, usable grain)
--   v_fa_window_calls      the founder's yes/no/fair/thin verdict feed
--
-- ISOLATION: zero references to public.tsm_* objects.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- fa_forecast_grade
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS founder_alpha.fa_forecast_grade (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  seal_id           bigint      NOT NULL
                      REFERENCES founder_alpha.fa_forecast_seal(id),
  window_id         text        NOT NULL,
  model_id          text        NOT NULL,
  model_version     text        NOT NULL,
  seal_point        text        NOT NULL,
  outcome           text        NOT NULL,
  sealed_p          numeric(8,6) NOT NULL,
  market_p_at_seal  numeric(8,6),
  brier             double precision,
  log_loss          double precision,
  brier_vs_b0       double precision,
  graded_at         timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT fa_forecast_grade_outcome_ck CHECK (outcome IN ('yes','no')),
  CONSTRAINT fa_forecast_grade_seal_point_ck CHECK (seal_point IN ('T-10','T-5','T-2')),
  -- One grade per seal, forever.
  CONSTRAINT fa_forecast_grade_seal_unique UNIQUE (seal_id)
);

CREATE INDEX IF NOT EXISTS fa_forecast_grade_window_idx
  ON founder_alpha.fa_forecast_grade (window_id);
CREATE INDEX IF NOT EXISTS fa_forecast_grade_model_idx
  ON founder_alpha.fa_forecast_grade (model_id, seal_point, graded_at);

COMMENT ON TABLE founder_alpha.fa_forecast_grade IS
  'Append-only scoring of each sealed forecast against the realised outcome. brier_vs_b0 is signed: negative = model beat the market baseline.';
COMMENT ON COLUMN founder_alpha.fa_forecast_grade.brier_vs_b0 IS
  'brier(model) - brier(B0) at the SAME window and seal point. Negative is better than market.';

-- Append-only, same local implementation as 001.
DROP TRIGGER IF EXISTS fa_forecast_grade_append_only ON founder_alpha.fa_forecast_grade;
CREATE TRIGGER fa_forecast_grade_append_only
  BEFORE UPDATE OR DELETE ON founder_alpha.fa_forecast_grade
  FOR EACH STATEMENT EXECUTE FUNCTION founder_alpha.fa_reject_mutation();

ALTER TABLE founder_alpha.fa_forecast_grade ENABLE ROW LEVEL SECURITY;
ALTER TABLE founder_alpha.fa_forecast_grade FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------
-- Grants (002 pattern). SELECT+INSERT only; UPDATE/DELETE withheld so
-- append-only survives even if the trigger is ever dropped.
-- ---------------------------------------------------------------------
GRANT SELECT, INSERT ON founder_alpha.fa_forecast_grade TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA founder_alpha TO service_role;
REVOKE ALL ON founder_alpha.fa_forecast_grade FROM anon, authenticated;

-- =====================================================================
-- Shared helper: seal point parsed out of model_version ('v1@T-10')
-- =====================================================================
CREATE OR REPLACE FUNCTION founder_alpha.fa_seal_point(model_version text)
RETURNS text
LANGUAGE sql IMMUTABLE
AS $$ SELECT split_part(model_version, '@', 2) $$;

COMMENT ON FUNCTION founder_alpha.fa_seal_point(text) IS
  'Seal point encoded in model_version as <specversion>@<sealpoint>; see src/forecaster.js modelVersionFor().';

-- =====================================================================
-- v_fa_model_calibration — sealed_p decile vs realised rate
-- =====================================================================
CREATE OR REPLACE VIEW founder_alpha.v_fa_model_calibration AS
SELECT
  model_id,
  seal_point,
  LEAST(9, GREATEST(0, floor(sealed_p * 10)::int)) AS p_decile,
  count(*)                                          AS n,
  round(avg(sealed_p)::numeric, 4)                  AS mean_predicted_p,
  round(avg(CASE WHEN outcome = 'yes' THEN 1.0 ELSE 0.0 END)::numeric, 4) AS realized_rate,
  round(
    (avg(CASE WHEN outcome = 'yes' THEN 1.0 ELSE 0.0 END) - avg(sealed_p))::numeric, 4
  )                                                 AS calibration_gap
FROM founder_alpha.fa_forecast_grade
GROUP BY model_id, seal_point, LEAST(9, GREATEST(0, floor(sealed_p * 10)::int));

COMMENT ON VIEW founder_alpha.v_fa_model_calibration IS
  'Reliability curve input: predicted decile vs realised frequency. calibration_gap > 0 means the model under-predicted YES.';

-- =====================================================================
-- v_fa_model_scoreboard — per model x seal-point x day
-- =====================================================================
CREATE OR REPLACE VIEW founder_alpha.v_fa_model_scoreboard AS
WITH base AS (
  SELECT
    g.model_id,
    g.seal_point,
    (g.graded_at AT TIME ZONE 'UTC')::date AS day,
    g.sealed_p,
    g.outcome,
    g.brier,
    g.log_loss,
    g.brier_vs_b0
  FROM founder_alpha.fa_forecast_grade g
),
agg AS (
  SELECT
    model_id,
    seal_point,
    day,
    count(*)                                   AS n,
    round(avg(brier)::numeric, 6)              AS mean_brier,
    round(avg(log_loss)::numeric, 6)           AS mean_log_loss,
    round(avg(brier_vs_b0)::numeric, 6)        AS mean_brier_vs_b0,
    count(*) FILTER (WHERE brier_vs_b0 < 0)    AS windows_beating_b0,
    round(
      (count(*) FILTER (WHERE brier_vs_b0 < 0)::numeric / NULLIF(count(*), 0)), 4
    )                                          AS share_beating_b0,
    round(avg(sealed_p)::numeric, 4)           AS mean_sealed_p,
    round(avg(CASE WHEN outcome = 'yes' THEN 1.0 ELSE 0.0 END)::numeric, 4) AS realized_yes_rate
  FROM base
  GROUP BY model_id, seal_point, day
),
calib AS (
  SELECT
    model_id,
    seal_point,
    (graded_at AT TIME ZONE 'UTC')::date AS day,
    jsonb_agg(
      jsonb_build_object(
        'decile',        d.p_decile,
        'n',             d.n,
        'mean_predicted', d.mean_predicted_p,
        'realized_rate', d.realized_rate,
        'gap',           d.gap
      ) ORDER BY d.p_decile
    ) AS calibration_buckets
  FROM founder_alpha.fa_forecast_grade g
  CROSS JOIN LATERAL (
    SELECT
      LEAST(9, GREATEST(0, floor(g.sealed_p * 10)::int)) AS p_decile,
      1                                                   AS n,
      g.sealed_p                                          AS mean_predicted_p,
      CASE WHEN g.outcome = 'yes' THEN 1.0 ELSE 0.0 END   AS realized_rate,
      CASE WHEN g.outcome = 'yes' THEN 1.0 ELSE 0.0 END - g.sealed_p AS gap
  ) d
  GROUP BY model_id, seal_point, (graded_at AT TIME ZONE 'UTC')::date
)
SELECT
  a.model_id,
  a.seal_point,
  a.day,
  a.n,
  a.mean_brier,
  a.mean_log_loss,
  a.mean_brier_vs_b0,
  a.windows_beating_b0,
  a.share_beating_b0,
  a.mean_sealed_p,
  a.realized_yes_rate,
  c.calibration_buckets
FROM agg a
LEFT JOIN calib c
  ON c.model_id = a.model_id AND c.seal_point = a.seal_point AND c.day = a.day
ORDER BY a.day DESC, a.model_id, a.seal_point;

COMMENT ON VIEW founder_alpha.v_fa_model_scoreboard IS
  'Per model x seal-point x day: n, mean Brier, mean vs-B0 delta, and calibration buckets. mean_brier_vs_b0 < 0 means the model beat the market.';

-- =====================================================================
-- v_fa_window_calls — the founder verdict feed (LABELED SHADOW until Day-14)
-- =====================================================================
-- Four-state call, per founder addendum 2026-07-23:
--   YES   consensus is above market by >= threshold  (up contract underpriced)
--   NO    consensus is below market by >= threshold  (up contract overpriced)
--   FAIR  models and market agree within 1pp         (market pricing it right)
--   THIN  models could not compute, OR the disagreement is real but
--         below the actionable threshold
--
-- Threshold, stats-rules v1: exact_fee + half_spread + 1pp at executable prices.
-- Consensus EXCLUDES B0, because B0 *is* the market price -- including it would
-- shrink every divergence toward zero by construction.
-- =====================================================================
CREATE OR REPLACE VIEW founder_alpha.v_fa_window_calls AS
WITH seals AS (
  SELECT
    s.id                                              AS seal_id,
    s.window_id,
    s.model_id,
    founder_alpha.fa_seal_point(s.model_version)      AS seal_point,
    s.sealed_p,
    s.sealed_at,
    s.window_close_ts,
    (s.executable_prices ->> 'up_bid')::numeric       AS up_bid,
    (s.executable_prices ->> 'up_ask')::numeric       AS up_ask,
    (s.executable_prices ->> 'up_mid')::numeric       AS up_mid,
    (s.executable_prices ->> 'strike')::numeric       AS strike,
    (s.executable_prices ->> 'replica_index')::numeric AS replica_index
  FROM founder_alpha.fa_forecast_seal s
),
pivot AS (
  SELECT
    window_id,
    seal_point,
    min(sealed_at)                                                       AS sealed_at,
    min(window_close_ts)                                                 AS close_ts,
    max(strike)                                                          AS strike,
    max(replica_index)                                                   AS replica_index,
    max(up_bid)                                                          AS up_bid,
    max(up_ask)                                                          AS up_ask,
    max(up_mid)                                                          AS up_mid,
    max(sealed_p) FILTER (WHERE model_id = 'b0-market-price-v1')         AS p_b0,
    max(sealed_p) FILTER (WHERE model_id = 'b1-nodrift-diffusion-v1')    AS p_b1,
    max(sealed_p) FILTER (WHERE model_id = 'b2-momentum-v1')             AS p_b2,
    max(sealed_p) FILTER (WHERE model_id = 'b3-book-imbalance-v1')       AS p_b3,
    count(*)                                                             AS models_sealed
  FROM seals
  GROUP BY window_id, seal_point
),
calc AS (
  SELECT
    p.*,
    -- Market probability: prefer B0 (the sealed mid), fall back to the
    -- recorded executable mid if B0 itself passed.
    COALESCE(p.p_b0, p.up_mid)                          AS market_p,
    -- Consensus over the non-market models only.
    ( (COALESCE(p.p_b1, 0) + COALESCE(p.p_b2, 0) + COALESCE(p.p_b3, 0))
      / NULLIF( (CASE WHEN p.p_b1 IS NULL THEN 0 ELSE 1 END)
              + (CASE WHEN p.p_b2 IS NULL THEN 0 ELSE 1 END)
              + (CASE WHEN p.p_b3 IS NULL THEN 0 ELSE 1 END), 0)
    )                                                   AS consensus_p,
    CASE WHEN p.up_ask IS NOT NULL AND p.up_bid IS NOT NULL
         THEN (p.up_ask - p.up_bid) / 2.0 END           AS half_spread
  FROM pivot p
),
thresh AS (
  SELECT
    c.*,
    c.consensus_p - c.market_p                          AS divergence,
    -- exact_fee: ceil-to-cent of 0.07 * p * (1-p) for one contract. For a
    -- $1-notional binary, dollars ARE probability points.
    CASE WHEN c.market_p IS NOT NULL
         THEN ceil(0.07 * c.market_p * (1 - c.market_p) * 100.0) / 100.0
    END                                                 AS exact_fee
  FROM calc c
),
called AS (
  SELECT
    t.*,
    (t.exact_fee + COALESCE(t.half_spread, 0) + 0.01)   AS actionable_threshold,
    CASE
      -- No usable model output at all -> THIN.
      WHEN t.consensus_p IS NULL OR t.market_p IS NULL THEN 'THIN'
      -- Genuine agreement with the market.
      WHEN abs(t.divergence) <= 0.01 THEN 'FAIR'
      -- Actionable mispricing.
      WHEN t.divergence >=  (t.exact_fee + COALESCE(t.half_spread, 0) + 0.01) THEN 'YES'
      WHEN t.divergence <= -(t.exact_fee + COALESCE(t.half_spread, 0) + 0.01) THEN 'NO'
      -- Real disagreement, but not enough to clear costs.
      ELSE 'THIN'
    END                                                 AS call
  FROM thresh t
)
SELECT
  c.window_id,
  c.seal_point,
  c.sealed_at,
  c.close_ts,
  c.strike,
  c.replica_index,
  c.p_b0,
  c.p_b1,
  c.p_b2,
  c.p_b3,
  c.models_sealed,
  round(c.market_p, 4)             AS market_p,
  round(c.consensus_p, 4)          AS consensus_p,
  round(c.divergence, 4)           AS divergence,
  round(c.half_spread, 4)          AS half_spread,
  round(c.exact_fee, 4)            AS exact_fee,
  round(c.actionable_threshold, 4) AS actionable_threshold,
  c.call,
  g.outcome,
  -- Was the call right?
  --   YES  -> settled yes
  --   NO   -> settled no
  --   FAIR -> did it settle with the MARKET'S favourite? This is the probe of
  --           the market's own calibration, not of our models.
  --   THIN -> no call was made, so correctness is undefined (NULL).
  CASE
    WHEN g.outcome IS NULL THEN NULL
    WHEN c.call = 'YES'  THEN (g.outcome = 'yes')
    WHEN c.call = 'NO'   THEN (g.outcome = 'no')
    WHEN c.call = 'FAIR' THEN (
      (c.market_p > 0.5 AND g.outcome = 'yes') OR
      (c.market_p < 0.5 AND g.outcome = 'no')
    )
    ELSE NULL
  END                              AS call_correct,
  'SHADOW'::text                   AS mode
FROM called c
LEFT JOIN LATERAL (
  SELECT sg.outcome
  FROM founder_alpha.fa_settlement_grade sg
  WHERE sg.window_id = c.window_id
  LIMIT 1
) g ON true
ORDER BY c.close_ts DESC, c.seal_point;

COMMENT ON VIEW founder_alpha.v_fa_window_calls IS
  'Founder verdict feed. Four states: YES/NO (actionable mispricing), FAIR (market agrees within 1pp), THIN (no models or sub-threshold). LABELED SHADOW until Day-14. Consensus excludes B0 because B0 is the market.';

-- =====================================================================
-- v_fa_call_scoreboard — cumulative counts + graded accuracy per state
-- (founder addendum: make FAIR first-class and measurable)
-- =====================================================================
CREATE OR REPLACE VIEW founder_alpha.v_fa_call_scoreboard AS
SELECT
  seal_point,
  call,
  count(*)                                              AS n_total,
  count(*) FILTER (WHERE outcome IS NOT NULL)           AS n_graded,
  count(*) FILTER (WHERE call_correct)                  AS n_correct,
  round(
    (count(*) FILTER (WHERE call_correct)::numeric
     / NULLIF(count(*) FILTER (WHERE call_correct IS NOT NULL), 0)), 4
  )                                                     AS accuracy,
  round(avg(abs(divergence)) FILTER (WHERE divergence IS NOT NULL), 4) AS mean_abs_divergence,
  round(avg(actionable_threshold), 4)                   AS mean_threshold,
  CASE call
    WHEN 'FAIR' THEN 'accuracy here = how often a FAIR window settled with the market''s favourite; it validates the MARKET''s calibration, not ours'
    WHEN 'THIN' THEN 'no call made; correctness undefined by design'
    ELSE 'accuracy here = how often our actionable call was right'
  END                                                   AS interpretation
FROM founder_alpha.v_fa_window_calls
GROUP BY seal_point, call
ORDER BY seal_point, call;

COMMENT ON VIEW founder_alpha.v_fa_call_scoreboard IS
  'Cumulative count and graded accuracy per call state (YES/NO/FAIR/THIN) per seal point. FAIR accuracy probes the market''s own calibration.';

COMMIT;

-- =====================================================================
-- POST-APPLY VERIFICATION
-- =====================================================================
-- SELECT has_table_privilege('service_role','founder_alpha.fa_forecast_grade','INSERT'); -- t
-- SELECT has_table_privilege('service_role','founder_alpha.fa_forecast_grade','UPDATE'); -- f
-- SELECT has_table_privilege('anon','founder_alpha.fa_forecast_grade','SELECT');         -- f
-- UPDATE founder_alpha.fa_forecast_grade SET brier = 0;   -- MUST raise 42501
-- SELECT * FROM founder_alpha.v_fa_window_calls LIMIT 5;
-- SELECT * FROM founder_alpha.v_fa_call_scoreboard;
-- SELECT * FROM founder_alpha.v_fa_model_scoreboard;
