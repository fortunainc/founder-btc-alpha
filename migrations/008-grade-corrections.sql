-- =====================================================================
-- Founder BTC Alpha — 008: v2 grade corrections (append-only) + canonical view
-- =====================================================================
-- WHY: the 2026-07-26 three-approach validation audit reproduced all 240 v2
-- grades from their stored decisions and found EXACTLY ONE pricing defect:
-- grade id=57 (KXBTC15M-26JUL242245-45, v2.1 TAKE_NO, won) was priced at
-- entry 0.72 while the STORED sealed down_ask is 0.65 → net_pnl recorded
-- 0.26, true value 0.33. Root cause: a transient write-retry resealed the
-- window in memory with a fresher book; the DB kept the first (canonical)
-- seal but grading priced from the in-memory object. The scheduler now grades
-- from the STORED decision row (see scheduler.js readDecision), preventing
-- recurrence. POLICY (mirrors 007): the original grade row is PRESERVED
-- untouched; a correction row is APPENDED; canonical reads go through
-- v_fa_v2_grades_canonical which overlays the latest correction.
-- =====================================================================
BEGIN;

CREATE TABLE IF NOT EXISTS founder_alpha.fa_v2_grade_corrections (
  id               bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  grade_id         bigint      NOT NULL REFERENCES founder_alpha.fa_v2_grades(id),
  reason           text        NOT NULL,
  corrected_fields jsonb       NOT NULL,   -- e.g. {"entry_price":0.65,"fee":0.02,"net_pnl":0.33}
  evidence         jsonb       NOT NULL,   -- audit trail: stored ask, prior values, method
  corrected_by     text        NOT NULL,
  corrected_at     timestamptz NOT NULL DEFAULT now(),
  UNIQUE (grade_id)                        -- one canonical correction per grade
);

DROP TRIGGER IF EXISTS fa_v2_grade_corrections_append_only ON founder_alpha.fa_v2_grade_corrections;
CREATE TRIGGER fa_v2_grade_corrections_append_only
  BEFORE UPDATE OR DELETE ON founder_alpha.fa_v2_grade_corrections
  FOR EACH STATEMENT EXECUTE FUNCTION founder_alpha.fa_reject_mutation();

ALTER TABLE founder_alpha.fa_v2_grade_corrections ENABLE ROW LEVEL SECURITY;
GRANT SELECT, INSERT ON founder_alpha.fa_v2_grade_corrections TO service_role;

-- Canonical read surface: grades with corrections overlaid. Consumers (dashboard,
-- scoreboards) read THIS, never the base table directly, when money is displayed.
CREATE OR REPLACE VIEW founder_alpha.v_fa_v2_grades_canonical AS
SELECT
  g.id, g.decision_id, g.window_id, g.engine_id, g.recommendation,
  g.settled_outcome, g.settlement_value, g.graded_at, g.call_correct,
  COALESCE((c.corrected_fields->>'entry_price')::numeric, g.entry_price) AS entry_price,
  COALESCE((c.corrected_fields->>'fee')::numeric,         g.fee)         AS fee,
  COALESCE((c.corrected_fields->>'net_pnl')::numeric,     g.net_pnl)     AS net_pnl,
  (c.id IS NOT NULL)                                                     AS corrected,
  c.reason                                                               AS correction_reason
FROM founder_alpha.fa_v2_grades g
LEFT JOIN founder_alpha.fa_v2_grade_corrections c ON c.grade_id = g.id;

-- The one correction found by the audit (grade 57).
INSERT INTO founder_alpha.fa_v2_grade_corrections (grade_id, reason, corrected_fields, evidence, corrected_by)
SELECT 57, 'entry_price_not_sealed_ask',
  jsonb_build_object('entry_price', 0.65, 'fee', 0.02, 'net_pnl', 0.33),
  jsonb_build_object(
    'stored_down_ask', 0.65, 'graded_entry_price', 0.72,
    'recommendation', 'TAKE_NO', 'settled_outcome', 'no', 'won', true,
    'recompute', 'net = 1 - 0.65 - ceil(0.07*0.65*0.35*100)/100 = 1 - 0.65 - 0.02 = 0.33',
    'root_cause', 'write-retry resealed in memory with fresher book; grade priced from memory not stored row',
    'audit', '2026-07-26 three-approach validation (240/240 grades reproduced; this was the single mismatch)'),
  'claude-cto-2026-07-26-validation-audit'
WHERE NOT EXISTS (SELECT 1 FROM founder_alpha.fa_v2_grade_corrections WHERE grade_id = 57);

COMMIT;
