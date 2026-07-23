# CTO notes — Phase 0

## 2026-07-23 ~03:50 UTC — Supabase migration APPLIED + VERIFIED (CTO)
`migrations/001-founder-alpha-v1.sql` applied to the production Supabase project via SQL editor.
Verification (runtime, CTO-executed):
- tables_total=5, tables_rls_forced=5, append_triggers=5, views=2
- ontology_seed_rows=2 (fee-model v1, replica-methodology v1)
- forecast_seal_rows=0 (Phase 0 invariant holds)
- anon/authenticated grants=0
- UPDATE on fa_ontology_versions → rejected, ERRCODE 42501, append-only message. VERIFIED.

## Unblocked for you (terminal)
- Switch the worker from dry-run JSONL to live Supabase writes once `SUPABASE_URL` and
  `SUPABASE_SERVICE_ROLE_KEY` appear in `.env` (founder pastes them; never print them).
- Then: ≥3 days continuous capture toward checklist items 6–7 (replica error, uptime) using
  `founder_alpha.v_fa_replica_error` and `v_fa_capture_health`.
- Finish `docs/RVR-phase0-build.md` (12 sections) when capture is live; CTO falsifies after.

## 2026-07-23 ~05:20 UTC — CTO ruling on your 7fbfb10 findings
1. **The credentials are CORRECT.** founder_alpha lives IN the TSM Production Supabase project BY DESIGN —
   approved architecture (proposal §6): same project for cost, isolation at the SCHEMA level (separate schema,
   RLS forced, zero grants to anon/authenticated, append-only). Dispatch hard rule 1 means: no references to
   public.tsm_* objects and no TSM code imports — which you satisfied (isolation census CLEAN). It does NOT
   mean a separate Supabase project. Your skepticism was correct procedure; the premise was wrong.
2. **PGRST106 root cause found and FIXED (verified this time):** founder_alpha was not in the Data API
   exposed schemas. Now: db_schema = public,graphql_public,founder_alpha (Management API PATCH, 200).
   Runtime proof: anon probe now returns 42501 permission-denied (schema visible, public roles locked out) —
   exactly the designed posture. The service role will pass.
3. **Action for you (next time you run):** retry live writes — replay any spilled batches from disk, confirm
   fa_window_capture row count > 0, flip the sink RVR item to VERIFIED with the count as proof.
4. **Service-role key rotation:** flag accepted; it will be a CONTROLLED rotation coordinated with the founder
   (the key powers TSM prod Vercel env + crons — rotating it mid-night unattended would take down production
   grading). On the morning board.
