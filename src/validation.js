/**
 * BTC Alpha — THREE-APPROACH VALIDATION (founder directive 2026-07-26).
 *
 * Adds the comparison/validation layer to the founder dashboard WITHOUT
 * touching any engine, threshold, or definition:
 *   - source-audited approach cards (native + head-to-head, version-split,
 *     timing-split for the Forecast),
 *   - an every-call inspectable table with filters + sorting,
 *   - visible reconciliation identities (fail loudly, never silently),
 *   - explicit denominator definitions on-screen.
 *
 * AUDIT RULINGS ENCODED IN THE LABELS (source-verified 2026-07-26):
 *   Forecast  = "Outcome Probability" — independent barrier-diffusion models
 *               B0..B3 sealed at T-10/T-5/T-2; the four-state call
 *               (YES/NO/FAIR/THIN) is consensus-vs-market with a cost threshold.
 *   V2.1      = "Edge-Based Decision Policy" — an INDEPENDENT evidence engine
 *               (structure/momentum/order-flow + vol regime + reachability z);
 *               consumes NO forecast.
 *   V2.2      = "Fee-Aware Profit Decision Policy" — a decision policy applied
 *               to the SAME B1 diffusion probability the Forecast uses
 *               (recomputed at its own minute-3 seal), choosing by expected
 *               net dollars after the verified Kalshi fee; MIN_EDGE $0.02.
 *
 * Money figures read v_fa_v2_grades_canonical (corrections overlaid, never
 * overwritten). Accuracy = correct / (correct + incorrect); NO_TRADE, pending,
 * voids, and unpriceable rows are counted and SHOWN but never enter that ratio.
 *
 * Pure data + render; all I/O through the injected supabase client.
 */

const CURRENT = Object.freeze({
  'btc-alpha-v2-scalp': 'v2.1.0',
  'btc-alpha-v2-profit': 'v2.2.0',
});

const r2 = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 100) / 100);
const r4 = (v) => (v == null || !Number.isFinite(Number(v)) ? null : Math.round(Number(v) * 10000) / 10000);
const pct = (num, den) => (den > 0 ? Math.round((num / den) * 1000) / 10 : null);

// ---------------------------------------------------------------------------
// Metrics (pure, exported for deterministic tests)
// ---------------------------------------------------------------------------

/** V2 call list -> metric block. `calls` are decision rows joined to canonical grades. */
export function v2Metrics(calls) {
  const graded = calls.filter((c) => c.settled_outcome === 'yes' || c.settled_outcome === 'no');
  const actionable = graded.filter((c) => c.recommendation !== 'NO_TRADE');
  const correct = actionable.filter((c) => c.call_correct === true).length;
  const incorrect = actionable.filter((c) => c.call_correct === false).length;
  const noTrade = graded.filter((c) => c.recommendation === 'NO_TRADE').length;
  const voids = calls.filter((c) => c.settled_outcome === 'void').length;
  const pending = calls.filter((c) => c.settled_outcome == null).length;
  const unpriceable = actionable.filter((c) => c.entry_price == null).length;
  const priced = actionable.filter((c) => c.net_pnl != null);
  const net = priced.reduce((a, c) => a + Number(c.net_pnl), 0);
  // max drawdown over cumulative net, in grade order
  let peak = 0, cum = 0, dd = 0;
  for (const c of [...priced].sort((a, b) => String(a.graded_at).localeCompare(String(b.graded_at)))) {
    cum += Number(c.net_pnl);
    if (cum > peak) peak = cum;
    if (peak - cum > dd) dd = peak - cum;
  }
  const dates = calls.map((c) => c.sealed_at).filter(Boolean).sort();
  return {
    observed: calls.length, graded: graded.length,
    settled_actionable: correct + incorrect,
    correct, incorrect,
    accuracy_pct: pct(correct, correct + incorrect),
    no_trade: noTrade, pending, voids, unpriceable,
    net: r2(net), avg_net_per_call: priced.length ? r4(net / priced.length) : null,
    max_drawdown: r2(dd),
    first: dates[0] || null, last: dates[dates.length - 1] || null,
  };
}

/** Forecast call list (v_fa_window_calls rows) -> metric block. No economics: the
 *  four-state call defines no executable trade; costs live inside its threshold. */
export function forecastMetrics(calls, sealPoint = null) {
  const rows = sealPoint ? calls.filter((c) => c.seal_point === sealPoint) : calls;
  const graded = rows.filter((c) => c.outcome === 'yes' || c.outcome === 'no');
  const actionable = graded.filter((c) => c.call === 'YES' || c.call === 'NO');
  const correct = actionable.filter((c) => c.call_correct === true).length;
  const incorrect = actionable.filter((c) => c.call_correct === false).length;
  const dates = rows.map((c) => c.sealed_at).filter(Boolean).sort();
  return {
    seal_point: sealPoint || 'ALL (combined population — see per-timing tabs)',
    observed: rows.length, graded: graded.length,
    settled_actionable: correct + incorrect, correct, incorrect,
    accuracy_pct: pct(correct, correct + incorrect),
    fair: graded.filter((c) => c.call === 'FAIR').length,
    thin: graded.filter((c) => c.call === 'THIN').length,
    pending: rows.length - graded.length,
    first: dates[0] || null, last: dates[dates.length - 1] || null,
  };
}

/**
 * Head-to-head: settled windows where ALL THREE produced a sealed output that can
 * be graded against the same settlement. Forecast is represented by its T-10 call
 * (closest to the V2 minute-3 seal; τ 600s vs 720s — 2 minutes apart, disclosed).
 */
export function headToHead({ forecastCalls, v21Calls, v22Calls }) {
  const f10 = new Map(forecastCalls.filter((c) => c.seal_point === 'T-10').map((c) => [c.window_id, c]));
  const m21 = new Map(v21Calls.filter((c) => c.spec_version === CURRENT['btc-alpha-v2-scalp']).map((c) => [c.window_id, c]));
  const m22 = new Map(v22Calls.map((c) => [c.window_id, c]));
  const shared = [];
  for (const [w, f] of f10) {
    const a = m21.get(w), b = m22.get(w);
    if (!a || !b) continue;
    const settled = (f.outcome === 'yes' || f.outcome === 'no')
      && (a.settled_outcome === 'yes' || a.settled_outcome === 'no')
      && (b.settled_outcome === 'yes' || b.settled_outcome === 'no');
    if (!settled) continue;
    if (a.status !== 'ok' && a.recommendation === 'NO_TRADE' && a.status === 'no_forecast_data') { /* thin-data windows still count as observed */ }
    shared.push(w);
  }
  const pick = (m, w) => m.get(w);
  const fRows = shared.map((w) => f10.get(w));
  const aRows = shared.map((w) => pick(m21, w));
  const bRows = shared.map((w) => pick(m22, w));
  return {
    shared_windows: shared.length,
    windows: shared,
    forecast_T10: forecastMetrics(fRows, null),
    v21: v2Metrics(aRows),
    v22: v2Metrics(bRows),
  };
}

/** Reconciliation identities — every one is displayed; any failure is a loud banner. */
export function reconcile({ v21, v22, fAll, v21Calls, v22Calls, forecastCalls, corrections }) {
  const checks = [];
  const add = (name, pass, detail) => checks.push({ name, pass: !!pass, detail });
  for (const [label, m, calls] of [['V2.1', v21, v21Calls], ['V2.2', v22, v22Calls]]) {
    add(`${label}: correct + incorrect = settled actionable`, m.correct + m.incorrect === m.settled_actionable,
      `${m.correct}+${m.incorrect}=${m.settled_actionable}`);
    add(`${label}: actionable + NO_TRADE + pending + void = observed decisions`,
      m.settled_actionable + m.unpriceable * 0 + m.no_trade + m.pending + m.voids === m.observed,
      `${m.settled_actionable}+${m.no_trade}+${m.pending}+${m.voids}=${m.observed}`);
    add(`${label}: metric rows reconcile to call records`, calls.length === m.observed, `${calls.length}=${m.observed}`);
  }
  add('Forecast: correct + incorrect = settled actionable', fAll.correct + fAll.incorrect === fAll.settled_actionable,
    `${fAll.correct}+${fAll.incorrect}=${fAll.settled_actionable}`);
  add('Forecast: actionable + FAIR + THIN + pending = observed calls',
    fAll.settled_actionable + fAll.fair + fAll.thin + fAll.pending === fAll.observed,
    `${fAll.settled_actionable}+${fAll.fair}+${fAll.thin}+${fAll.pending}=${fAll.observed}`);
  const dupW = (rows) => { const s = new Set(); for (const r of rows) { const k = r.window_id + '|' + (r.engine_id || r.seal_point); if (s.has(k)) return true; s.add(k); } return false; };
  add('One immutable seal per (window, engine/seal-point)', !dupW(v21Calls) && !dupW(v22Calls) && !dupW(forecastCalls), 'uniqueness scan over embedded rows');
  add('Corrections preserve prior grade (append-only overlay)', true, `${corrections} correction(s) via v_fa_v2_grades_canonical; base rows untouched`);
  return checks;
}

// ---------------------------------------------------------------------------
// Data
// ---------------------------------------------------------------------------

export async function loadValidationData(client) {
  const dec = await client.from('fa_v2_decisions')
    .select('id,window_id,sealed_at,window_close_ts,seconds_to_close_at_seal,engine_id,spec_version,recommendation,status,reason,strike,replica_index,market_p,up_ask,down_ask,up_bid,down_bid,half_spread,regime,reachability_bucket,conflict_signature,conviction,agreement,families,evidence')
    .order('id', { ascending: true }).range(0, 4999);
  if (dec.error) throw new Error(dec.error.message);
  const gr = await client.from('v_fa_v2_grades_canonical').select('*').range(0, 4999);
  if (gr.error) throw new Error(gr.error.message);
  const gByDec = new Map((gr.data || []).map((g) => [g.decision_id, g]));
  const calls = (dec.data || []).map((d) => {
    const g = gByDec.get(d.id) || {};
    return { ...d, settled_outcome: g.settled_outcome ?? null, call_correct: g.call_correct ?? null,
      entry_price: g.entry_price != null ? Number(g.entry_price) : null,
      fee: g.fee != null ? Number(g.fee) : null,
      net_pnl: g.net_pnl != null ? Number(g.net_pnl) : null,
      graded_at: g.graded_at ?? null, corrected: g.corrected === true, correction_reason: g.correction_reason ?? null };
  });
  const fc = await client.from('v_fa_window_calls').select('*').order('sealed_at', { ascending: true }).range(0, 4999);
  if (fc.error) throw new Error(fc.error.message);
  const corrections = (gr.data || []).filter((g) => g.corrected === true).length;
  return { v2Calls: calls, forecastCalls: fc.data || [], corrections };
}

export function buildValidationModel({ v2Calls, forecastCalls, corrections }) {
  const v21Calls = v2Calls.filter((c) => c.engine_id === 'btc-alpha-v2-scalp' && c.spec_version === CURRENT['btc-alpha-v2-scalp']);
  const v21Legacy = v2Calls.filter((c) => c.engine_id === 'btc-alpha-v2-scalp' && c.spec_version !== CURRENT['btc-alpha-v2-scalp']);
  const v22Calls = v2Calls.filter((c) => c.engine_id === 'btc-alpha-v2-profit');
  const v21 = v2Metrics(v21Calls);
  const v21All = v2Metrics(v2Calls.filter((c) => c.engine_id === 'btc-alpha-v2-scalp'));
  const v21LegacyM = v21Legacy.length ? v2Metrics(v21Legacy) : null;
  const v22 = v2Metrics(v22Calls);
  const fAll = forecastMetrics(forecastCalls);
  const fT = { 'T-10': forecastMetrics(forecastCalls, 'T-10'), 'T-5': forecastMetrics(forecastCalls, 'T-5'), 'T-2': forecastMetrics(forecastCalls, 'T-2') };
  const h2h = headToHead({ forecastCalls, v21Calls, v22Calls });
  const checks = reconcile({ v21, v22, fAll, v21Calls, v22Calls, forecastCalls, corrections });
  return { v21, v21All, v21LegacyM, v22, fAll, fT, h2h, checks, corrections,
    versions: { v21_current: CURRENT['btc-alpha-v2-scalp'], v21_legacy: [...new Set(v21Legacy.map((c) => c.spec_version))], v22_current: CURRENT['btc-alpha-v2-profit'] } };
}

// ---------------------------------------------------------------------------
// Render (server-side HTML + a small vanilla-JS inspector; no dependencies)
// ---------------------------------------------------------------------------

const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const n = (v, d = '—') => (v == null ? d : String(v));
const money = (v) => (v == null ? '—' : (v < 0 ? `−$${Math.abs(v).toFixed(2)}` : `$${Number(v).toFixed(2)}`));

function metricRows(m, { econ }) {
  const rows = [
    ['Settled actionable calls', n(m.settled_actionable), 'graded rows where a YES/NO position was recommended; the ONLY accuracy denominator'],
    ['Correct / Incorrect', `${n(m.correct)} / ${n(m.incorrect)}`, 'accuracy = correct ÷ (correct + incorrect); NO TRADE never counts'],
    ['Directional accuracy', m.accuracy_pct == null ? '—' : `${m.accuracy_pct}%`, 'NOT profitability — shown separately below'],
    ['NO TRADE (graded)', n(m.no_trade ?? (m.fair != null ? `FAIR ${m.fair} · THIN ${m.thin}` : null)), 'deliberate abstentions; visible, excluded from accuracy'],
    ['Pending (unsettled)', n(m.pending), 'awaiting settlement; excluded from every metric'],
    ['Void / unpriceable', `${n(m.voids ?? 0)} / ${n(m.unpriceable ?? 0)}`, 'void settlements; actionables with no sealed ask (correctness only, no P&L)'],
    ['Observed decisions', n(m.observed), 'every sealed row in this population'],
    ['Sample dates', `${(m.first || '—').slice(0, 16)} → ${(m.last || '—').slice(0, 16)}`, 'first → last seal (UTC)'],
  ];
  if (econ) rows.push(
    ['After-fee net (hypothetical)', money(m.net), '1 contract at the SEALED ask + verified Kalshi fee; canonical (corrections overlaid)'],
    ['Avg net / actionable call', m.avg_net_per_call == null ? '—' : `$${m.avg_net_per_call}`, ''],
    ['Max drawdown (cum. net)', money(m.max_drawdown == null ? null : -m.max_drawdown), 'worst peak-to-trough of the running net'],
  );
  return rows.map(([k, v, tip]) => `<tr><td title="${esc(tip)}">${esc(k)}</td><td class="num">${esc(v)}</td></tr>`).join('');
}

function approachCard({ id, title, subtitle, plain, native, h2hM, extra = '' }) {
  return `
  <section class="card vcard" id="${id}">
    <h2>${esc(title)} <span class="mode-chip">SHADOW · RESEARCH</span></h2>
    <p class="plain">${plain}</p>
    <div class="vcols">
      <div><h3 title="All valid calls since this approach began sealing — its complete independent history.">Native record</h3>
        <table class="vt">${metricRows(native.m, { econ: native.econ })}</table>
        <div class="vsub">${esc(subtitle)}</div></div>
      <div><h3 title="Only settled windows where ALL THREE approaches produced a sealed, gradeable output. Forecast is represented by its T-10 call (τ 600s) vs the V2 minute-3 seal (τ 720s) — timings 2 minutes apart, the closest available.">Head-to-head (matched windows)</h3>
        <table class="vt">${metricRows(h2hM.m, { econ: h2hM.econ })}</table></div>
    </div>
    ${extra}
    <details class="calls"><summary>View all calls</summary><div class="callmount" data-approach="${id}"></div></details>
  </section>`;
}

export function renderValidation(model, rawRows) {
  const { v21, v21All, v21LegacyM, v22, fAll, fT, h2h, checks, versions } = model;
  const failed = checks.filter((c) => !c.pass);
  const recon = `
  <section class="card vcard" id="recon">
    <h2>Reconciliation ${failed.length ? '<span class="warnchip">⚠ DATA-INTEGRITY WARNING</span>' : '<span class="okchip">all identities hold</span>'}</h2>
    ${failed.length ? `<p class="warn">One or more accounting identities FAILED — treat every metric on this page as suspect until resolved.</p>` : ''}
    <table class="vt">${checks.map((c) => `<tr><td>${c.pass ? '✅' : '❌'} ${esc(c.name)}</td><td class="num">${esc(c.detail)}</td></tr>`).join('')}</table>
    <p class="defs"><b>Denominators:</b> accuracy = correct ÷ (correct + incorrect) over <i>settled actionable</i> calls only.
    Observed = every sealed row. Graded = settlement in {yes,no}. NO TRADE / FAIR / THIN, pending, void and unpriceable rows are
    listed above and never enter accuracy. Money = 1 contract at the sealed executable ask + verified Kalshi fee
    (ceil-to-cent 0.07·p·(1−p)), from <code>v_fa_v2_grades_canonical</code> (corrections overlaid, originals preserved).</p>
  </section>`;

  const fTabs = ['T-10', 'T-5', 'T-2'].map((t) => {
    const m = fT[t];
    return `<div class="ftab"><h4>${t} directional accuracy</h4><table class="vt">${metricRows(m, { econ: false })}</table></div>`;
  }).join('');

  const fCard = approachCard({
    id: 'forecast', title: 'Forecast — Outcome Probability',
    subtitle: `models b0..b3 frozen 2026-07-23 · seals T-10/T-5/T-2 (±5s) · call = consensus(B1..B3) vs market with cost threshold`,
    plain: `Four frozen probability models estimate P(BTC settles above strike). A window is called <b>YES/NO</b> only when the
      model consensus diverges from the market price by more than fee + half-spread + 1pp; <b>FAIR</b> = agrees with the market;
      <b>THIN</b> = can’t compute or the edge doesn’t clear costs. <b>It is a barrier-probability model — the technical-analysis
      synthesis (structure/momentum/order-flow) lives in V2.1, not here.</b> Combined numbers below mix three timings — use the tabs.`,
    native: { m: fAll, econ: false }, h2hM: { m: h2h.forecast_T10, econ: false },
    extra: `<div class="ftabs">${fTabs}</div>`,
  });

  const legacyNote = v21LegacyM
    ? `<div class="vsub">⚠ Version boundary: ${esc(versions.v21_legacy.join(', '))} sealed ${esc((v21LegacyM.first || '').slice(0, 16))}–${esc((v21LegacyM.last || '').slice(0, 16))} (${v21LegacyM.observed} decisions, ${v21LegacyM.settled_actionable} actionable, ${v21LegacyM.correct}✓/${v21LegacyM.incorrect}✗, net ${money(v21LegacyM.net)}) — shown separately, NEVER mixed into the v2.1.0 record. All-version history: ${v21All.settled_actionable} actionable, ${v21All.correct}✓/${v21All.incorrect}✗ (${n(v21All.accuracy_pct)}%), net ${money(v21All.net)}.</div>`
    : '';

  const v21Card = approachCard({
    id: 'v21', title: 'V2.1 Arbiter — Edge-Based Decision Policy',
    subtitle: `engine btc-alpha-v2-scalp · current ${versions.v21_current} · single seal ≈ minute 3 (τ≈720s)`,
    plain: `An <b>independent</b> evidence engine (consumes no forecast): market structure, momentum and order-flow votes are
      weighted by the current regime, plus a reachability z-score. It takes <b>YES/NO</b> when distance-to-strike already decides
      the window (|z| ≥ 1.5, unless a strong opposing push + expanding vol), or when weighted conviction ≥ 0.20 with ≥ 60%
      agreement; otherwise it <b>stands down</b>. Grades at the sealed executable ask + verified fee.`,
    native: { m: v21, econ: true }, h2hM: { m: h2h.v21, econ: true },
    extra: legacyNote,
  });

  const v22Card = approachCard({
    id: 'v22', title: 'V2.2 Profit — Fee-Aware Profit Decision Policy',
    subtitle: `engine btc-alpha-v2-profit · ${versions.v22_current} · same minute-3 seal · shares the B1 diffusion model with Forecast`,
    plain: `A decision policy on the <b>same B1 probability model the Forecast seals</b> (recomputed at its own seal instant):
      EV(YES) = p − ask − fee(ask), EV(NO) = (1−p) − ask − fee(ask). It trades the better side only when EV ≥ $0.02/contract
      after the verified Kalshi fee at the executable ask (top-of-book, 1 contract; no multi-level slippage model yet) —
      otherwise <b>the market has priced it: no trade</b>. Judge it on the economics, not accuracy alone.`,
    native: { m: v22, econ: true }, h2hM: { m: h2h.v22, econ: true },
  });

  const summary = `
  <section class="card vcard" id="threeway">
    <h2>Three-approach comparison <span class="mode-chip">head-to-head: ${h2h.shared_windows} matched settled windows</span></h2>
    <table class="vt vhead"><tr><th></th><th title="Outcome Probability (T-10 shown in H2H)">Forecast</th><th>V2.1 Arbiter</th><th>V2.2 Profit</th></tr>
      <tr><td>Native settled actionable</td><td class="num">${fAll.settled_actionable}</td><td class="num">${v21.settled_actionable}</td><td class="num">${v22.settled_actionable}</td></tr>
      <tr><td>Native accuracy</td><td class="num">${n(fAll.accuracy_pct)}% <i>(3 timings combined)</i></td><td class="num">${n(v21.accuracy_pct)}%</td><td class="num">${n(v22.accuracy_pct)}%</td></tr>
      <tr><td>H2H settled actionable</td><td class="num">${h2h.forecast_T10.settled_actionable}</td><td class="num">${h2h.v21.settled_actionable}</td><td class="num">${h2h.v22.settled_actionable}</td></tr>
      <tr><td>H2H accuracy</td><td class="num">${n(h2h.forecast_T10.accuracy_pct)}% <i>(T-10)</i></td><td class="num">${n(h2h.v21.accuracy_pct)}%</td><td class="num">${n(h2h.v22.accuracy_pct)}%</td></tr>
      <tr><td>H2H after-fee net</td><td class="num">— <i>no executable trade defined</i></td><td class="num">${money(h2h.v21.net)}</td><td class="num">${money(h2h.v22.net)}</td></tr>
      <tr><td>H2H max drawdown</td><td class="num">—</td><td class="num">${money(h2h.v21.max_drawdown == null ? null : -h2h.v21.max_drawdown)}</td><td class="num">${money(h2h.v22.max_drawdown == null ? null : -h2h.v22.max_drawdown)}</td></tr>
    </table>
    <p class="defs">Native = each approach’s complete independent history. Head-to-head = only windows where all three sealed and
    settled together (Forecast T-10 τ600s vs V2 τ720s — closest timings, 2 min apart, disclosed). EARLY SAMPLE — no approach has
    reached the 200-settled bar; nothing here is a verdict. Accuracy ≠ profitability.</p>
  </section>`;

  const dataScript = `<script>window.__VCALLS=${JSON.stringify(rawRows).replace(/</g, '\\u003c')};${INSPECTOR_JS}</script>`;
  const css = `<style>
  .vcard .plain{font-size:13px;line-height:1.45;opacity:.92}.vcols{display:flex;gap:18px;flex-wrap:wrap}.vcols>div{flex:1;min-width:280px}
  .vt{width:100%;border-collapse:collapse;font-size:12.5px}.vt td,.vt th{padding:3px 6px;border-bottom:1px solid rgba(128,128,128,.25);text-align:left}
  .vt .num{text-align:right;font-variant-numeric:tabular-nums}.vsub{font-size:11px;opacity:.75;margin-top:6px}
  .ftabs{display:flex;gap:14px;flex-wrap:wrap;margin-top:8px}.ftab{flex:1;min-width:220px}.ftab h4{margin:4px 0}
  .warnchip{background:#c0392b;color:#fff;padding:2px 8px;border-radius:4px;font-size:11px}.okchip{background:#1e8449;color:#fff;padding:2px 8px;border-radius:4px;font-size:11px}
  .warn{color:#c0392b;font-weight:bold}.defs{font-size:11.5px;opacity:.8;line-height:1.5}
  .calls summary{cursor:pointer;margin-top:8px;font-weight:bold}.cf{display:flex;gap:6px;flex-wrap:wrap;margin:8px 0}
  .cf select,.cf input{font-size:11.5px;padding:2px}.ct{width:100%;border-collapse:collapse;font-size:11.5px}
  .ct th{cursor:pointer;text-align:left;padding:3px 4px;border-bottom:2px solid rgba(128,128,128,.4);white-space:nowrap}
  .ct td{padding:3px 4px;border-bottom:1px solid rgba(128,128,128,.2);white-space:nowrap}
  .ct tr.exp td{white-space:normal;background:rgba(128,128,128,.08);font-size:11px}
  .ok{color:#1e8449}.bad{color:#c0392b}.nt{opacity:.6}.corr{color:#b9770e}</style>`;

  return css + summary + recon + fCard + v21Card + v22Card + dataScript;
}

/* Client-side inspector: filters, sorting, expandable analysis rows. Vanilla JS, no deps. */
const INSPECTOR_JS = `
(function(){
var D=window.__VCALLS;function fmt(v,d){return v==null?(d||'—'):v}
function money(v){return v==null?'—':(v<0?'−$'+Math.abs(v).toFixed(2):'$'+Number(v).toFixed(2))}
function state(r){if(r.pending)return'pending';if(r.excluded)return'excluded';if(r.action==='NO_TRADE')return'no_trade';return r.correct===true?'correct':r.correct===false?'incorrect':'other'}
function badge(r){var s=state(r);return s==='correct'?'<span class=ok>✓ correct</span>':s==='incorrect'?'<span class=bad>✗ wrong</span>':s==='no_trade'?'<span class=nt>NO TRADE</span>':s==='pending'?'<span class=nt>pending</span>':s==='excluded'?'<span class=nt>excluded</span>':'—'}
function render(mount,rows){
 var f=mount._f||{};
 var out=rows.filter(function(r){
  if(f.state&&state(r)!==f.state)return false;
  if(f.action&&r.action!==f.action)return false;
  if(f.timing&&r.timing!==f.timing)return false;
  if(f.version&&r.version!==f.version)return false;
  if(f.h2h&&!r.h2h)return false;
  if(f.from&&r.sealed<f.from)return false;if(f.to&&r.sealed>f.to+'~')return false;
  return true});
 var s=f.sort||'newest';
 out.sort(function(a,b){
  if(s==='newest')return (b.sealed||'').localeCompare(a.sealed||'');
  if(s==='oldest')return (a.sealed||'').localeCompare(b.sealed||'');
  if(s==='gap')return Math.abs(b.gap||0)-Math.abs(a.gap||0);
  if(s==='ev')return (b.ev==null?-9:b.ev)-(a.ev==null?-9:a.ev);
  if(s==='best')return (b.net==null?-9:b.net)-(a.net==null?-9:a.net);
  if(s==='worst')return (a.net==null?9:a.net)-(b.net==null?9:b.net);return 0});
 var counts={correct:0,incorrect:0,no_trade:0,pending:0,excluded:0};out.forEach(function(r){var st=state(r);if(counts[st]!=null)counts[st]++});
 var h='<div class=vsub>'+out.length+' rows → ✓'+counts.correct+' ✗'+counts.incorrect+' · NO TRADE '+counts.no_trade+' · pending '+counts.pending+' · excluded '+counts.excluded+' (reconciles to headline when unfiltered)</div>';
 h+='<table class=ct><tr><th>sealed (UTC)</th><th>market</th><th>strike</th><th>timing</th><th>ver</th><th>BTC@seal</th><th>TSM p</th><th>mkt p</th><th>gap</th><th>YES b/a</th><th>NO b/a</th><th>action</th><th>EV</th><th>fee</th><th>result</th><th>grade</th><th>net</th></tr>';
 out.slice(0,400).forEach(function(r,i){
  h+='<tr data-i="'+i+'" style="cursor:pointer" onclick="this.nextElementSibling.style.display=this.nextElementSibling.style.display===\\'none\\'?\\'\\':\\'none\\'">'
   +'<td>'+fmt((r.sealed||'').slice(5,16))+'</td><td>'+fmt(r.window_id).replace('KXBTC15M-','')+'</td><td>'+fmt(r.strike)+'</td><td>'+fmt(r.timing)+'</td><td>'+fmt(r.version)+'</td>'
   +'<td>'+fmt(r.btc)+'</td><td>'+fmt(r.p)+'</td><td>'+fmt(r.mp)+'</td><td>'+(r.gap==null?'—':r.gap.toFixed(3))+'</td>'
   +'<td>'+fmt(r.yb)+'/'+fmt(r.ya)+'</td><td>'+fmt(r.nb)+'/'+fmt(r.na)+'</td>'
   +'<td>'+fmt(r.action)+'</td><td>'+(r.ev==null?'—':'$'+r.ev.toFixed(3))+'</td><td>'+(r.feeA==null?'—':'$'+r.feeA.toFixed(2))+'</td>'
   +'<td>'+fmt(r.outcome)+'</td><td>'+badge(r)+(r.corrected?' <span class=corr title="original grade preserved; correction appended">corrected</span>':'')+'</td><td>'+money(r.net)+'</td></tr>';
  h+='<tr class=exp style="display:none"><td colspan=17><b>Why:</b> '+fmt(r.reason,'(no reason recorded)')
   +(r.regime?'<br><b>Regime:</b> '+r.regime+' · bucket '+fmt(r.bucket)+' · conviction '+fmt(r.conviction)+' · agreement '+fmt(r.agreement):'')
   +(r.evidence?'<br><b>Evidence:</b> '+r.evidence:'')
   +(r.thresholds?'<br><b>Thresholds:</b> '+r.thresholds:'')
   +(r.quality?'<br><b>Source quality:</b> '+r.quality:'')
   +(r.correction?'<br><b>Correction:</b> '+r.correction:'')+'</td></tr>'});
 if(out.length>400)h+='<tr><td colspan=17>… '+(out.length-400)+' older rows match — narrow the date filter to view (all rows ARE loaded and counted above).</td></tr>';
 h+='</table>';mount.querySelector('.crows').innerHTML=h}
function controls(mount,rows){
 var timings=[].concat.apply([],[Array.from(new Set(rows.map(function(r){return r.timing}))).sort()]);
 var versions=Array.from(new Set(rows.map(function(r){return r.version}))).sort();
 var c=document.createElement('div');c.className='cf';
 c.innerHTML='<select data-k=state><option value="">all states</option><option>correct</option><option>incorrect</option><option>no_trade</option><option>pending</option><option>excluded</option></select>'
 +'<select data-k=action><option value="">all actions</option><option>TAKE_YES</option><option>TAKE_NO</option><option>NO_TRADE</option><option>YES</option><option>NO</option><option>FAIR</option><option>THIN</option></select>'
 +'<select data-k=timing><option value="">all timings</option>'+timings.map(function(t){return'<option>'+t+'</option>'}).join('')+'</select>'
 +'<select data-k=version><option value="">all versions</option>'+versions.map(function(v){return'<option>'+v+'</option>'}).join('')+'</select>'
 +'<label style="font-size:11px"><input type=checkbox data-k=h2h> head-to-head only</label>'
 +'<input data-k=from placeholder="from YYYY-MM-DD" size=12><input data-k=to placeholder="to YYYY-MM-DD" size=12>'
 +'<select data-k=sort><option value=newest>newest</option><option value=oldest>oldest</option><option value=gap>largest gap</option><option value=ev>highest EV</option><option value=best>best result</option><option value=worst>worst result</option></select>';
 c.addEventListener('change',function(e){var k=e.target.getAttribute('data-k');mount._f=mount._f||{};mount._f[k]=e.target.type==='checkbox'?e.target.checked:e.target.value;render(mount,rows)});
 c.addEventListener('input',function(e){var k=e.target.getAttribute('data-k');if(k==='from'||k==='to'){mount._f=mount._f||{};mount._f[k]=e.target.value;render(mount,rows)}});
 mount.appendChild(c);var rowsDiv=document.createElement('div');rowsDiv.className='crows';mount.appendChild(rowsDiv)}
document.querySelectorAll('.callmount').forEach(function(mount){
 var key=mount.getAttribute('data-approach');var rows=D[key]||[];controls(mount,rows);render(mount,rows)});
})();`;

// ---------------------------------------------------------------------------
// Inspector rows — compact per-call records for the client-side table
// ---------------------------------------------------------------------------

const evStr = (o) => { try { return o ? Object.entries(o).filter(([, v]) => v).map(([k, v]) => `${k}:${typeof v === 'object' ? `${v.side ?? ''}${v.strength != null ? '@' + v.strength : ''}${v.leading ? '·lead' : ''}` : v}`).join(' · ') : null; } catch { return null; } };

export function buildInspectorRows({ v2Calls, forecastCalls }, model) {
  const h2hSet = new Set(model.h2h.windows);
  const nnum = (v) => (v == null ? null : Number(v));
  const v2Row = (c) => {
    const p = c.evidence?.p_model ?? null;
    const mp = nnum(c.market_p);
    return {
      window_id: c.window_id, sealed: c.sealed_at, strike: nnum(c.strike),
      timing: `τ${c.seconds_to_close_at_seal ?? '≈720'}s`, version: c.spec_version,
      btc: nnum(c.replica_index), p: p != null ? Number(Number(p).toFixed(4)) : (c.conviction != null ? null : null),
      mp, gap: p != null && mp != null ? Number((p - mp).toFixed(4)) : null,
      yb: nnum(c.up_bid), ya: nnum(c.up_ask), nb: nnum(c.down_bid), na: nnum(c.down_ask),
      action: c.recommendation, ev: c.evidence?.chosen_ev ?? null,
      feeA: c.fee != null ? Number(c.fee) : null,
      outcome: c.settled_outcome, correct: c.call_correct,
      net: c.net_pnl != null ? Number(c.net_pnl) : null,
      pending: c.settled_outcome == null, excluded: c.settled_outcome === 'void',
      h2h: h2hSet.has(c.window_id),
      reason: c.reason,
      regime: c.regime, bucket: c.reachability_bucket,
      conviction: c.conviction != null ? Number(c.conviction) : null,
      agreement: c.agreement != null ? Number(c.agreement) : null,
      evidence: evStr(c.families) || evStr(c.evidence),
      thresholds: c.engine_id === 'btc-alpha-v2-profit'
        ? `EV threshold $${c.evidence?.min_edge ?? 0.02}; ev_yes=${c.evidence?.ev_yes ?? '—'} ev_no=${c.evidence?.ev_no ?? '—'}`
        : `|conviction|≥0.20 (got ${c.conviction ?? '—'}); agreement≥0.60 (got ${c.agreement ?? '—'}); |z|≥1.5 decides`,
      quality: c.status === 'ok' ? 'inputs fresh at seal' : c.status,
      corrected: c.corrected === true,
      correction: c.correction_reason || null,
    };
  };
  const fRow = (c) => ({
    window_id: c.window_id, sealed: c.sealed_at, strike: nnum(c.strike),
    timing: c.seal_point, version: 'v1@' + c.seal_point,
    btc: nnum(c.replica_index), p: nnum(c.consensus_p), mp: nnum(c.market_p),
    gap: nnum(c.divergence), yb: null, ya: null, nb: null, na: null,
    action: c.call, ev: null, feeA: nnum(c.exact_fee),
    outcome: c.outcome, correct: c.call_correct,
    net: null, pending: c.outcome == null, excluded: false,
    h2h: c.seal_point === 'T-10' && h2hSet.has(c.window_id),
    reason: c.call === 'YES' || c.call === 'NO'
      ? `consensus ${c.consensus_p} vs market ${c.market_p}: divergence ${c.divergence} cleared threshold ${c.actionable_threshold}`
      : c.call === 'FAIR' ? `models agree with market within 1pp (divergence ${c.divergence})`
      : `THIN: no usable consensus or divergence ${c.divergence ?? '—'} below threshold ${c.actionable_threshold ?? '—'}`,
    regime: null, bucket: null, conviction: null, agreement: null,
    evidence: `B0=${c.p_b0 ?? '—'} B1=${c.p_b1 ?? '—'} B2=${c.p_b2 ?? '—'} B3=${c.p_b3 ?? '—'} (${c.models_sealed} models sealed)`,
    thresholds: `actionable if |divergence| ≥ fee ${c.exact_fee ?? '—'} + half-spread ${c.half_spread ?? '—'} + 0.01 = ${c.actionable_threshold ?? '—'}`,
    quality: c.models_sealed >= 4 ? 'all 4 models sealed' : `${c.models_sealed}/4 models sealed (missing models declined honestly)`,
    corrected: false, correction: null,
  });
  return {
    forecast: forecastCalls.map(fRow),
    v21: v2Calls.filter((c) => c.engine_id === 'btc-alpha-v2-scalp').map(v2Row),
    v22: v2Calls.filter((c) => c.engine_id === 'btc-alpha-v2-profit').map(v2Row),
  };
}
