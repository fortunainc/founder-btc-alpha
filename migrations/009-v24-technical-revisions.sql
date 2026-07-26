-- ============================================================================
-- 009 — v2.4 FOUNDER TECHNICAL engine: immutable recommendation revisions
-- (technical-analysis execution lock, 2026-07-26). APPEND-ONLY: no UPDATE grant,
-- unique (window_id, revision_seq) makes re-writes idempotent no-ops.
-- The OFFICIAL call (pre-registered: first actionable YES/NO at executable entry)
-- is a normal fa_v2_decisions row (engine_id btc-alpha-v24-technical) so the
-- existing grade path settles it; THIS table is the full revision timeline.
-- ============================================================================
create table if not exists founder_alpha.fa_v24_revisions (
  id              bigserial primary key,
  window_id       text not null,
  revision_seq    integer not null,
  engine_id       text not null default 'btc-alpha-v24-technical',
  spec_version    text not null default 'v2.4.0-shadow',
  experiment_key  text,
  window_open_ts  timestamptz,
  window_close_ts timestamptz,
  evaluated_at    timestamptz not null,
  tau_sec         integer,
  spot            numeric,
  strike          numeric,
  distance_usd    numeric,
  up_ask numeric, up_bid numeric, down_ask numeric, down_bid numeric,
  recommendation  text not null check (recommendation in ('YES','NO','WAIT','NO_TRADE')),
  conviction      numeric,
  vote            numeric,
  p_above         numeric,
  entry_limit     numeric,
  side_ev_usd     numeric,
  reason          text,
  waiting_for     text,
  controlling_evidence text,
  strongest_bullish jsonb,
  strongest_bearish jsonb,
  invalidation    text,
  change_reason   text,
  features        jsonb,
  data_status     jsonb,
  missed_refreshes integer default 0,
  created_at      timestamptz not null default now(),
  unique (window_id, revision_seq)
);
create index if not exists idx_v24_rev_window on founder_alpha.fa_v24_revisions (window_id, revision_seq);
create index if not exists idx_v24_rev_eval on founder_alpha.fa_v24_revisions (evaluated_at desc);
grant insert, select on founder_alpha.fa_v24_revisions to service_role;
grant usage, select on sequence founder_alpha.fa_v24_revisions_id_seq to service_role;
comment on table founder_alpha.fa_v24_revisions is 'v2.4 founder technical engine: immutable per-refresh recommendation revisions (YES/NO/WAIT/NO_TRADE). Official call = fa_v2_decisions engine_id btc-alpha-v24-technical. Append-only.';
