-- =====================================================================
-- Founder BTC Alpha — 007: settlement-observation exception ledger
-- =====================================================================
-- Append-only quarantine for CORRUPTED settlement observations. A corrupted
-- reading (e.g. Kalshi expiration_value read as 0.00 on a failed settlement
-- fetch) produces a spurious replica_error. Policy: PRESERVE the original row
-- untouched (fa_settlement_grade is append-only), record an explicit exception,
-- and EXCLUDE it from tracking stats VISIBLY (never silently, never deleted).
--
-- First quarantine: id=234 (window KXBTC15M-26JUL241915-15), settlement_value
-- 0.00 vs a valid replica ~$64,104. Applied to prod 2026-07-25 via SQL editor.
-- =====================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS founder_alpha.fa_settlement_exceptions (
  id                   bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  settlement_grade_id  bigint NOT NULL REFERENCES founder_alpha.fa_settlement_grade(id),
  window_id            text   NOT NULL,
  reason               text   NOT NULL,
  detail               jsonb  NOT NULL,   -- preserved snapshot of the corrupted observation
  bound_usd            numeric,
  quarantined_by       text   NOT NULL,
  quarantined_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (settlement_grade_id)
);

DROP TRIGGER IF EXISTS fa_settlement_exceptions_append_only ON founder_alpha.fa_settlement_exceptions;
CREATE TRIGGER fa_settlement_exceptions_append_only
  BEFORE UPDATE OR DELETE ON founder_alpha.fa_settlement_exceptions
  FOR EACH STATEMENT EXECUTE FUNCTION founder_alpha.fa_reject_mutation();

ALTER TABLE founder_alpha.fa_settlement_exceptions ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON founder_alpha.fa_settlement_exceptions TO service_role;

-- Quarantine record for the known corrupted observation.
INSERT INTO founder_alpha.fa_settlement_exceptions
  (settlement_grade_id, window_id, reason, detail, bound_usd, quarantined_by)
SELECT id, window_id, 'settlement_value_corrupt_zero',
  jsonb_build_object(
    'settlement_value', settlement_value,
    'reference_strike', reference_strike,
    'replica_predicted_settlement', replica_predicted_settlement,
    'replica_error', replica_error,
    'replica_error_bps', replica_error_bps,
    'note', 'Kalshi expiration_value read as 0.00 (failed settlement read). Replica (~$64,104) was valid; replica_error spurious. Original row preserved untouched.'
  ),
  1000, 'cto-audit-2026-07-25'
FROM founder_alpha.fa_settlement_grade
WHERE id = 234
ON CONFLICT (settlement_grade_id) DO NOTHING;

-- Clean tracking view: excludes quarantined rows EXPLICITLY, surfaces the count.
CREATE OR REPLACE VIEW founder_alpha.v_fa_replica_tracking AS
SELECT
  count(*)::int AS windows_total,
  count(*) FILTER (WHERE e.settlement_grade_id IS NOT NULL)::int AS windows_quarantined,
  count(*) FILTER (WHERE e.settlement_grade_id IS NULL AND g.replica_error IS NOT NULL)::int AS windows_scored,
  round((percentile_cont(0.5) WITHIN GROUP (ORDER BY abs(g.replica_error))
         FILTER (WHERE e.settlement_grade_id IS NULL))::numeric,2) AS median_abs_err_usd,
  round(avg(abs(g.replica_error)) FILTER (WHERE e.settlement_grade_id IS NULL)::numeric,2) AS mean_abs_err_usd,
  round(max(abs(g.replica_error)) FILTER (WHERE e.settlement_grade_id IS NULL)::numeric,2) AS max_abs_err_usd,
  round(avg(abs(g.replica_error_bps)) FILTER (WHERE e.settlement_grade_id IS NULL)::numeric,3) AS mean_abs_err_bps,
  count(*) FILTER (WHERE g.replica_outcome_agrees IS TRUE  AND e.settlement_grade_id IS NULL)::int AS outcome_agree,
  count(*) FILTER (WHERE g.replica_outcome_agrees IS NOT NULL AND e.settlement_grade_id IS NULL)::int AS outcome_denom
FROM founder_alpha.fa_settlement_grade g
LEFT JOIN founder_alpha.fa_settlement_exceptions e ON e.settlement_grade_id = g.id;
GRANT SELECT ON founder_alpha.v_fa_replica_tracking TO service_role;

COMMIT;
