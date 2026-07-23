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

## 2026-07-23 ~16:55 UTC — Phase-1 RVR CTO FALSIFICATION: PASSED
Independent checks against live DB (not the RVR's own fixtures):
- 35 seals present; model set exactly {b0,b1,b2,b3}@{T-10,T-5,T-2}; every sealed_at < window_close_ts (schema CHECK + spot query).
- Recomputed divergence + call labels for the 3 called windows from raw sealed_p vs executable up_mid: matches the verdict feed (NO/-10.7pp, NO/-4.9pp, NO/-6.6pp; threshold fee+half-spread+1pp honored).
- Graded outcomes cross-checked vs settlement rows: 2/2 RIGHT as claimed. Spec provenance (formulas read from fa_ontology_versions) verified by diffing docstrings vs frozen rows.
Remaining Phase-1 item: RAILWAY DEPLOY — capture+sealing currently dies with the founder's laptop. This is now the single point of failure for the Day-14 sample. Print the checklist and finish it.

## 2026-07-23 ~22:05 UTC — terminal agent, per CTO-RESTART-NOW.md
1. **Local worker RESTARTED live**, single instance, sink=supabase. Confirmed 6 rows in
   fa_window_capture within 60s of start (ts > 2026-07-23T22:00:41Z, up+down=1.000, 4 venues).
   Now pid 46838 (restarted once more to pick up the preflight below).
2. **Railway diagnosis — could NOT read deploy logs** (Railway CLI unauthenticated on the laptop,
   no linked project; no dashboard access from the terminal). Diagnosed by evidence instead:
   ZERO rows in fa_window_capture during the entire local-down window (17:25–22:00Z) => Railway
   is not writing (not deployed, crashed, or dry-run). Reproduced the 3 likely causes locally:
   a mangled multi-line PEM crashes with a cryptic `error:1E08010C:DECODER routines::unsupported`;
   dry-run-left-on writes to disk silently; /rest/v1 URL suffix doubles the path.
3. **Shipped two things to make the founder's next deploy self-diagnosing:**
   - `src/preflight.js` — boot-time config check that NAMES the fault (e.g. "PEM newlines lost on
     paste") and exits non-zero on a fatal, instead of dying with the raw OpenSSL error. Runs
     BEFORE the client is constructed. 10 new tests; 94/94 total pass.
   - `docs/RAILWAY-FIX.md` — phone-friendly decision tree keyed to the preflight output, with the
     exact fix per failure mode.
4. **Double-write avoided:** only the local worker is writing. RAILWAY-FIX.md step 3 tells the
   founder to `pkill -f 'node src/worker.js'` once Railway shows `flushed … (supabase)`.
5. **Also found + fixed during the prior stop:** a real transient Supabase outage at 16:21Z had
   spilled 3 capture rows to disk (the OOM-guard working). Verified missing from DB, backfilled
   exactly those 3, marked the spill file .backfilled. Zero rows lost. See fixtures/21.

STILL BLOCKED for the founder: Railway project connect + env paste (needs browser login I can't
do); migration 003 (grading); repo still PUBLIC.
