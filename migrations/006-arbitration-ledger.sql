-- =====================================================================
-- Founder BTC Alpha — 006: V2.1 Arbitration Ledger columns
-- =====================================================================
-- Additive, append-only-safe: ALTER ADD COLUMN only (no data mutation).
-- Records the arbiter's reasoning on every decision so the arbitration layer
-- can later evolve from rule-based to evidence-backed (docs/BTC-ALPHA-V2.1-
-- LEARNING-ARBITER.md). Table-level INSERT already granted to service_role
-- covers these new columns.
-- =====================================================================
BEGIN;

ALTER TABLE founder_alpha.fa_v2_decisions
  ADD COLUMN IF NOT EXISTS regime              text,
  ADD COLUMN IF NOT EXISTS reachability_bucket text,
  ADD COLUMN IF NOT EXISTS conflict_signature  text,
  ADD COLUMN IF NOT EXISTS conviction          double precision,
  ADD COLUMN IF NOT EXISTS agreement           double precision,
  ADD COLUMN IF NOT EXISTS matrix_version      text;

CREATE INDEX IF NOT EXISTS fa_v2_dec_signature_idx ON founder_alpha.fa_v2_decisions (conflict_signature);
CREATE INDEX IF NOT EXISTS fa_v2_dec_regime_idx    ON founder_alpha.fa_v2_decisions (regime, reachability_bucket);

COMMENT ON COLUMN founder_alpha.fa_v2_decisions.conflict_signature IS
  'Canonical key of the evidence conflict. Group settled outcomes by this to learn which evidence should dominate. arb-matrix-v1.';

COMMIT;
