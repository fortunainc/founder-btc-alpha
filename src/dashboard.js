/**
 * Founder-only read-only dashboard.
 *
 * Serves exactly ONE route: GET /dash?token=<FOUNDER_DASH_TOKEN>. Everything
 * else 404s with no detail. The page is fully self-contained (inline CSS, no
 * external requests), renders Pacific time in a 12-hour clock, and auto-refreshes
 * every 10s via a meta refresh (the token in the URL is preserved on reload).
 *
 * 2026-07-24 — FOUNDER PRESENTATION REWRITE (presentation layer ONLY).
 *   Answers one question first: TAKE YES / TAKE NO / NO TRADE (shadow).
 *   Plain trader language — no "edge"/"divergence"/T-10 jargon on the primary
 *   surface. Honest accuracy (numerator/denominator + sample-quality label).
 *   Call-correctness is separated from paper P&L. Paper P&L uses ONLY executable
 *   ask prices + Kalshi fees (no midpoint fantasy fills). Raw research tables are
 *   preserved, collapsed under "View research details".
 *   NOTHING about models, thresholds, grading, seals, or research logic changed:
 *   this file only READS founder_alpha views and renders them.
 *
 * SECURITY POSTURE (this process holds the Supabase service_role key):
 *  - Only GET /dash is handled; all other paths/methods 404.
 *  - The token is compared in constant time; a missing/empty FOUNDER_DASH_TOKEN
 *    DISABLES the route (503) so it can never be served wide open.
 *  - The token is never logged. Request logs omit the query string.
 *  - The route performs ONLY SELECTs against founder_alpha views/tables.
 *  - No filesystem access, no path handling — nothing to traverse.
 */

import http from 'node:http';
import crypto from 'node:crypto';

const PT = 'America/Los_Angeles';

function timingSafeEqual(a, b) {
  const ab = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  if (ab.length !== bb.length) return false;
  return crypto.timingSafeEqual(ab, bb);
}

/** 12-hour Pacific clock, no leading zero, ":00" dropped: "5pm", "5:45pm", "12:05pm". */
const fmtClock = (iso) => {
  if (!iso) return '—';
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: PT, hour: 'numeric', minute: '2-digit', hour12: true,
    }).formatToParts(new Date(iso));
    const get = (t) => parts.find((p) => p.type === t)?.value ?? '';
    const h = get('hour');
    const m = get('minute');
    const ap = (get('dayPeriod') || '').toLowerCase().replace(/\s/g, '');
    return m === '00' ? `${h}${ap}` : `${h}:${m}${ap}`;
  } catch {
    return '—';
  }
};

/** "Jul 24 · 5:45pm" for the historical feed. */
const fmtDateClock = (iso) => {
  if (!iso) return '—';
  try {
    const d = new Intl.DateTimeFormat('en-US', { timeZone: PT, month: 'short', day: 'numeric' })
      .format(new Date(iso));
    return `${d} · ${fmtClock(iso)}`;
  } catch {
    return '—';
  }
};

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Probability as a plain percent, e.g. 0.775 -> "77.5%". */
const pctYes = (p) => (p == null || Number.isNaN(Number(p)) ? '—' : `${(Number(p) * 100).toFixed(1)}%`);
/** Percentage-point gap as a plain percent, e.g. 0.096 -> "9.6%". */
const pctGap = (p) => (p == null || Number.isNaN(Number(p)) ? '—' : `${(Math.abs(Number(p)) * 100).toFixed(1)}%`);
/** Dollars with sign, e.g. -0.12 -> "-$0.12". */
const money = (v) => {
  if (v == null || Number.isNaN(Number(v))) return '—';
  const n = Number(v);
  return `${n < 0 ? '-' : ''}$${Math.abs(n).toFixed(2)}`;
};
/** BTC reference price, e.g. 65148.5 -> "$65,148". */
const usd0 = (v) =>
  v == null || Number.isNaN(Number(v)) ? '—'
    : '$' + Math.round(Number(v)).toLocaleString('en-US');

const SEAL_PLAIN = {
  'T-10': '10 minutes before settlement',
  'T-5': '5 minutes before settlement',
  'T-2': '2 minutes before settlement',
};
const sealPlain = (s) => SEAL_PLAIN[s] || (s ? esc(s) : '—');

/** Sample-quality label from the number of GRADED calls. Display thresholds only. */
function sampleQuality(nGraded) {
  const n = Number(nGraded) || 0;
  if (n === 0) return { label: 'No graded calls yet', cls: 'q-muted' };
  if (n <= 5) return { label: 'Too early to trust', cls: 'q-bad' };
  if (n <= 19) return { label: 'Early evidence', cls: 'q-warn' };
  if (n <= 49) return { label: 'Developing sample', cls: 'q-warn' };
  if (n <= 199) return { label: 'Meaningful sample', cls: 'q-ok' };
  return { label: 'Statistically validated', cls: 'q-ok' };
}

/**
 * Hero confidence label. NEVER reads "Validated" in shadow mode — statistical
 * validation is gated on the pre-registered Day-14 review, not on sample size
 * alone. Driven purely by graded actionable-call count.
 */
function confidenceLabel(nGraded) {
  const n = Number(nGraded) || 0;
  if (n === 0) return { label: 'No calls graded yet', cls: 'q-muted' };
  if (n < 50) return { label: 'Early research', cls: 'q-bad' };
  if (n < 200) return { label: 'Building evidence', cls: 'q-warn' };
  return { label: 'Strong sample · pending Day-14 gate', cls: 'q-ok' };
}

/** Human "N min ago" from an ISO timestamp. */
function minsAgo(iso) {
  if (!iso) return null;
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 0) return 'just now';
  const m = Math.round(ms / 60000);
  return m < 1 ? 'under a min ago' : `${m} min ago`;
}

/** Per-timing (10/5/2-min) actionable record, for the performance section. */
function timingRecords(board) {
  const meta = [
    { sp: 'T-10', label: '10-minute forecasts' },
    { sp: 'T-5', label: '5-minute forecasts' },
    { sp: 'T-2', label: '2-minute forecasts' },
  ];
  return meta.map(({ sp, label }) => {
    const rows = (board || []).filter((r) => r.seal_point === sp && (r.call === 'YES' || r.call === 'NO'));
    const g = rows.reduce((s, r) => s + Number(r.n_graded || 0), 0);
    const c = rows.reduce((s, r) => s + Number(r.n_correct || 0), 0);
    return { label, graded: g, correct: c, pct: g ? Math.round((c / g) * 100) : null };
  });
}

const CALL_COLORS = { YES: '#3fb950', NO: '#f85149', FAIR: '#58a6ff', THIN: '#8b949e' };

/** Query the views the dashboard needs. Never throws — returns an errors map. */
async function loadData(client) {
  const out = { errors: {} };

  const cap = await client
    .from('fa_window_capture')
    .select('window_id,ts,replica_index,replica_60s_avg,reference_strike,seconds_to_close,up_bid,up_ask,down_bid,down_ask,up_mid')
    .order('ts', { ascending: false })
    .limit(1);
  out.currentCapture = cap.error ? null : (cap.data?.[0] ?? null);
  out.latestCaptureTs = out.currentCapture?.ts ?? null;
  if (cap.error) out.errors.capture = cap.error.message;

  const calls = await client
    .from('v_fa_window_calls')
    .select('window_id,seal_point,sealed_at,close_ts,strike,replica_index,market_p,consensus_p,divergence,exact_fee,half_spread,actionable_threshold,call,outcome,call_correct')
    .order('close_ts', { ascending: false })
    .limit(60);
  out.calls = calls.error ? [] : calls.data;
  if (calls.error) out.errors.calls = `${calls.error.code || ''} ${calls.error.message}`.trim();

  const board = await client
    .from('v_fa_call_scoreboard')
    .select('seal_point,call,n_total,n_graded,n_correct,accuracy,mean_abs_divergence');
  out.board = board.error ? [] : board.data;
  if (board.error) out.errors.board = `${board.error.code || ''} ${board.error.message}`.trim();

  const v2board = await client
    .from('v_fa_v2_scoreboard')
    .select('day,graded_windows,decided_calls,no_trades,calls_correct,call_accuracy,net_pnl_total');
  out.v2board = v2board.error ? [] : v2board.data;
  if (v2board.error) out.errors.v2board = `${v2board.error.code || ''} ${v2board.error.message}`.trim();

  const pnl = await client
    .from('v_fa_paper_pnl')
    .select('seal_point,call,n_settled,n_wins,net_pnl,avg_pnl_per_trade,avg_entry_price,total_fees');
  out.pnl = pnl.error ? [] : pnl.data;
  if (pnl.error) out.errors.pnl = `${pnl.error.code || ''} ${pnl.error.message}`.trim();

  // Every actionable (YES/NO) call that has SETTLED — the "outcome of each" feed.
  const graded = await client
    .from('v_fa_window_calls')
    .select('window_id,seal_point,close_ts,strike,market_p,consensus_p,divergence,call,outcome,call_correct')
    .in('call', ['YES', 'NO'])
    .not('outcome', 'is', null)
    .order('close_ts', { ascending: false })
    .limit(60);
  out.graded = graded.error ? [] : graded.data;
  if (graded.error) out.errors.graded = `${graded.error.code || ''} ${graded.error.message}`.trim();

  return out;
}

// ---------------------------------------------------------------------
// Decision logic (pure presentation — reads the sealed call, never recomputes it)
// ---------------------------------------------------------------------

/** The single current founder decision: the latest seal for the live window. */
function currentDecision(data) {
  const cap = data.currentCapture;
  const windowId = cap?.window_id ?? null;
  let seal = null;
  if (windowId && data.calls?.length) {
    const rows = data.calls.filter((r) => r.window_id === windowId);
    if (rows.length) {
      seal = rows.reduce((a, b) =>
        (new Date(b.sealed_at).getTime() > new Date(a.sealed_at).getTime() ? b : a));
    }
  }
  // Close time: prefer the sealed close_ts; else derive from capture + seconds_to_close.
  let closeIso = seal?.close_ts ?? null;
  if (!closeIso && cap?.ts && cap.seconds_to_close != null) {
    closeIso = new Date(new Date(cap.ts).getTime() + Number(cap.seconds_to_close) * 1000).toISOString();
  }
  const strike = seal?.strike ?? cap?.reference_strike ?? null;
  const btcRef = cap?.replica_index ?? seal?.replica_index ?? null;
  return { cap, windowId, seal, closeIso, strike, btcRef };
}

/** Map a sealed call-state to the founder-facing output (only 3 badges exist). */
function foundOutput(seal) {
  const call = seal?.call ?? null;
  const consensus = seal?.consensus_p ?? null;
  if (call === 'YES') {
    return { badge: 'TAKE YES', cls: 'd-yes',
      line: 'TSM thinks YES is priced too cheaply.' };
  }
  if (call === 'NO') {
    return { badge: 'TAKE NO', cls: 'd-no',
      line: 'TSM thinks YES is priced too expensively, so NO is the better side.' };
  }
  // Everything else translates to NO TRADE, with a plain reason.
  let reason;
  if (call === 'FAIR') reason = 'TSM mostly agrees with the market.';
  else if (call === 'THIN' && consensus == null) reason = 'The models don’t have enough to make a call.';
  else if (call === 'THIN') reason = 'TSM disagrees, but not by enough to beat fees and the spread.';
  else reason = 'No forecast has been sealed for this window yet — the first sealed forecast is made 10 minutes before settlement.';
  return { badge: 'NO TRADE', cls: 'd-flat', line: reason };
}

function timeRemaining(closeIso) {
  if (!closeIso) return '—';
  const ms = new Date(closeIso).getTime() - Date.now();
  if (ms <= 0) return 'settling now';
  const mins = Math.floor(ms / 60000);
  const secs = Math.floor((ms % 60000) / 1000);
  if (mins >= 1) return `${mins} min ${secs}s`;
  return `${secs}s`;
}

/** Next seal for the current window (seals fire at 10, 5, 2 min before close). */
function nextSealHint(closeIso) {
  if (!closeIso) return null;
  const ms = new Date(closeIso).getTime() - Date.now();
  if (ms <= 0) return null;
  const minsLeft = ms / 60000;
  const next = [10, 5, 2].find((m) => m < minsLeft); // largest mark still ahead
  if (next == null) return null; // past the final (T-2) seal — current call stands
  const inMs = ms - next * 60000;
  const m = Math.floor(inMs / 60000);
  const s = Math.floor((inMs % 60000) / 1000);
  return { mark: next, label: m >= 1 ? `${m} min ${s}s` : `${s}s` };
}

/**
 * The most recent actionable (YES/NO) call across all loaded windows.
 * Uses each window's LATEST seal only — an earlier YES/NO seal that a later
 * seal superseded (e.g. to FAIR) is not a live signal and must not resurface.
 */
function latestActionable(data) {
  const rows = data.calls || [];
  if (!rows.length) return null;
  const latestPerWindow = new Map();
  for (const r of rows) {
    const cur = latestPerWindow.get(r.window_id);
    if (!cur || new Date(r.sealed_at).getTime() > new Date(cur.sealed_at).getTime()) {
      latestPerWindow.set(r.window_id, r);
    }
  }
  const actionable = [...latestPerWindow.values()].filter((r) => r.call === 'YES' || r.call === 'NO');
  if (!actionable.length) return null;
  return actionable.reduce((a, b) =>
    (new Date(b.sealed_at).getTime() > new Date(a.sealed_at).getTime() ? b : a));
}

// ---------------------------------------------------------------------
// Render helpers
// ---------------------------------------------------------------------

function renderDecisionCard(data) {
  const d = currentDecision(data);
  const out = foundOutput(d.seal);
  const s = d.seal;
  const hasNums = s && s.consensus_p != null && s.market_p != null;

  const conf = confidenceLabel(successRate(data.board).graded);
  const compare = hasNums ? `
    <div class="cmp">
      <div class="cmprow"><span>Market thinks YES</span><b>${pctYes(s.market_p)}</b></div>
      <div class="cmprow"><span>TSM thinks YES</span><b>${pctYes(s.consensus_p)}</b></div>
      <div class="cmprow disagree"><span>TSM disagrees by</span><b>${pctGap(s.divergence)}</b></div>
      <div class="cmprow"><span>Confidence</span><b><span class="qlabel ${conf.cls}">${esc(conf.label)}</span></b></div>
    </div>
    <p class="dline">${esc(out.line)}</p>`
    : `<p class="dline">${esc(out.line)}</p>`;

  // Jargon-free basis + freshness (no T-10/T-5/T-2 on the decision surface).
  const basisLine = s
    ? `<p class="seal-note">Based on the latest forecast${minsAgo(s.sealed_at) ? ` · updated ${esc(minsAgo(s.sealed_at))}` : ''}. Older forecasts for this window are replaced automatically.</p>`
    : '';
  const ns = nextSealHint(d.closeIso);
  const nextLine = ns
    ? `<p class="seal-note">Next forecast in ~${esc(ns.label)}. A YES/NO only appears when TSM disagrees with the market by more than fees + spread.</p>`
    : '';

  return `
  <section class="card decision ${out.cls}">
    <div class="dhead">
      <span class="dlabel">Current BTC market</span>
      <span class="mode-chip">SHADOW</span>
    </div>
    <div class="facts">
      <div class="fact"><span>Settles</span><b>${fmtClock(d.closeIso)} PT</b></div>
      <div class="fact"><span>Strike</span><b>${usd0(d.strike)}</b></div>
      <div class="fact"><span>BTC now</span><b>${usd0(d.btcRef)}</b></div>
      <div class="fact"><span>Time left</span><b>${esc(timeRemaining(d.closeIso))}</b></div>
    </div>
    <div class="verdict">
      <span class="vsub">Recommendation</span>
      <span class="badge ${out.cls}">${esc(out.badge)}</span>
    </div>
    ${compare}
    ${basisLine}
    ${nextLine}
    <div class="trust">
      <span>Would this be allowed with real capital today?</span>
      <b>No — shadow mode only. The model has not passed the validation gate.</b>
    </div>
  </section>`;
}

/** The "most recent YES/NO signal" card — always shows the last real call to paper-trade. */
function renderLatestActionable(data, curWindowId) {
  const r = latestActionable(data);
  if (!r) {
    return `
  <section class="card actionable demoted">
    <div class="dhead"><span class="dlabel small2">Last actionable signal — for paper-trading</span></div>
    <p class="muted" style="margin:8px 0 0;font-size:13px">No YES/NO signal yet — TSM hasn’t disagreed with the market by enough to clear fees. NO-TRADE windows don’t count.</p>
  </section>`;
  }
  const isCur = r.window_id === curWindowId;
  const cls = r.call === 'YES' ? 'd-yes' : 'd-no';
  const agoMs = Date.now() - new Date(r.sealed_at).getTime();
  const sealedAgo = agoMs < 3600000
    ? `${Math.max(1, Math.round(agoMs / 60000))} min ago`
    : fmtDateClock(r.sealed_at);
  const settledMs = new Date(r.close_ts).getTime() - Date.now();
  let status = settledMs > 0
    ? `<span class="muted">settles ${fmtClock(r.close_ts)} PT — not graded yet</span>`
    : '<span class="muted">awaiting settlement grade</span>';
  if (r.outcome) {
    status = r.call_correct
      ? `<span class="pos">✓ correct — settled ${esc(r.outcome)}</span>`
      : `<span class="neg">✗ wrong — settled ${esc(r.outcome)}</span>`;
  }
  const entryHint = r.call === 'YES'
    ? `buy <b>YES</b> · market was ${pctYes(r.market_p)}`
    : `buy <b>NO</b> · market was ${pctYes(1 - Number(r.market_p))}`;
  return `
  <section class="card actionable demoted">
    <div class="dhead">
      <span class="dlabel small2">Last actionable signal — for paper-trading ${isCur ? '· current window' : '· past window'}</span>
      <span class="badge ${cls}" style="font-size:14px;padding:3px 12px">TAKE ${esc(r.call)}</span>
    </div>
    <div class="facts">
      <div class="fact"><span>Window settles</span><b>${fmtClock(r.close_ts)} PT</b></div>
      <div class="fact"><span>Strike</span><b>${usd0(r.strike)}</b></div>
      <div class="fact"><span>To paper-trade</span><b style="font-size:13px">${entryHint}</b></div>
      <div class="fact"><span>Sealed</span><b style="font-size:12.5px">${sealPlain(r.seal_point)}<br><span class="muted">${esc(sealedAgo)}</span></b></div>
    </div>
    <div class="cmprow" style="border:0;padding:8px 2px 0">
      <span>TSM ${pctYes(r.consensus_p)} vs market ${pctYes(r.market_p)} — disagreed by ${pctGap(r.divergence)}</span>
      <span>${status}</span>
    </div>
  </section>`;
}

/** Accuracy for the current call type, plus the full honest per-type record. */
function renderAccuracy(data) {
  const d = currentDecision(data);
  const curKey = d.seal ? `${d.seal.seal_point}|${d.seal.call}` : null;

  if (!data.board.length) return '<p class="muted">No graded calls yet — nothing to score.</p>';

  const order = { 'T-10': 0, 'T-5': 1, 'T-2': 2 };
  const rows = [...data.board]
    .filter((r) => r.call === 'YES' || r.call === 'NO' || `${r.seal_point}|${r.call}` === curKey)
    .sort((a, b) => (order[a.seal_point] ?? 9) - (order[b.seal_point] ?? 9)
      || String(a.call).localeCompare(b.call));

  const body = rows.map((r) => {
    const q = sampleQuality(r.n_graded);
    const isCur = `${r.seal_point}|${r.call}` === curKey;
    const acc = r.n_graded ? `${Math.round((Number(r.n_correct) / Number(r.n_graded)) * 100)}%` : '—';
    return `<tr class="${isCur ? 'cur' : ''}">
      <td>${isCur ? '<span class="you">this window ▸</span> ' : ''}${esc(sealPlain(r.seal_point))}</td>
      <td><span class="pill ${r.call}">${esc(r.call)}</span></td>
      <td class="mono"><b>${esc(r.n_correct ?? 0)} of ${esc(r.n_graded ?? 0)} correct</b></td>
      <td class="mono">${acc}</td>
      <td><span class="qlabel ${q.cls}">${esc(q.label)}</span></td>
    </tr>`;
  }).join('');

  return `<table>
    <thead><tr><th>Call timing</th><th>Side</th><th>Record</th><th>%</th><th>Sample quality</th></tr></thead>
    <tbody>${body}</tbody></table>
    <p class="muted small">Percentages are shown only next to their raw counts. A call being <em>correct</em>
      is not the same as it being <em>profitable</em> — see paper results below.</p>`;
}

/** Paper P&L after Kalshi fees at executable ask prices (no midpoint fills). */
function renderPnl(data) {
  if (data.errors.pnl) {
    return `<p class="muted">Paper P&amp;L view not available yet (${esc(data.errors.pnl)}).</p>`;
  }
  if (!data.pnl.length) {
    return '<p class="muted">No settled YES/NO trades yet — paper P&amp;L begins once actionable calls settle.</p>';
  }
  const order = { 'T-10': 0, 'T-5': 1, 'T-2': 2 };
  const rows = [...data.pnl].sort((a, b) =>
    (order[a.seal_point] ?? 9) - (order[b.seal_point] ?? 9) || String(a.call).localeCompare(b.call));

  const totalNet = data.pnl.reduce((s, r) => s + Number(r.net_pnl || 0), 0);
  const totalN = data.pnl.reduce((s, r) => s + Number(r.n_settled || 0), 0);
  const totalWins = data.pnl.reduce((s, r) => s + Number(r.n_wins || 0), 0);

  const body = rows.map((r) => `<tr>
    <td>${esc(sealPlain(r.seal_point))}</td>
    <td><span class="pill ${r.call}">${esc(r.call)}</span></td>
    <td class="mono">${esc(r.n_wins ?? 0)} of ${esc(r.n_settled ?? 0)}</td>
    <td class="mono ${Number(r.net_pnl) < 0 ? 'neg' : 'pos'}">${money(r.net_pnl)}</td>
    <td class="mono muted">${money(r.avg_pnl_per_trade)}</td>
  </tr>`).join('');

  return `
    <div class="pnl-head">
      <div><span class="pnl-l">Net paper result after fees</span>
        <span class="pnl-big ${totalNet < 0 ? 'neg' : 'pos'}">${money(totalNet)}</span></div>
      <div class="pnl-sub">${totalWins} of ${totalN} trades won · 1 contract each · entered at the executable ask · Kalshi fee applied · no midpoint fills, no multi-level slippage modeled</div>
    </div>
    <table>
      <thead><tr><th>Call timing</th><th>Side</th><th>Won</th><th>Net after fees</th><th>Avg / trade</th></tr></thead>
      <tbody>${body}</tbody></table>`;
}

/** Overall TSM success rate on actionable (YES/NO) calls, from the scoreboard. */
function successRate(board) {
  const act = (board || []).filter((r) => r.call === 'YES' || r.call === 'NO');
  const sumG = (p) => act.filter(p).reduce((s, r) => s + Number(r.n_graded || 0), 0);
  const sumC = (p) => act.filter(p).reduce((s, r) => s + Number(r.n_correct || 0), 0);
  const g = sumG(() => true);
  const c = sumC(() => true);
  return {
    graded: g, correct: c, pct: g ? Math.round((c / g) * 100) : null,
    yesG: sumG((r) => r.call === 'YES'), yesC: sumC((r) => r.call === 'YES'),
    noG: sumG((r) => r.call === 'NO'), noC: sumC((r) => r.call === 'NO'),
  };
}

/**
 * Performance section — the ONE place timing (10/5/2-min) lives. Overall success
 * rate + per-timing records + the settled outcome of every actionable call.
 * All percentages are actionable (YES/NO) only; FAIR/THIN are excluded because a
 * FAIR "hit" measures the market's calibration, not TSM's.
 */
function renderPerformance(data) {
  const sr = successRate(data.board);
  const q = sampleQuality(sr.graded);

  if (sr.graded === 0) {
    return '<div class="card"><p class="muted">No actionable (YES/NO) calls have settled yet — performance begins once they grade.</p></div>';
  }

  const overall = `<div class="pnl-head">
      <div><span class="pnl-l">Overall · YES/NO calls</span>
        <span class="pnl-big">${sr.correct} of ${sr.graded}${sr.pct != null ? ` · ${sr.pct}%` : ''}</span></div>
      <div class="pnl-sub">YES ${sr.yesC} of ${sr.yesG} right · NO ${sr.noC} of ${sr.noG} right ·
        <span class="qlabel ${q.cls}">${esc(q.label)}</span><br>Actionable calls only — NO-TRADE/agree windows excluded. Correct ≠ profitable (see paper results).</div>
    </div>`;

  const cards = timingRecords(data.board).map((t) => `
    <div class="hcell">
      <span>${esc(t.label)}</span>
      <b>${t.graded ? `${t.correct} of ${t.graded}${t.pct != null ? ` · ${t.pct}%` : ''}` : '<span class="muted">no graded calls</span>'}</b>
    </div>`).join('');

  const rows = data.graded || [];
  const table = rows.length
    ? `<div class="scroll" style="padding:0;margin-top:12px">
        <p class="muted small" style="margin:0 0 6px">Outcome of every call TSM made, newest first:</p>
        <table>
          <thead><tr><th>settled (PT)</th><th>strike</th><th>call</th><th>TSM YES</th><th>mkt YES</th><th>outcome</th><th>result</th></tr></thead>
          <tbody>${rows.map((r) => `<tr>
            <td class="mono small">${fmtDateClock(r.close_ts)}</td>
            <td class="mono">${usd0(r.strike)}</td>
            <td><span class="pill ${r.call}">${esc(r.call)}</span></td>
            <td class="mono">${pctYes(r.consensus_p)}</td>
            <td class="mono muted">${pctYes(r.market_p)}</td>
            <td class="mono">settled ${esc(r.outcome)}</td>
            <td>${r.call_correct ? '<span class="pos">✓ right</span>' : '<span class="neg">✗ wrong</span>'}</td>
          </tr>`).join('')}</tbody></table></div>`
    : '';

  return `<div class="card">
      ${overall}
      <div class="health" style="margin-top:6px">${cards}</div>
      <p class="muted small" style="margin:10px 0 0">Per-timing samples are still small — treat these percentages as directional, not a ranking of which timing is "best."</p>
      ${table}
    </div>`;
}

/** Raw window-calls feed (research detail, collapsed). */
function renderCallsTable(rows) {
  if (!rows.length) return '<p class="muted">No sealed windows yet.</p>';
  const body = rows.map((r) => {
    const color = CALL_COLORS[r.call] || '#8b949e';
    let result = '<span class="muted">pending</span>';
    if (r.outcome) {
      if (r.call === 'THIN' || r.call_correct == null) {
        result = `<span class="muted">settled ${esc(r.outcome)}</span>`;
      } else if (r.call_correct) {
        result = '<span style="color:#3fb950">✓ right</span>';
      } else {
        result = '<span style="color:#f85149">✗ wrong</span>';
      }
    }
    const div = r.divergence == null ? '—'
      : `${Number(r.divergence) >= 0 ? '+' : '−'}${(Math.abs(Number(r.divergence)) * 100).toFixed(1)}pp`;
    return `<tr>
      <td class="mono small">${fmtDateClock(r.close_ts)}</td>
      <td class="mono small">${esc(String(r.window_id).replace('KXBTC15M-', ''))}</td>
      <td class="mono">${esc(r.seal_point)}</td>
      <td><span class="pill" style="background:${color}22;color:${color};border:1px solid ${color}55">${esc(r.call)}</span></td>
      <td class="mono">${pctYes(r.consensus_p)}</td>
      <td class="mono muted">${pctYes(r.market_p)}</td>
      <td class="mono">${div}</td>
      <td>${result}</td>
    </tr>`;
  }).join('');
  return `<table>
    <thead><tr>
      <th>settles (PT)</th><th>window</th><th>seal</th><th>call</th>
      <th>TSM YES</th><th>mkt YES</th><th>gap</th><th>result</th>
    </tr></thead><tbody>${body}</tbody></table>`;
}

function renderBoard(rows) {
  if (!rows.length) return '<p class="muted">No graded calls yet.</p>';
  const order = { 'T-10': 0, 'T-5': 1, 'T-2': 2 };
  const sorted = [...rows].sort((a, b) =>
    (order[a.seal_point] ?? 9) - (order[b.seal_point] ?? 9) || String(a.call).localeCompare(b.call));
  const body = sorted.map((r) => {
    const color = CALL_COLORS[r.call] || '#8b949e';
    const acc = r.accuracy == null ? '—' : `${(Number(r.accuracy) * 100).toFixed(0)}%`;
    return `<tr>
      <td class="mono">${esc(r.seal_point)}</td>
      <td><span class="pill" style="background:${color}22;color:${color};border:1px solid ${color}55">${esc(r.call)}</span></td>
      <td class="mono">${esc(r.n_total)}</td>
      <td class="mono">${esc(r.n_graded)}</td>
      <td class="mono">${esc(r.n_correct ?? 0)}</td>
      <td class="mono">${acc}</td>
      <td class="mono muted">${r.mean_abs_divergence == null ? '—' : (Number(r.mean_abs_divergence) * 100).toFixed(1) + 'pp'}</td>
    </tr>`;
  }).join('');
  return `<table>
    <thead><tr><th>seal</th><th>call</th><th>total</th><th>graded</th><th>correct</th><th>accuracy</th><th>mean |gap|</th></tr></thead>
    <tbody>${body}</tbody></table>`;
}

function renderV2Panel(data) {
  const rows = (data && data.v2board) || [];
  if (!rows.length) return '';
  const t = rows.reduce((a, r) => ({
    graded: a.graded + Number(r.graded_windows || 0),
    decided: a.decided + Number(r.decided_calls || 0),
    no_trades: a.no_trades + Number(r.no_trades || 0),
    correct: a.correct + Number(r.calls_correct || 0),
    net: a.net + Number(r.net_pnl_total || 0),
  }), { graded: 0, decided: 0, no_trades: 0, correct: 0, net: 0 });
  const acc = t.decided ? `${((t.correct / t.decided) * 100).toFixed(0)}%` : '—';
  const net = `${t.net >= 0 ? '+' : ''}${t.net.toFixed(2)}`;
  return `
    <section class="card">
      <h2>V2.1 Arbiter — regime-based (shadow)</h2>
      <p class="muted small">The learning arbiter: regime classification + conflict resolution. Separate from the Phase-1 forecasts above; early sample.</p>
      <p><strong>${t.decided}</strong> decided calls · <strong>${t.no_trades}</strong> no-trade · accuracy <strong>${acc}</strong> (${t.correct}/${t.decided}) · paper net <strong>${net}</strong> · ${t.graded} graded windows</p>
    </section>`;
}

function renderPage(data) {
  // Normalize so a partial data object (or a failed query) never throws.
  data = {
    ...data,
    errors: data?.errors || {},
    calls: data?.calls || [],
    board: data?.board || [],
    pnl: data?.pnl || [],
    graded: data?.graded || [],
  };
  const now = Date.now();
  const aliveAgeS = data.latestCaptureTs
    ? Math.round((now - new Date(data.latestCaptureTs).getTime()) / 1000)
    : null;
  const alive = aliveAgeS != null && aliveAgeS <= 60;
  const aliveColor = alive ? '#3fb950' : '#f85149';
  const aliveText = aliveAgeS == null ? 'no data'
    : alive ? `live · ${aliveAgeS}s ago` : `STALE · ${aliveAgeS}s ago`;

  const totalGraded = data.board.reduce((s, r) => s + Number(r.n_graded || 0), 0);
  const totalSealed = data.board.reduce((s, r) => s + Number(r.n_total || 0), 0);

  const errBanner = Object.keys(data.errors).length
    ? `<div class="err">data warnings: ${esc(Object.entries(data.errors).map(([k, v]) => `${k}: ${v}`).join(' | '))}</div>`
    : '';

  return `<!doctype html>
<html lang="en"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta http-equiv="refresh" content="10">
<title>Founder BTC Alpha — Shadow</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  body { margin:0; background:#0d1117; color:#e6edf3;
    font:15px/1.55 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  .wrap { max-width:820px; margin:0 auto; padding:16px 16px 48px; }
  a { color:inherit; }
  .shadow { background:#3d2d00; color:#f0c674; border:1px solid #8a6d00;
    padding:8px 12px; border-radius:8px; font-weight:600; text-align:center; letter-spacing:.02em; font-size:13px; }
  header { display:flex; align-items:center; justify-content:space-between; gap:12px; margin:14px 0 6px; flex-wrap:wrap; }
  h1 { font-size:16px; margin:0; font-weight:650; color:#8b949e; letter-spacing:.02em; }
  h2 { font-size:12px; text-transform:uppercase; letter-spacing:.09em; color:#8b949e; margin:26px 0 10px; }
  .alive { display:inline-flex; align-items:center; gap:8px; font-weight:600; font-size:13px; }
  .dot { width:9px; height:9px; border-radius:50%; box-shadow:0 0 8px currentColor; }

  .card { background:#161b22; border:1px solid #21262d; border-radius:14px; padding:18px; }
  .decision { border-width:2px; }
  .decision.d-yes { border-color:#2ea043; box-shadow:0 0 0 1px #2ea04322, 0 8px 30px #2ea04315; }
  .decision.d-no  { border-color:#da3633; box-shadow:0 0 0 1px #da363322, 0 8px 30px #da363315; }
  .decision.d-flat{ border-color:#30363d; }
  .actionable { margin-top:12px; }
  .actionable.d-yes { border-color:#2ea043; }
  .actionable.d-no  { border-color:#da3633; }
  .actionable.d-flat{ border-color:#30363d; }
  .actionable.demoted { border-color:#21262d; background:#0f141a; padding:14px; }
  .actionable.demoted .fact { background:#0d1117; }
  .dlabel.small2 { text-transform:none; font-size:12px; letter-spacing:.01em; font-weight:600; color:#8b949e; }
  .dhead { display:flex; justify-content:space-between; align-items:center; }
  .dlabel { font-size:13px; text-transform:uppercase; letter-spacing:.08em; color:#8b949e; font-weight:700; }
  .mode-chip { font-size:11px; font-weight:700; letter-spacing:.06em; color:#f0c674; border:1px solid #8a6d00; background:#3d2d00; padding:1px 8px; border-radius:999px; }
  .facts { display:grid; grid-template-columns:repeat(4,1fr); gap:8px; margin:14px 0 16px; }
  .fact { background:#0d1117; border:1px solid #21262d; border-radius:9px; padding:9px 10px; }
  .fact span { display:block; font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:#8b949e; margin-bottom:3px; }
  .fact b { font-size:16px; font-variant-numeric:tabular-nums; }
  .verdict { display:flex; align-items:center; gap:12px; margin:2px 0 4px; }
  .vsub { font-size:12px; text-transform:uppercase; letter-spacing:.08em; color:#8b949e; }
  .badge { font-size:22px; font-weight:800; letter-spacing:.02em; padding:6px 16px; border-radius:10px; }
  .badge.d-yes { color:#0d1117; background:#3fb950; }
  .badge.d-no  { color:#fff; background:#f85149; }
  .badge.d-flat{ color:#e6edf3; background:#30363d; }
  .cmp { margin:14px 0 6px; border-top:1px solid #21262d; }
  .cmprow { display:flex; justify-content:space-between; padding:7px 2px; border-bottom:1px solid #21262d; font-size:15px; }
  .cmprow span { color:#8b949e; }
  .cmprow b { font-variant-numeric:tabular-nums; }
  .cmprow.disagree b { color:#e3b341; }
  .dline { font-size:15px; margin:12px 0 6px; font-weight:600; }
  .seal-note { font-size:12.5px; color:#8b949e; margin:4px 0 0; }
  .trust { margin-top:14px; background:#0d1117; border:1px dashed #30363d; border-radius:9px; padding:10px 12px; font-size:13px; }
  .trust span { color:#8b949e; display:block; margin-bottom:2px; }
  .trust b { color:#f0c674; }

  table { width:100%; border-collapse:collapse; background:#161b22; border-radius:10px; overflow:hidden; }
  th,td { padding:8px 10px; text-align:left; border-bottom:1px solid #21262d; white-space:nowrap; }
  th { font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:#8b949e; background:#0f141a; }
  tr:last-child td { border-bottom:none; }
  tr.cur td { background:#12271a; }
  .you { color:#3fb950; font-weight:700; font-size:12px; }
  .mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  .small { font-size:12px; } .muted { color:#8b949e; }
  .pos { color:#3fb950; } .neg { color:#f85149; }
  .pill { padding:1px 9px; border-radius:999px; font-weight:700; font-size:12px; font-family:ui-monospace,monospace; }
  .pill.YES { color:#3fb950; background:#3fb95022; border:1px solid #3fb95055; }
  .pill.NO  { color:#f85149; background:#f8514922; border:1px solid #f8514955; }
  .pill.FAIR{ color:#58a6ff; background:#58a6ff22; border:1px solid #58a6ff55; }
  .pill.THIN{ color:#8b949e; background:#8b949e22; border:1px solid #8b949e55; }
  .qlabel { font-size:12px; font-weight:600; padding:1px 8px; border-radius:999px; }
  .q-ok { color:#3fb950; background:#3fb95018; }
  .q-warn { color:#e3b341; background:#e3b34118; }
  .q-bad { color:#f0883e; background:#f0883e18; }
  .q-muted { color:#8b949e; background:#8b949e18; }

  .pnl-head { display:flex; justify-content:space-between; align-items:flex-start; gap:12px; margin-bottom:12px; flex-wrap:wrap; }
  .pnl-l { display:block; font-size:12px; text-transform:uppercase; letter-spacing:.06em; color:#8b949e; }
  .pnl-big { font-size:26px; font-weight:800; font-variant-numeric:tabular-nums; }
  .pnl-sub { font-size:12px; color:#8b949e; max-width:360px; text-align:right; }

  .warn-box { background:#20160a; border:1px solid #5c3d12; color:#e3b341; border-radius:10px; padding:12px 14px; font-size:13.5px; }
  .health { display:grid; grid-template-columns:repeat(auto-fit,minmax(150px,1fr)); gap:8px; }
  .hcell { background:#161b22; border:1px solid #21262d; border-radius:9px; padding:10px 12px; }
  .hcell span { display:block; font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:#8b949e; margin-bottom:3px; }
  .hcell b { font-size:14px; }

  details { margin-top:10px; background:#0f141a; border:1px solid #21262d; border-radius:10px; }
  summary { cursor:pointer; padding:12px 14px; font-weight:600; font-size:13px; color:#8b949e; user-select:none; }
  details[open] summary { border-bottom:1px solid #21262d; color:#e6edf3; }
  .scroll { overflow-x:auto; padding:12px; }
  .err { background:#3d1a1a; color:#ff9d9d; border:1px solid #7a2a2a; padding:6px 10px; border-radius:8px; margin-top:8px; font-size:12px; }
  .foot { color:#6e7681; font-size:11px; margin:26px 0 8px; text-align:center; line-height:1.7; }
</style></head>
<body><div class="wrap">
  <div class="shadow">SHADOW MODE — research only · no orders · no capital · graded until the Day-14 gate</div>
  <header>
    <h1>Founder BTC Alpha · 15-minute BTC markets</h1>
    <span class="alive"><span class="dot" style="color:${aliveColor};background:${aliveColor}"></span>
      data feed <span style="color:${aliveColor}">${esc(aliveText)}</span></span>
  </header>
  ${errBanner}

  ${renderDecisionCard(data)}

  ${renderLatestActionable(data, currentDecision(data).windowId)}

  <h2>How has TSM performed?</h2>
  ${renderPerformance(data)}

  <h2>Paper results — did it make money after costs?</h2>
  <div class="card">${renderPnl(data)}</div>

  <h2>How much can you trust this yet?</h2>
  <div class="warn-box">
    Early data. ${totalGraded} call${totalGraded === 1 ? '' : 's'} graded so far.
    The Day-14 gate needs on the order of ~1,300 settled windows before any win rate is reliable —
    treat everything above as directional, not proof. A good or bad morning is mostly noise at this size.
  </div>

  <h2>Experiment health</h2>
  <div class="health">
    <div class="hcell"><span>Data feed</span><b style="color:${aliveColor}">${esc(aliveText)}</b></div>
    <div class="hcell"><span>Mode</span><b style="color:#f0c674">SHADOW · no capital</b></div>
    <div class="hcell"><span>Windows sealed</span><b>${totalSealed}</b></div>
    <div class="hcell"><span>Calls graded</span><b>${totalGraded}</b></div>
  </div>

  <h2>Research details</h2>
  <details id="research">
    <summary>Show research details — advanced only (the raw forecasts behind each recommendation)</summary>
    <div class="scroll">
      <p class="muted small" style="margin-top:0">The recommendation always uses the <b>latest forecast</b> for each window; earlier forecasts (10, 5, and 2 minutes before settlement) are superseded automatically. Every sealed forecast vs the market, newest first — "gap" = TSM YES minus market YES.</p>
      ${renderCallsTable(data.calls)}
      <p class="muted small">Cumulative scoreboard by forecast timing and side:</p>
      ${renderBoard(data.board)}
      ${renderV2Panel(data)}
    </div>
  </details>

  <p class="foot">as of ${fmtClock(new Date().toISOString())} PT · auto-refreshes every 10s ·
    TAKE YES / TAKE NO = an actionable mispricing after fees · NO TRADE = agree, too small, or no forecast ·
    correct ≠ profitable — see paper results · shadow only until the Day-14 validation gate.</p>
  <script>
    // Keep the research panel's open/closed state across the 10s auto-refresh.
    (function () {
      try {
        var d = document.getElementById('research');
        if (!d) return;
        if (localStorage.getItem('fa_research_open') === '1') d.open = true;
        d.addEventListener('toggle', function () {
          localStorage.setItem('fa_research_open', d.open ? '1' : '0');
        });
      } catch (e) { /* storage blocked — panel just won't persist */ }
    })();
  </script>
</div></body></html>`;
}

/**
 * Start the dashboard HTTP server.
 * @param {object} opts
 * @param {() => Promise<object>} opts.getClient  returns a Supabase client
 * @param {string} opts.token   FOUNDER_DASH_TOKEN (route disabled if falsy)
 * @param {number} opts.port
 * @param {object} opts.logger
 * @returns {http.Server|null}
 */
export function startDashboard({ getClient, token, port, logger = console } = {}) {
  if (!token) {
    logger.warn?.('[dash] FOUNDER_DASH_TOKEN not set — dashboard route DISABLED');
    return null;
  }

  const server = http.createServer(async (req, res) => {
    let pathname = '/';
    let query;
    try {
      const u = new URL(req.url, 'http://localhost');
      pathname = u.pathname;
      query = u.searchParams;
    } catch {
      res.writeHead(400).end('bad request');
      return;
    }

    const deny = (code, msg) => {
      res.writeHead(code, { 'content-type': 'text/plain; charset=utf-8',
        'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer' });
      res.end(msg);
    };

    if (req.method !== 'GET' || pathname !== '/dash') {
      return deny(404, 'not found');
    }
    if (!timingSafeEqual(query.get('token') || '', token)) {
      logger.warn?.(`[dash] rejected unauthenticated /dash from ${req.socket.remoteAddress}`);
      return deny(401, 'unauthorized');
    }

    try {
      const client = await getClient();
      const data = await loadData(client);
      const html = renderPage(data);
      res.writeHead(200, {
        'content-type': 'text/html; charset=utf-8',
        'cache-control': 'no-store',
        'x-content-type-options': 'nosniff',
        'referrer-policy': 'no-referrer',
        'content-security-policy':
          "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
      });
      res.end(html);
    } catch (err) {
      logger.error?.(`[dash] render failed: ${err.message}`);
      deny(500, 'internal error');
    }
  });

  server.on('error', (err) => logger.error?.(`[dash] server error: ${err.message}`));
  server.listen(port, '0.0.0.0', () => {
    logger.info?.(`[dash] founder dashboard listening on :${port} route GET /dash (token required)`);
  });
  return server;
}

export {
  renderPage, loadData, timingSafeEqual, currentDecision, foundOutput,
  sampleQuality, latestActionable, nextSealHint, successRate,
};
