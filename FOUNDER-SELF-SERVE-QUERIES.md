# Founder self-serve — check anything without asking the CTO (zero credits)
Open the Supabase SQL editor, paste, hit Run (Cmd+Enter). All read-only.
Bookmark: https://supabase.com/dashboard/project/hahgdljmkbbykneclinf/sql/new

## BTC Alpha — live yes/no/fair calls (Pacific time)
select to_char(close_ts at time zone 'America/Los_Angeles','MM/DD HH12:MI AM') window_pt,
       call, round(consensus_p*100) models_pct, round(market_p*100) market_pct, call_correct, outcome
from founder_alpha.v_fa_window_calls order by close_ts desc limit 40;

## BTC Alpha — running scoreboard per call type
select seal_point, call, n_total, n_graded, n_correct, accuracy, interpretation
from founder_alpha.v_fa_call_scoreboard order by seal_point, call;

## BTC Alpha — is capture alive? (rows in last 5 min > 0 means yes)
select count(*) rows_last_5min,
  to_char(max(ts) at time zone 'America/Los_Angeles','MM/DD HH24:MI:SS') latest_pt
from founder_alpha.fa_window_capture where ts > now() - interval '5 minutes';

## TSM clocks — authoritative status
select engine, status, authoritative_start, clock_day, expected_completion from public.v_clock_dashboard order by engine;
