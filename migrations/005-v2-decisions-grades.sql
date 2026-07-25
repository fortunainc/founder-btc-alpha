-- =====================================================================
-- Founder BTC Alpha — 005: V2 scalping engine decisions + grades
-- =====================================================================
-- WRITE-ONLY ARTEFACT: staged for the CTO to apply via the Supabase SQL editor.
-- Follows the 002/003 pattern exactly: append-only trigger + explicit
-- service_role grants (SELECT+INSERT only), RLS forced, no UPDATE/DELETE.
--
-- Adds the storage for BTC Alpha V2 (btc-alpha-v2-scalp, spec v2.0.0):
--   fa_v2_decisions   one IMMUTABLE sealed decision per window (minute-3 seal)
--   fa_v2_grades      one grade per decision, scored against settlement
--   v_fa_v2_scoreboard  per-day call accuracy + paper P&L after Kalshi fees
--
-- Column shapes mirror src/v2/engine.js sealDecision()/gradeDecision() 1:1.
-- ISOLATION: zero references to public.tsm_* objects.
-- =====================================================================

BEGIN;

-- ---------------------------------------------------------------------
-- fa_v2_decisions — the single sealed decision (TAKE YES / TAKE NO / NO TRADE)
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS founder_alpha.fa_v2_decisions (
  id                         bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  window_id                  text        NOT NULL,
  sealed_at                  timestamptz NOT NULL,
  window_close_ts            timestamptz,
  seconds_to_close_at_seal   integer,
  engine_id                  text        NOT NULL,
  spec_version               text        NOT NULL,
  recommendation             text        NOT NULL,
  status                     text        NOT NULL,
  reason                     text        NOT NULL,
  strike                     numeric(18,2),
  replica_index              numeric(18,2),   -- BTC replica S at the seal instant
  market_p                   numeric(8,6),
  up_ask                     numeric(8,6),
  down_ask                   numeric(8,6),
  up_bid                     numeric(8,6),
  down_bid                   numeric(8,6),
  half_spread                numeric(8,6),
  consensus                  double precision,
  families                   jsonb        NOT NULL DEFAULT '{}'::jsonb,
  evidence                   jsonb        NOT NULL DEFAULT '{}'::jsonb,
  is_replay                  boolean      NOT NULL DEFAULT false,
  inserted_at                timestamptz  NOT NULL DEFAULT now(),

  CONSTRAINT fa_v2_dec_reco_ck   CHECK (recommendation IN ('TAKE_YES','TAKE_NO','NO_TRADE')),
  CONSTRAINT fa_v2_dec_status_ck CHECK (status IN ('ok','no_forecast_data')),
  -- One sealed decision per window per stream (live vs replay). Immutable forever.
  CONSTRAINT fa_v2_dec_window_unique UNIQUE (engine_id, window_id, is_replay)
);

CREATE INDEX IF NOT EXISTS fa_v2_dec_window_idx  ON founder_alpha.fa_v2_decisions (window_id);
CREATE INDEX IF NOT EXISTS fa_v2_dec_sealed_idx  ON founder_alpha.fa_v2_decisions (sealed_at);
CREATE INDEX IF NOT EXISTS fa_v2_dec_reco_idx    ON founder_alpha.fa_v2_decisions (recommendation, sealed_at);

COMMENT ON TABLE founder_alpha.fa_v2_decisions IS
  'Append-only sealed decisions for the V2 first-3-minutes scalping engine. One immutable row per window (minute-3 seal); grading writes a SEPARATE row in fa_v2_grades. replica_index is the BTC replica price S at the seal instant.';
COMMENT ON COLUMN founder_alpha.fa_v2_decisions.consensus IS
  'Signed directional consensus in [-1,1] from the active families (Phase A: F3 momentum only). Diagnostic; never surfaced as a probability.';

DROP TRIGGER IF EXISTS fa_v2_decisions_append_only ON founder_alpha.fa_v2_decisions;
CREATE TRIGGER fa_v2_decisions_append_only
  BEFORE UPDATE OR DELETE ON founder_alpha.fa_v2_decisions
  FOR EACH STATEMENT EXECUTE FUNCTION founder_alpha.fa_reject_mutation();

ALTER TABLE founder_alpha.fa_v2_decisions ENABLE ROW LEVEL SECURITY;
ALTER TABLE founder_alpha.fa_v2_decisions FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------
-- fa_v2_grades — one grade per decision, scored against settlement
-- ---------------------------------------------------------------------
CREATE TABLE IF NOT EXISTS founder_alpha.fa_v2_grades (
  id                bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  decision_id       bigint      NOT NULL
                      REFERENCES founder_alpha.fa_v2_decisions(id),
  window_id         text        NOT NULL,
  engine_id         text        NOT NULL,
  recommendation    text        NOT NULL,
  settled_outcome   text        NOT NULL,
  settlement_value  numeric(18,2),
  call_correct      boolean,           -- null for NO_TRADE and void
  entry_price       numeric(8,6),      -- sealed executable ask of the taken side
  fee               numeric(8,6),      -- canonical Kalshi fee at entry
  net_pnl           numeric(10,4),     -- payoff - entry - fee; null if unpriceable/void
  graded_at         timestamptz,
  inserted_at       timestamptz NOT NULL DEFAULT now(),

  CONSTRAINT fa_v2_grade_reco_ck    CHECK (recommendation IN ('TAKE_YES','TAKE_NO','NO_TRADE')),
  CONSTRAINT fa_v2_grade_outcome_ck CHECK (settled_outcome IN ('yes','no','void')),
  -- One grade per sealed decision, forever.
  CONSTRAINT fa_v2_grade_decision_unique UNIQUE (decision_id)
);

CREATE INDEX IF NOT EXISTS fa_v2_grade_window_idx ON founder_alpha.fa_v2_grades (window_id);
CREATE INDEX IF NOT EXISTS fa_v2_grade_graded_idx ON founder_alpha.fa_v2_grades (graded_at);

COMMENT ON TABLE founder_alpha.fa_v2_grades IS
  'Append-only grading of each V2 sealed decision. call_correct measures the yes/no/no-trade call; net_pnl is paper P&L at the SEALED executable ask + Kalshi fee (NO midpoint fills). NO_TRADE => net 0, call_correct null (outcome still recorded for abstention-discipline H4). void or unpriceable ask => net_pnl null, never fabricated.';

DROP TRIGGER IF EXISTS fa_v2_grades_append_only ON founder_alpha.fa_v2_grades;
CREATE TRIGGER fa_v2_grades_append_only
  BEFORE UPDATE OR DELETE ON founder_alpha.fa_v2_grades
  FOR EACH STATEMENT EXECUTE FUNCTION founder_alpha.fa_reject_mutation();

ALTER TABLE founder_alpha.fa_v2_grades ENABLE ROW LEVEL SECURITY;
ALTER TABLE founder_alpha.fa_v2_grades FORCE ROW LEVEL SECURITY;

-- ---------------------------------------------------------------------
-- Grants (002/003 pattern): SELECT+INSERT only; UPDATE/DELETE withheld
-- so append-only survives even if a trigger is ever dropped.
-- ---------------------------------------------------------------------
GRANT SELECT, INSERT ON founder_alpha.fa_v2_decisions TO service_role;
GRANT SELECT, INSERT ON founder_alpha.fa_v2_grades     TO service_role;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA founder_alpha TO service_role;
REVOKE ALL ON founder_alpha.fa_v2_decisions FROM anon, authenticated;
REVOKE ALL ON founder_alpha.fa_v2_grades     FROM anon, authenticated;

-- =====================================================================
-- v_fa_v2_scoreboard — per day: call accuracy (decided calls only) and
-- paper P&L after fees. Accuracy and profitability are kept SEPARATE, and
-- NO_TRADE is reported as its own honest volume, never folded into accuracy.
-- =====================================================================
-- CORRECTNESS FIX (founder BTC accuracy audit 2026-07-25):
--   (1) spec_version exposed + in GROUP BY  -> consumers count ONLY the current frozen
--       version's prospective sample; a version change is a new challenger with a new sample.
--   (2) directional correctness DERIVED from the settled outcome (correct_dir), independent of
--       fill priceability -> an unpriceable-ask actionable call is still graded on DIRECTION
--       (TAKE_NO that settled 'yes' = wrong), never nulled/dropped as before.
--   (3) settled_actionable = decided calls WITH a yes/no settlement = the accuracy denominator
--       (replaces decided_calls, which wrongly counted unsettled/void decided calls).
-- Column order changed, so DROP + CREATE (CREATE OR REPLACE cannot reorder columns).
DROP VIEW IF EXISTS founder_alpha.v_fa_v2_scoreboard;
CREATE VIEW founder_alpha.v_fa_v2_scoreboard AS
WITH joined AS (
  SELECT
    d.engine_id,
    d.spec_version,
    (g.graded_at AT TIME ZONE 'UTC')::date        AS day,
    d.recommendation,
    d.is_replay,
    g.settled_outcome,
    CASE
      WHEN d.recommendation = 'TAKE_YES' AND g.settled_outcome = 'yes' THEN true
      WHEN d.recommendation = 'TAKE_NO'  AND g.settled_outcome = 'no'  THEN true
      WHEN d.recommendation IN ('TAKE_YES','TAKE_NO') AND g.settled_outcome IN ('yes','no') THEN false
      ELSE NULL
    END                                           AS correct_dir,
    g.net_pnl
  FROM founder_alpha.fa_v2_grades g
  JOIN founder_alpha.fa_v2_decisions d ON d.id = g.decision_id
)
SELECT
  engine_id,
  spec_version,
  day,
  is_replay,
  count(*)                                                          AS graded_windows,
  count(*) FILTER (WHERE recommendation <> 'NO_TRADE')              AS decided_calls,
  count(*) FILTER (WHERE recommendation = 'NO_TRADE')               AS no_trades,
  count(*) FILTER (WHERE recommendation <> 'NO_TRADE' AND correct_dir IS NOT NULL) AS settled_actionable,
  count(*) FILTER (WHERE correct_dir IS TRUE)                       AS calls_correct,
  round(
    count(*) FILTER (WHERE correct_dir IS TRUE)::numeric
    / NULLIF(count(*) FILTER (WHERE recommendation <> 'NO_TRADE' AND correct_dir IS NOT NULL), 0), 4
  )                                                                 AS call_accuracy,
  round(sum(net_pnl) FILTER (WHERE net_pnl IS NOT NULL)::numeric, 4) AS net_pnl_total,
  count(*) FILTER (WHERE net_pnl IS NOT NULL AND recommendation <> 'NO_TRADE') AS priced_fills
FROM joined
GROUP BY engine_id, spec_version, day, is_replay;

COMMENT ON VIEW founder_alpha.v_fa_v2_scoreboard IS
  'Per-day V2 read-out. call_accuracy is over graded decided calls only (NO_TRADE excluded); no_trades reported separately as abstention volume. net_pnl_total is paper P&L after Kalshi fees at sealed executable asks, kept distinct from accuracy. Live and replay streams separated by is_replay.';

GRANT SELECT ON founder_alpha.v_fa_v2_scoreboard TO service_role;

COMMIT;
