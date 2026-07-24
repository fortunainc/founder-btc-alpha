-- =====================================================================
-- Founder BTC Alpha — 004: paper P&L (read-only, derived)
-- ---------------------------------------------------------------------
-- PRESENTATION/REPORTING ONLY. This view derives a paper profit-and-loss
-- from data that is ALREADY sealed and ALREADY graded. It changes NO model,
-- threshold, grading rule, or seal. It is additive and reversible.
--
-- Economics (deliberately conservative, no midpoint fantasy fills):
--   * 1 contract per actionable (YES/NO) call, per seal point.
--   * Entry at the SEALED EXECUTABLE ASK you would have had to cross:
--       YES -> up_ask   (buy the "up" contract)
--       NO  -> down_ask  (buy the "down" contract)
--   * Kalshi fee = ceil(0.07 * P * (1-P)) at that ask (the canonical fee model).
--   * Payoff = $1 if the side won, else $0.
--   * net = payoff - entry_ask - fee.
--   * No multi-level slippage is modeled (top-of-book ask only). This is a
--     LOWER-realism floor on cost, never a rosier midpoint.
-- =====================================================================
BEGIN;

CREATE OR REPLACE VIEW founder_alpha.v_fa_paper_pnl AS
WITH asks AS (
  SELECT
    s.window_id,
    founder_alpha.fa_seal_point(s.model_version)        AS seal_point,
    max((s.executable_prices ->> 'up_ask')::numeric)    AS up_ask,
    max((s.executable_prices ->> 'down_ask')::numeric)  AS down_ask
  FROM founder_alpha.fa_forecast_seal s
  GROUP BY s.window_id, founder_alpha.fa_seal_point(s.model_version)
),
trades AS (
  SELECT
    c.window_id,
    c.seal_point,
    c.call,
    c.outcome,
    c.call_correct,
    CASE c.call WHEN 'YES' THEN a.up_ask WHEN 'NO' THEN a.down_ask END AS entry_price
  FROM founder_alpha.v_fa_window_calls c
  JOIN asks a
    ON a.window_id = c.window_id AND a.seal_point = c.seal_point
  WHERE c.call IN ('YES','NO')
    AND c.outcome IS NOT NULL
),
priced AS (
  SELECT
    t.*,
    CASE WHEN (t.call = 'YES' AND t.outcome = 'yes')
           OR (t.call = 'NO'  AND t.outcome = 'no')
         THEN 1.0 ELSE 0.0 END                                     AS payoff,
    ceil(0.07 * t.entry_price * (1 - t.entry_price) * 100.0) / 100.0 AS fee
  FROM trades t
  WHERE t.entry_price IS NOT NULL
    AND t.entry_price > 0
    AND t.entry_price < 1
)
SELECT
  seal_point,
  call,
  count(*)                                             AS n_settled,
  count(*) FILTER (WHERE call_correct)                 AS n_wins,
  round(sum(payoff - entry_price - fee)::numeric, 4)   AS net_pnl,
  round(avg(payoff - entry_price - fee)::numeric, 4)   AS avg_pnl_per_trade,
  round(avg(entry_price)::numeric, 4)                  AS avg_entry_price,
  round(sum(fee)::numeric, 4)                          AS total_fees
FROM priced
GROUP BY seal_point, call
ORDER BY seal_point, call;

COMMENT ON VIEW founder_alpha.v_fa_paper_pnl IS
  'Read-only paper P&L per seal_point x actionable call. 1 contract, entered at the sealed executable ask (up_ask for YES, down_ask for NO), Kalshi fee ceil(0.07*P*(1-P)) at that ask, payoff 1 if the side won else 0. No midpoint fills, no multi-level slippage. Derived only; changes no models/thresholds/grading/seals.';

-- 002 set ALTER DEFAULT PRIVILEGES ... ON TABLES (covers views); explicit for clarity.
GRANT SELECT ON founder_alpha.v_fa_paper_pnl TO service_role;

COMMIT;

-- POST-APPLY VERIFICATION (run in SQL editor):
--   SELECT * FROM founder_alpha.v_fa_paper_pnl;
--   SELECT has_table_privilege('service_role','founder_alpha.v_fa_paper_pnl','SELECT'); -- expect t
