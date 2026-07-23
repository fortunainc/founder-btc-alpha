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
