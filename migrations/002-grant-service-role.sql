-- =====================================================================
-- Founder BTC Alpha — 002: grant the capture worker's role access
-- =====================================================================
-- WRITE-ONLY ARTEFACT: applied by the CTO via the Supabase SQL editor.
--
-- WHY THIS EXISTS
-- ---------------
-- Migration 001 revoked everything from `anon` and `authenticated` (correct)
-- but never GRANTed anything to `service_role`. In Postgres a role needs
-- USAGE on a schema and privileges on its tables regardless of whether it
-- bypasses RLS -- BYPASSRLS and object privileges are independent mechanisms.
-- Supabase's default grants cover `public`, not a newly created schema, so
-- the worker got:
--
--     42501  permission denied for schema founder_alpha
--
-- This was missed because 001's verification suite ran as the `postgres`
-- superuser, which bypasses privilege checks entirely and therefore could
-- never have detected a missing grant. The verification for THIS migration
-- runs as an actual non-superuser `service_role` (see scripts/verify-grants.sql).
--
-- ISOLATION IS PRESERVED: `anon` and `authenticated` remain fully revoked.
-- This grants the service role only, which is the credential the worker uses.
-- =====================================================================

BEGIN;

-- Schema visibility for the worker's role.
GRANT USAGE ON SCHEMA founder_alpha TO service_role;

-- Append-only by trigger, so SELECT + INSERT is the full useful set.
-- UPDATE/DELETE are deliberately NOT granted: defence in depth behind the
-- fa_reject_mutation() trigger, so append-only holds even if a trigger is
-- ever accidentally dropped.
GRANT SELECT, INSERT ON ALL TABLES IN SCHEMA founder_alpha TO service_role;

-- Identity columns need sequence access for INSERT to work.
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA founder_alpha TO service_role;

-- Future tables/sequences in this schema inherit the same posture, so a later
-- migration cannot silently create an unreachable table.
ALTER DEFAULT PRIVILEGES IN SCHEMA founder_alpha
  GRANT SELECT, INSERT ON TABLES TO service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA founder_alpha
  GRANT USAGE, SELECT ON SEQUENCES TO service_role;

-- Re-assert the lockout, in case any default privilege leaked to the public
-- API roles when the schema was added to the Data API exposed list.
REVOKE ALL ON SCHEMA founder_alpha              FROM anon, authenticated;
REVOKE ALL ON ALL TABLES    IN SCHEMA founder_alpha FROM anon, authenticated;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA founder_alpha FROM anon, authenticated;

COMMIT;

-- =====================================================================
-- POST-APPLY VERIFICATION (expect exactly this)
-- =====================================================================
-- SELECT has_schema_privilege('service_role','founder_alpha','USAGE');   -- t
-- SELECT has_table_privilege('service_role','founder_alpha.fa_window_capture','INSERT'); -- t
-- SELECT has_table_privilege('service_role','founder_alpha.fa_window_capture','UPDATE'); -- f
-- SELECT has_schema_privilege('anon','founder_alpha','USAGE');           -- f
-- SELECT has_schema_privilege('authenticated','founder_alpha','USAGE');  -- f
