-- Post-apply verification for 001-founder-alpha-v1.sql.
-- Run against a throwaway cluster. Every check prints PASS or FAIL.

\set ON_ERROR_STOP off
\pset pager off

\echo '=== 1. All five tables exist with RLS enabled AND forced ==='
SELECT
  c.relname                                        AS table_name,
  c.relrowsecurity                                 AS rls_enabled,
  c.relforcerowsecurity                            AS rls_forced,
  CASE WHEN c.relrowsecurity AND c.relforcerowsecurity THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM pg_class c
JOIN pg_namespace n ON n.oid = c.relnamespace
WHERE n.nspname = 'founder_alpha' AND c.relkind = 'r'
ORDER BY c.relname;

\echo ''
\echo '=== 2. Zero permissive policies => default deny ==='
SELECT
  count(*) AS policy_count,
  CASE WHEN count(*) = 0 THEN 'PASS (default-deny)' ELSE 'FAIL (a policy grants access)' END AS verdict
FROM pg_policies WHERE schemaname = 'founder_alpha';

\echo ''
\echo '=== 3. Seed rows present ==='
SELECT kind, version, jsonb_typeof(spec) AS spec_type FROM founder_alpha.fa_ontology_versions ORDER BY kind;
SELECT CASE WHEN count(*) = 2 THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM founder_alpha.fa_ontology_versions;

\echo ''
\echo '=== 4. fa_forecast_seal MUST be empty in Phase 0 ==='
SELECT count(*) AS rows,
       CASE WHEN count(*) = 0 THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM founder_alpha.fa_forecast_seal;

\echo ''
\echo '=== 5. INSERT works (append-only allows inserts) ==='
INSERT INTO founder_alpha.fa_window_capture
  (window_id, ts, up_bid, up_ask, up_mid, down_bid, down_ask, down_mid,
   replica_index, replica_60s_avg, reference_strike,
   rv_5m, session_bucket, macro_flag, capture_phase, quality_flags)
VALUES
  ('W1', now() - interval '600 seconds', 0.50, 0.51, 0.505, 0.49, 0.50, 0.495,
   65000, 65010, 64990, 0.00003, 'us_rth', false, 'normal', '{}'::jsonb),
  ('W1', now() - interval '540 seconds', 0.52, 0.53, 0.525, 0.47, 0.48, 0.475,
   65020, 65015, 64990, 0.00004, 'us_rth', false, 'normal', '{"capture_gap":60}'::jsonb),
  ('W1', now() - interval '60 seconds',  0.60, 0.61, 0.605, 0.39, 0.40, 0.395,
   65100, 65080, 64990, 0.00005, 'us_rth', false, 'final120', '{"sum_out_of_band":1.02}'::jsonb),
  ('W2', now() - interval '300 seconds', 0.30, 0.31, 0.305, 0.69, 0.70, 0.695,
   64800, 64820, 64900, 0.00009, 'asia',   true,  'normal', '{}'::jsonb);
\echo 'INSERT -> PASS (see counts above)'

\echo ''
\echo '=== 6. UPDATE must be REJECTED by the append-only trigger ==='
UPDATE founder_alpha.fa_window_capture SET up_bid = 0.99 WHERE window_id = 'W1';
\echo '^^ expected: ERROR 42501 append-only. If you see UPDATE n, that is a FAIL.'

\echo ''
\echo '=== 7. DELETE must be REJECTED by the append-only trigger ==='
DELETE FROM founder_alpha.fa_window_capture WHERE window_id = 'W1';
\echo '^^ expected: ERROR 42501 append-only. If you see DELETE n, that is a FAIL.'

\echo ''
\echo '=== 8. Rows survived the rejected mutations ==='
SELECT count(*) AS surviving_rows,
       CASE WHEN count(*) = 4 THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM founder_alpha.fa_window_capture;

\echo ''
\echo '=== 9. CHECK constraints reject out-of-range prices ==='
INSERT INTO founder_alpha.fa_window_capture (window_id, ts, up_bid, session_bucket)
VALUES ('BAD', now(), 1.5, 'us_rth');
\echo '^^ expected: ERROR check constraint. If INSERT 0 1, that is a FAIL.'

\echo ''
\echo '=== 10. CHECK constraint rejects a bad session bucket ==='
INSERT INTO founder_alpha.fa_window_capture (window_id, ts, session_bucket)
VALUES ('BAD2', now(), 'lunar');
\echo '^^ expected: ERROR check constraint. If INSERT 0 1, that is a FAIL.'

\echo ''
\echo '=== 11. fa_forecast_seal seal-before-close CHECK ==='
INSERT INTO founder_alpha.fa_forecast_seal
  (model_id, model_version, window_id, sealed_p, sealed_at, window_close_ts)
VALUES ('m', 'v1', 'W1', 0.5, now(), now() - interval '1 minute');
\echo '^^ expected: ERROR check constraint (sealed AFTER close). If INSERT 0 1, that is a FAIL.'

\echo ''
\echo '=== 12. Settlement grade rows for the views ==='
INSERT INTO founder_alpha.fa_settlement_grade
  (window_id, window_close_ts, settlement_value, reference_strike, outcome,
   replica_predicted_settlement, replica_error, replica_error_bps,
   replica_predicted_outcome, replica_outcome_agrees, session_bucket,
   macro_flag, rv_5m_at_close)
VALUES
  ('W1', now(), 65100.00, 64990.00, 'yes', 65095.00,  5.00,  0.77, 'yes', true,  'us_rth', false, 0.00003),
  ('W2', now(), 64800.00, 64900.00, 'no',  64815.00, -15.00, -2.31, 'no',  true,  'asia',   true,  0.00009),
  ('W3', now(), 65000.00, 65000.00, 'yes', 64960.00,  40.00,  6.15, 'no',  false, 'eu',     false, 0.00006);

\echo ''
\echo '=== 13. v_fa_replica_error runs and buckets by session + vol tercile ==='
SELECT window_id, session_bucket, vol_tercile, replica_error, abs_replica_error_bps, replica_outcome_agrees
FROM founder_alpha.v_fa_replica_error ORDER BY window_id;

\echo ''
\echo '=== 14. v_fa_capture_health runs and censuses gaps + invariants ==='
SELECT day, snapshots, windows_seen, final120_snapshots, gaps_over_30s,
       rows_with_any_flag, invariant_sum_violations, invariant_gap_violations,
       uptime_pct_of_expected
FROM founder_alpha.v_fa_capture_health;

\echo ''
\echo '=== 15. Append-only also enforced on the other four tables ==='
UPDATE founder_alpha.fa_ontology_versions SET version = 'hacked';
\echo '^^ expected: ERROR 42501 append-only.'
DELETE FROM founder_alpha.fa_settlement_grade;
\echo '^^ expected: ERROR 42501 append-only.'
