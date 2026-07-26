/**
 * v2.4 FOUNDER TECHNICAL — dashboard module (execution lock §G/§I/§K, 2026-07-26).
 * Primary hierarchy: (1) current recommendation, (2) success rate + call history
 * with expandable per-market revision timelines, (3) comparison vs prior engines.
 * Every percentage carries numerator/denominator. WAIT and NO_TRADE are never
 * counted as incorrect directional calls. No revision is hidden after the fact.
 */

import { instructionFor, manageMarket, PM_POLICY_VERSION } from './v2/technical/position-manager.js';

// Managed-trade OFFICIAL record starts prospectively at the position-manager
// registration (experiment btc-v24-position-manager-e1). Earlier markets are
// DIAGNOSTIC REPLAY only and labeled as such.
export const PM_POLICY_START = '2026-07-26T17:45:00Z';

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const num = (v) => (v == null ? null : Number(v));

export async function loadV24Data(client) {
  const out = { revisions: [], grades: [], officials: [], errors: {} };
  const rev = await client.from('fa_v24_revisions')
    .select('window_id,revision_seq,evaluated_at,tau_sec,spot,strike,up_ask,down_ask,recommendation,conviction,p_above,entry_limit,side_ev_usd,reason,waiting_for,controlling_evidence,invalidation,change_reason,data_status,missed_refreshes,window_close_ts')
    .order('evaluated_at', { ascending: false }).limit(600);
  if (rev.error) out.errors.v24_revisions = rev.error.message; else out.revisions = rev.data ?? [];
  const off = await client.from('fa_v2_decisions')
    .select('window_id,recommendation,sealed_at,up_ask,down_ask,evidence')
    .eq('engine_id', 'btc-alpha-v24-technical')
    .order('sealed_at', { ascending: false }).limit(300);
  if (off.error) out.errors.v24_officials = off.error.message; else out.officials = off.data ?? [];

  const gr = await client.from('fa_v2_grades')
    .select('window_id,engine_id,recommendation,settled_outcome,call_correct,entry_price,fee,net_pnl,graded_at')
    .eq('engine_id', 'btc-alpha-v24-technical')
    .order('graded_at', { ascending: true }).limit(1000);
  if (gr.error) out.errors.v24_grades = gr.error.message; else out.grades = gr.data ?? [];
  return out;
}

/** Success metrics over graded official calls + revision abstention counts. */
export function v24Metrics({ grades = [], revisions = [], sinceMs = null, nowMs = null } = {}) {
  const inWin = (iso) => sinceMs == null || (iso && Date.parse(iso) >= (nowMs ?? Date.now()) - sinceMs);
  const g = grades.filter((x) => inWin(x.graded_at));
  const settled = g.filter((x) => x.settled_outcome === 'yes' || x.settled_outcome === 'no');
  const correct = settled.filter((x) => x.call_correct === true).length;
  const incorrect = settled.filter((x) => x.call_correct === false).length;
  const yes = settled.filter((x) => x.recommendation === 'TAKE_YES');
  const no = settled.filter((x) => x.recommendation === 'TAKE_NO');
  const nets = settled.map((x) => num(x.net_pnl)).filter((v) => v != null);
  let cum = 0, peak = 0, dd = 0; for (const n of nets) { cum += n; peak = Math.max(peak, cum); dd = Math.max(dd, peak - cum); }
  let streak = 0; for (let i = settled.length - 1; i >= 0; i--) { const c = settled[i].call_correct; if (c == null) continue; if (streak === 0) streak = c ? 1 : -1; else if ((streak > 0) === c) streak += c ? 1 : -1; else break; }
  const revs = revisions.filter((r) => inWin(r.evaluated_at));
  const byWindow = new Map(); for (const r of revs) { if (!byWindow.has(r.window_id)) byWindow.set(r.window_id, []); byWindow.get(r.window_id).push(r); }
  const waits = revs.filter((r) => r.recommendation === 'WAIT').length;
  const noTrades = revs.filter((r) => r.recommendation === 'NO_TRADE').length;
  const pct = (a, b) => (b > 0 ? Number(((a / b) * 100).toFixed(1)) : null);
  return {
    resolved: settled.length, correct, incorrect,
    unresolved: g.length - settled.length,
    accuracy_pct: pct(correct, correct + incorrect), accuracy_n: correct + incorrect,
    yes_correct: yes.filter((x) => x.call_correct).length, yes_n: yes.length,
    no_correct: no.filter((x) => x.call_correct).length, no_n: no.length,
    wait_revisions: waits, no_trade_revisions: noTrades, revision_count: revs.length,
    markets_covered: byWindow.size,
    decision_rate_pct: pct(settled.length, byWindow.size || settled.length),
    net_usd: Number(nets.reduce((a, b) => a + b, 0).toFixed(2)),
    avg_net_per_call: settled.length ? Number((nets.reduce((a, b) => a + b, 0) / settled.length).toFixed(3)) : null,
    max_drawdown_usd: Number(dd.toFixed(2)),
    streak,
  };
}

/** Group revisions into per-market timelines (ascending), newest markets first. */
export function v24Timelines(revisions, limitMarkets = 8) {
  const byWindow = new Map();
  for (const r of revisions) { if (!byWindow.has(r.window_id)) byWindow.set(r.window_id, []); byWindow.get(r.window_id).push(r); }
  const markets = [...byWindow.entries()].map(([wid, revs]) => ({
    window_id: wid,
    revs: [...revs].sort((a, b) => a.revision_seq - b.revision_seq),
    latest: revs.reduce((a, b) => (a.revision_seq >= b.revision_seq ? a : b)),
  })).sort((a, b) => Date.parse(b.latest.evaluated_at) - Date.parse(a.latest.evaluated_at));
  return markets.slice(0, limitMarkets);
}

const fmtT = (iso) => { try { return new Date(iso).toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit', second: '2-digit' }); } catch { return iso; } };
const fmtHM = (iso) => { try { return new Date(iso).toLocaleTimeString('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: '2-digit' }); } catch { return iso; } };
const badge = (rec) => `<span class="v24b v24b-${esc(rec)}">${esc(String(rec).replace(/_/g, ' '))}</span>`;
const frac = (label, a, b, extra = '') => b > 0 ? `${label}: <b>${((a / b) * 100).toFixed(1)}%</b> — ${a} of ${b}${extra}` : `${label}: <b>—</b> (0 samples)`;
const convictionWord = (c) => c == null ? '—' : c < 0.3 ? `Low (${Math.round(c * 100)}%)` : c < 0.6 ? `Moderate (${Math.round(c * 100)}%)` : `High (${Math.round(c * 100)}%)`;
// Human window label: "10:45–11:00 AM PT" from close_ts (15-minute markets).
function humanWindow(closeTs) {
  if (!closeTs) return null;
  const close = Date.parse(closeTs);
  return `${fmtHM(new Date(close - 15 * 60e3).toISOString())}–${fmtHM(closeTs)} PT`;
}
// Guided WHY generated from REAL scored features — never prose-invented evidence (§4).
function guidedWhy(rev) {
  const f = rev.features ?? {};
  const bits = [];
  const dist = rev.distance_usd != null ? Math.abs(Math.round(rev.distance_usd)) : null;
  if (rev.spot != null && rev.strike != null) bits.push(`BTC is $${dist} ${rev.spot >= rev.strike ? 'above' : 'below'} the strike`);
  const t = f.trend ?? {};
  if (t.m15 === 'up' || t.m15 === 'down') bits.push(`the 15-minute trend points ${t.m15}`);
  if (f.continuity?.state === 'full_up') bits.push('all short timeframes agree upward');
  if (f.continuity?.state === 'full_down') bits.push('all short timeframes agree downward');
  const sweep = f.structure_1m?.sweep;
  if (sweep) bits.push(sweep.side === 'buyside_swept' ? 'price poked above a key level and was rejected' : 'price dipped below a key level and snapped back');
  const ev5 = f.structure_5m?.event;
  if (ev5) bits.push(`${ev5.type === 'BOS_up' ? 'buyers' : 'sellers'} broke the 5-minute structure${f.structure_5m?.displacement ? ' with force' : ''}`);
  const lead = bits.length ? bits.join('; ') : 'no single technical driver dominates';
  let tail;
  if (rev.recommendation === 'WAIT') tail = rev.waiting_for ? `The setup is not enterable yet: waiting for ${rev.waiting_for}.` : 'Confirmation is still required before entering.';
  else if (rev.recommendation === 'NO_TRADE') tail = 'The evidence does not justify a position right now.';
  else tail = `The ${rev.recommendation} side is supported and the price is acceptable at ${rev.entry_limit != null ? Math.round(rev.entry_limit * 100) + '¢ or less' : 'the stated limit'}.`;
  return lead.charAt(0).toUpperCase() + lead.slice(1) + '. ' + tail;
}
// Technical summary rows from real feature fields only (§4); unavailable families labeled.
function technicalSummary(rev) {
  const f = rev.features ?? {};
  const rows = [];
  const seq = f.strat?.m5?.sequence?.join(' ');
  if (seq) rows.push(['5-minute STRAT sequence', seq + (f.strat?.m5?.signals?.length ? ' → ' + f.strat.m5.signals.map((x) => x.name).join(', ') : '')]);
  if (f.continuity?.state) rows.push(['Timeframe continuity', f.continuity.state.replace('_', ' ')]);
  const g = (f.fvg_active ?? [])[0];
  if (g) rows.push(['Fair-value gap', `${g.side} gap ${g.state.replace('_', ' ')}`]);
  if (f.structure_1m?.sweep) rows.push(['Liquidity', f.structure_1m.sweep.side.replace('_', ' ')]);
  if (f.structure_1m?.range?.zone) rows.push(['Range position', f.structure_1m.range.zone]);
  if (f.volatility?.range_state) rows.push(['Volatility', f.volatility.range_state]);
  if (f.volatility?.strike_reachability_sigma != null) rows.push(['Strike reachability', f.volatility.strike_reachability_sigma.toFixed(2) + '× the expected move']);
  if (rev.strongest_bullish?.length) rows.push(['Strongest for', rev.strongest_bullish[0]]);
  if (rev.strongest_bearish?.length) rows.push(['Strongest against', rev.strongest_bearish[0]]);
  const unavailable = rev.data_status?.unavailable ?? [];
  return { rows, unavailable };
}

function officialFor(officials, windowId) {
  const d = (officials ?? []).find((o) => o.window_id === windowId);
  if (!d) return null;
  const side = d.recommendation === 'TAKE_YES' ? 'YES' : 'NO';
  return { revision_seq: Number(d.evidence?.revision_seq ?? 1), side, entry_ask: num(side === 'YES' ? d.up_ask : d.down_ask), sealed_at: d.sealed_at };
}

// window-id → human PT window (KXBTC15M-26JUL261400-00 → close 14:00 UTC that day)
function humanFromId(wid) {
  const m = /KXBTC15M-(\d{2})([A-Z]{3})(\d{2})(\d{2})(\d{2})/.exec(String(wid ?? ''));
  if (!m) return null;
  const months = { JAN: 0, FEB: 1, MAR: 2, APR: 3, MAY: 4, JUN: 5, JUL: 6, AUG: 7, SEP: 8, OCT: 9, NOV: 10, DEC: 11 };
  const close = Date.UTC(2000 + Number(m[1]), months[m[2]], Number(m[3]), Number(m[4]), Number(m[5]));
  return humanWindow(new Date(close).toISOString());
}

export function renderEngineHistory({ name, version, startDate, policy, basis, calls = [], abstainStates = [] } = {}) {
  const actionable = calls.filter((c) => !abstainStates.includes(c.action) && c.action != null);
  const resolved = actionable.filter((c) => c.correct === true || c.correct === false);
  const correct = resolved.filter((c) => c.correct === true).length;
  const incorrect = resolved.length - correct;
  const unresolved = actionable.filter((c) => c.pending).length;
  const abstentions = calls.length - actionable.length;
  const markets = new Set(calls.map((c) => c.window_id)).size;
  const nets = resolved.map((c) => (c.net == null ? null : Number(c.net))).filter((v) => v != null);
  const net = nets.reduce((a, b) => a + b, 0);
  const acc = resolved.length ? `${((correct / resolved.length) * 100).toFixed(1)}% — ${correct} of ${resolved.length} resolved calls` : '— (0 resolved)';
  const freq = markets ? `${actionable.length} actionable over ${markets} eligible markets (${((actionable.length / markets) * 100).toFixed(0)}% coverage)` : '—';
  const callRow = (c) => `<tr><td class="small">${esc(humanFromId(c.window_id) ?? c.window_id)}</td><td class="small muted">${esc(c.window_id)}</td>
    <td>${c.strike != null ? Math.round(c.strike) : '—'}</td><td>${badge(String(c.action ?? '—'))}</td>
    <td class="small">${c.sealed ? fmtT(c.sealed) : '—'}</td>
    <td>${c.entry != null ? Math.round(c.entry * 100) + '¢' : (c.ya != null || c.na != null ? `${c.ya != null ? Math.round(c.ya * 100) : '—'}/${c.na != null ? Math.round(c.na * 100) : '—'}¢` : '—')}</td>
    <td>${c.p != null ? (c.p * 100).toFixed(0) + '%' : (c.conviction != null ? convictionWord(c.conviction) : '—')}</td>
    <td>${c.mp != null ? (c.mp * 100).toFixed(0) + '%' : '—'}</td>
    <td>${c.outcome ? esc(String(c.outcome).toUpperCase()) : 'pending'}</td>
    <td>${c.correct == null ? '—' : c.correct ? '<span class="v24ok">✓</span>' : '<span class="v24bad">✗</span>'}</td>
    <td>${c.net != null ? '$' + Number(c.net).toFixed(2) : '—'}</td>
    <td class="small muted">${esc(c.version ?? version ?? '')}${c.corrected ? ' · corrected' : ''}</td></tr>`;
  return `<details class="v24hist"><summary><b>${esc(name)}</b> — ${acc} · ${abstentions} abstentions · ${unresolved} unresolved · hypothetical net $${net.toFixed(2)} (${esc(basis)}) · since ${esc(startDate ?? '—')} · ${esc(version ?? '')}</summary>
    <p class="muted small">Verify: ${correct} correct + ${incorrect} incorrect = ${resolved.length} resolved actionable calls. Decision frequency: ${freq}. Grading policy: ${esc(policy)}.</p>
    <div class="scroll"><table class="v24tl"><thead><tr><th>window (PT)</th><th>market id</th><th>strike</th><th>call</th><th>recorded</th><th>entry / book</th><th>engine p / conviction</th><th>market p</th><th>outcome</th><th>✓/✗</th><th>result</th><th>version</th></tr></thead>
    <tbody>${calls.slice(0, 150).map(callRow).join('')}</tbody></table>${calls.length > 150 ? `<p class="muted small">Showing newest 150 of ${calls.length} calls.</p>` : ''}</div></details>`;
}

export function renderV24({ revisions = [], grades = [], officials = [], comparison = [], histories = null, nowMs = Date.now() } = {}) {
  const latest = revisions.length ? revisions.reduce((a, b) => (Date.parse(a.evaluated_at) >= Date.parse(b.evaluated_at) ? a : b)) : null;
  const ageS = latest ? Math.round((nowMs - Date.parse(latest.evaluated_at)) / 1000) : null;
  const marketOpen = latest && latest.window_close_ts && Date.parse(latest.window_close_ts) > nowMs;
  const staleWarn = marketOpen && ageS != null && ageS > 180;
  const life = v24Metrics({ grades, revisions, nowMs });
  const day = v24Metrics({ grades, revisions, sinceMs: 24 * 3600e3, nowMs });
  const wk = v24Metrics({ grades, revisions, sinceMs: 7 * 24 * 3600e3, nowMs });
  const mo = v24Metrics({ grades, revisions, sinceMs: 30 * 24 * 3600e3, nowMs });

  // §4 dual instruction: new users vs a user holding the official entry
  let dual = '';
  if (latest && marketOpen) {
    const off = officialFor(officials, latest.window_id);
    const preRow = `<div><b>If you have not entered:</b> ${badge(latest.recommendation === 'YES' ? 'ENTER YES' : latest.recommendation === 'NO' ? 'ENTER NO' : latest.recommendation)}</div>`;
    let postRow;
    if (off) {
      const ins = instructionFor(latest, off.side);
      postRow = `<div><b>If you followed TSM's official entry (${esc(off.side)} at ${Math.round(off.entry_ask * 100)}¢):</b> <span class="v24b v24b-${ins.action.startsWith('EXIT') ? 'GRADE_BAD' : ins.action === 'TAKE_PROFIT' ? 'GRADE_GOOD' : 'WAIT'}">${esc(ins.action.replace(/_/g, ' '))}</span><br><span class="muted small">${esc(ins.reason)}${ins.exec_bid != null ? ` · current exit price ${Math.round(ins.exec_bid * 100)}¢` : ''}</span></div>`;
    } else {
      postRow = `<div><b>Existing-position guidance:</b> <span class="muted">No TSM position exists for this market.</span></div>`;
    }
    dual = `<div class="v24dual">${preRow}${postRow}</div>`;
  }

  // §2/§16: direct instruction + price-gap arithmetic in normal language.
  const instruction = (r) => {
    if (!r) return '';
    const st = r.recommendation;
    if (st === 'YES' || st === 'NO') return `${st === 'YES' ? 'TAKE YES' : 'TAKE NO'} — enter at ${r.entry_limit != null ? Math.round(r.entry_limit * 100) + '¢ or less' : 'the stated limit'}`;
    if (st === 'NO_TRADE') return 'NO TRADE — stand aside';
    // WAIT: name the side the analysis favors + exact gap to TSM's entry
    const side = (r.vote ?? 0) >= 0 ? 'YES' : 'NO';
    const ask = side === 'YES' ? r.up_ask : r.down_ask;
    if (r.entry_limit != null && ask != null && ask > r.entry_limit) {
      const gap = Math.round((ask - r.entry_limit) * 100);
      return `WAIT — Do not enter yet. Analysis favors ${side}, but the contract is too expensive: enter ${side} only at ${Math.round(r.entry_limit * 100)}¢ or less (now ${Math.round(ask * 100)}¢ — needs to fall ${gap}¢).`;
    }
    return `WAIT — Do not enter yet. ${r.waiting_for ? 'Waiting for ' + r.waiting_for + '.' : 'Confirmation still required.'}`;
  };
  const distLine = latest && latest.spot != null && latest.strike != null
    ? `BTC is $${Math.abs(Math.round(latest.distance_usd ?? (latest.spot - latest.strike)))} ${latest.spot >= latest.strike ? 'above' : 'below'} the strike` : '';
  const tech = latest ? technicalSummary(latest) : { rows: [], unavailable: [] };

  const current = !latest ? '<p class="muted">No analysis yet — engine awaiting activation (V24_SHADOW).</p>' : `
    <div class="v24cur ${staleWarn ? 'v24stale' : ''}">
      ${staleWarn ? '<div class="err">⚠ ANALYSIS STALE: last refresh ' + Math.round(ageS / 60) + 'm ago (limit 3m) — DO NOT treat the recommendation below as current. Refresh process may be down.</div>' : ''}
      <p class="muted small" style="margin:0 0 4px">${esc(humanWindow(latest.window_close_ts) ?? '')} · Will BTC finish above $${Number(latest.strike).toLocaleString(undefined, { maximumFractionDigits: 0 })}?</p>
      <div class="v24head">${badge(latest.recommendation)}<b style="font-size:15px">${esc(instruction(latest))}</b></div>
      <div class="facts">
        <div class="fact"><span>YES now / NO now</span><b>${latest.up_ask != null ? Math.round(latest.up_ask * 100) + '¢' : '—'} / ${latest.down_ask != null ? Math.round(latest.down_ask * 100) + '¢' : '—'}</b></div>
        <div class="fact"><span>TSM entry (max)</span><b>${latest.entry_limit != null ? Math.round(latest.entry_limit * 100) + '¢ or less' : '—'}</b></div>
        <div class="fact"><span>BTC / strike</span><b>$${Number(latest.spot).toLocaleString(undefined, { maximumFractionDigits: 0 })} / $${Number(latest.strike).toLocaleString(undefined, { maximumFractionDigits: 0 })}</b></div>
        <div class="fact"><span>Time left</span><b>${latest.tau_sec != null ? Math.floor(latest.tau_sec / 60) + 'm ' + (latest.tau_sec % 60) + 's' : '—'}</b></div>
        <div class="fact"><span>Conviction</span><b>${convictionWord(latest.conviction)}</b></div>
        <div class="fact"><span>Updated</span><b>${ageS}s ago · next ≈ ${Math.max(0, Math.round((150 - ageS)))}s</b></div>
      </div>
      ${distLine ? `<p class="muted small">${esc(distLine)}.</p>` : ''}
      ${dual}
      <h3 style="margin:12px 0 4px">Why TSM currently thinks this</h3>
      <p class="v24why">${esc(guidedWhy(latest))}</p>
      ${latest.change_reason ? `<p class="muted small">What changed: ${esc(latest.change_reason)}</p>` : ''}
      <details><summary>See technical analysis</summary>
        <table class="v24tl">${tech.rows.map(([k, v]) => `<tr><td class="muted small">${esc(k)}</td><td class="small">${esc(v)}</td></tr>`).join('')}</table>
        <p class="muted small">Not available on this data feed (never invented): ${esc(tech.unavailable.join('; ') || '—')}</p>
        <p class="muted small">Raw engine reason: ${esc(latest.reason ?? '')}</p>
      </details>
    </div>`;

  // §9: official DECISIONS only in the primary scorecard; §11: collapse identical
  // young-sample time windows into one "Since Day 1" row with an explicit warning.
  const perf = (m, label) => `<tr><td>${label}</td><td>${m.resolved}</td><td>${m.correct}</td><td>${m.incorrect}</td>
    <td>${m.accuracy_pct != null ? `${m.accuracy_pct}% <span class="muted small">(${m.correct} of ${m.accuracy_n})</span>` : '— <span class="muted small">(0 resolved)</span>'}</td>
    <td>${m.unresolved}</td><td>$${m.net_usd.toFixed(2)}</td><td>$${m.max_drawdown_usd.toFixed(2)}</td></tr>`;
  const windowsDiffer = JSON.stringify([day.resolved, day.correct]) !== JSON.stringify([life.resolved, life.correct])
    || JSON.stringify([wk.resolved, wk.correct]) !== JSON.stringify([life.resolved, life.correct]);

  const timelines = v24Timelines(revisions).map((mkt) => {
    const off = officialFor(officials, mkt.window_id);
    const g = grades.find((x) => x.window_id === mkt.window_id);
    const resolved = g && (g.settled_outcome === 'yes' || g.settled_outcome === 'no');
    const head = [
      humanWindow(mkt.latest.window_close_ts) ?? mkt.window_id,
      mkt.latest.strike != null ? `Strike $${Number(mkt.latest.strike).toLocaleString(undefined, { maximumFractionDigits: 0 })}` : null,
      off ? `Official: ${off.side} @ ${Math.round(off.entry_ask * 100)}¢` : 'No official call',
      resolved ? `settled ${g.settled_outcome.toUpperCase()} — ${g.call_correct ? '<span class="v24ok">CORRECT</span>' : '<span class="v24bad">INCORRECT</span>'} · $${Number(g.net_pnl).toFixed(2)}` : (off ? 'unresolved' : `latest ${mkt.latest.recommendation.replace(/_/g, ' ')}`),
      `${mkt.revs.length} updates`,
    ].filter(Boolean).join(' · ');
    return `
    <details><summary>${head}</summary>
      <p class="muted small">Will BTC finish above the strike at ${fmtHM(mkt.latest.window_close_ts)} PT? · market id ${esc(mkt.window_id)} · engine ${esc(mkt.latest.spec_version ?? 'v2.4.0-shadow')}</p>
      ${off ? `<p class="small"><b>Official call recorded:</b> ${esc(off.side)} at ${Math.round(off.entry_ask * 100)}¢ (analysis update #${off.revision_seq}, ${fmtT(off.sealed_at)} PT)${resolved ? ` → settled ${esc(g.settled_outcome.toUpperCase())}, ${g.call_correct ? 'correct' : 'incorrect'}, hypothetical result $${Number(g.net_pnl).toFixed(2)} (one contract, fee included)` : ' → not yet settled'}</p>` : '<p class="muted small">No official call — the engine never found an enterable YES/NO at an acceptable price in this market.</p>'}
      <table class="v24tl"><thead><tr><th>time</th><th>update</th><th>state</th><th>conviction</th><th>entry ≤</th><th>reasoning</th></tr></thead><tbody>
      ${mkt.revs.map((r) => `<tr${off && r.revision_seq === off.revision_seq ? ' class="v24official"' : ''}><td>${fmtT(r.evaluated_at)}</td><td>#${r.revision_seq}${off && r.revision_seq === off.revision_seq ? ' ★ official' : ''}</td><td>${badge(r.recommendation)}</td>
        <td>${convictionWord(r.conviction)}</td>
        <td>${r.entry_limit != null ? Math.round(r.entry_limit * 100) + '¢' : '—'}</td>
        <td class="small">${esc(guidedWhy(r))}</td></tr>`).join('')}
      </tbody></table></details>`;
  }).join('');

  const compRows = comparison.map((c) => `<tr><td>${esc(c.name)}</td><td class="small">${esc(c.methodology)}</td><td>${c.resolved ?? '—'}</td>
    <td>${c.correct ?? '—'}</td><td>${c.incorrect ?? '—'}</td>
    <td>${c.accuracy_pct != null ? `${c.accuracy_pct}% <span class="muted small">(${c.correct}/${c.correct + c.incorrect})</span>` : '—'}</td>
    <td>${c.net_usd != null ? '$' + Number(c.net_usd).toFixed(2) : '—'}</td><td>${esc(c.status)}</td></tr>`).join('');

  return `
  <section class="card v24" id="v24">
    <h2>BTC 15-Minute Decision</h2>
    <p class="muted small">Engine: TSM Technical v2.4 · SHADOW (no capital) · experiment btc-v24-technical-e1 · Day 1: Jul 26, 2026</p>
    ${current}
    <h2 style="margin-top:18px">C · TSM Technical performance <span class="muted small">(official calls only)</span></h2>
    <p class="muted small">Official call recorded = the FIRST actionable YES/NO meeting the entry price (policy pre-registered). WAIT / NO TRADE are abstentions — never counted as incorrect. ${life.resolved < 30 ? '<b>Early sample — too small for a reliable conclusion.</b>' : ''}</p>
    <div class="scroll"><table><thead><tr><th>period</th><th>resolved</th><th>correct</th><th>incorrect</th><th>accuracy</th><th>unresolved</th><th>hypothetical net</th><th>max modeled drawdown</th></tr></thead>
    <tbody>${windowsDiffer ? perf(day, 'today') + perf(wk, '7d') + perf(mo, '30d') + perf(life, 'lifetime') : perf(life, `Since Day 1 (Jul 26)`)}</tbody></table></div>
    <p class="muted small">Economic basis: hypothetical result of ONE contract per official call, entered at the recorded executable price incl. venue fee, held to settlement ($1 if correct, $0 if not). No position sizing, no compounding. Signal record only — the managed-trade record (section E) is measured separately and never combined.</p>
    <p class="muted small">${frac('YES accuracy', life.yes_correct, life.yes_n)} · ${frac('NO accuracy', life.no_correct, life.no_n)} · current streak ${life.streak >= 0 ? '+' + life.streak : life.streak}</p>
    <details><summary>Engine behavior — analysis updates, not additional trades</summary>
      <p class="muted small">${life.revision_count} analysis updates over ${life.markets_covered} markets (avg ${life.markets_covered ? (life.revision_count / life.markets_covered).toFixed(1) : '—'}/market) · WAIT updates ${life.wait_revisions} · no-trade updates ${life.no_trade_revisions}. These describe how often the engine re-evaluated — they are NOT trades and never enter the accuracy above.</p>
    </details>
    <h2 style="margin-top:18px">D · Recent 15-minute markets <span class="muted small">(every analysis update, in order — nothing hidden after the outcome)</span></h2>
    ${timelines || '<p class="muted">No markets yet.</p>'}
    <h2 style="margin-top:18px">E · Managed-trade performance <span class="muted small">(${PM_POLICY_VERSION}, SHADOW)</span></h2>
    <p class="muted small"><b>Signal accuracy</b> asks whether TSM's original market direction was correct. <b>Managed performance</b> asks how a user would have done following TSM's complete entry AND exit instructions. They are never combined. Official managed record is PROSPECTIVE from ${PM_POLICY_START}; earlier markets shown only as labeled diagnostic replay.</p>
    ${(() => {
      const byWindow = new Map();
      for (const r of revisions) { if (!byWindow.has(r.window_id)) byWindow.set(r.window_id, []); byWindow.get(r.window_id).push(r); }
      const rows = [];
      for (const [wid, revs] of byWindow) {
        const off = officialFor(officials, wid);
        if (!off) continue;
        const g = grades.find((x) => x.window_id === wid);
        const outcome = g?.settled_outcome === 'yes' || g?.settled_outcome === 'no' ? g.settled_outcome : null;
        const m = manageMarket({ revisions: [...revs].sort((a, b) => a.revision_seq - b.revision_seq), official: off, outcome });
        if (!m.entered) continue;
        const prospective = Date.parse(off.sealed_at) >= Date.parse(PM_POLICY_START);
        rows.push({ wid, m, prospective, outcome });
      }
      if (!rows.length) return '<p class="muted small">No managed trades yet — the record begins with the first official entry after Jul 26, 5:45 PM UTC.</p>';
      const officialRows = rows.filter((r) => r.prospective && r.outcome);
      const net = officialRows.reduce((a, r) => a + (r.m.managed_net ?? 0), 0);
      const helped = officialRows.filter((r) => r.m.exit_helped === true).length;
      const exits = officialRows.filter((r) => r.m.exit).length;
      return `<p class="small">OFFICIAL (prospective): <b>${officialRows.length}</b> resolved managed trades · net <b>$${net.toFixed(2)}</b> · exits ${exits}${exits ? ` (improved result in ${helped}/${exits})` : ''}</p>
      <div class="scroll"><table><thead><tr><th>market</th><th>side@entry</th><th>exit</th><th>managed net</th><th>if held</th><th>exit helped?</th><th>status</th></tr></thead><tbody>
      ${rows.map((r) => `<tr><td class="small">${esc(r.wid)}</td><td>${esc(r.m.side)} @ ${Math.round(r.m.entry.ask * 100)}¢</td>
        <td class="small">${r.m.exit ? `${esc(r.m.exit.action)} @ ${Math.round(r.m.exit.bid * 100)}¢ (rev#${r.m.exit.at_seq})` : 'held to resolution'}</td>
        <td>${r.m.managed_net != null ? '$' + r.m.managed_net.toFixed(2) : '—'}</td><td>${r.m.held_to_resolution_net != null ? '$' + r.m.held_to_resolution_net.toFixed(2) : '—'}</td>
        <td>${r.m.exit_helped == null ? '—' : r.m.exit_helped ? '✓' : '✗'}</td>
        <td class="small">${r.prospective ? 'OFFICIAL' : 'DIAGNOSTIC REPLAY (pre-registration)'}${r.outcome ? '' : ' · unresolved'}</td></tr>`).join('')}
      </tbody></table></div>`;
    })()}
    <details style="margin-top:18px"><summary>F · Previous approaches — comparison (is v2.4 performing better than the earlier engines? — not a menu of engines to follow)</summary>
    <p class="muted small">Samples differ: earlier engines accrued over different markets and dates than v2.4 — this is NOT an apples-to-apples table. Accuracy always shows its sample. A matched-market comparison will be added once v2.4 has enough overlapping resolved markets.</p>
    <div class="scroll"><table><thead><tr><th>engine</th><th>methodology</th><th>resolved</th><th>correct</th><th>incorrect</th><th>accuracy</th><th>hypothetical net</th><th>status</th></tr></thead>
    <tbody>${compRows}</tbody></table></div>
    <div class="v24methods muted small"><b>Plain-language methodology:</b><br>
    <b>TSM Technical v2.4 — PRIMARY SHADOW:</b> the founder's technical framework (market structure, STRAT, fair-value gaps, liquidity behavior, volatility, strike distance, time remaining), then checks whether the available contract price justifies entering.<br>
    <b>Probability Forecast — BASELINE:</b> estimates whether BTC is likely to finish above the strike at several points in the market.<br>
    <b>V2.1 Technical Arbiter — PREVIOUS APPROACH:</b> the earlier technical/evidence rules choosing YES, NO, or no trade.<br>
    <b>V2.2 Profit Policy — PREVIOUS APPROACH:</b> forecast probability vs executable price — is the trade economically worthwhile.<br>
    <b>v2.3 agreement gate — SUPERSEDED:</b> retired before activation (zero emissions).</div>
    ${histories ? `<h3 style="margin-top:14px">Complete call histories — every engine, every call (expand to verify each metric)</h3>${histories}` : ''}
    </details>
  </section>
  <style>
    .v24b{padding:2px 10px;border-radius:8px;font-weight:700;font-size:13px}
    .v24b-YES,.v24b-ENTER.YES{background:#16283f;color:#58a6ff}.v24b-NO,.v24b-ENTER.NO{background:#3a2b10;color:#d29922}
    .v24b-ENTER\ YES{background:#16283f;color:#58a6ff}.v24b-ENTER\ NO{background:#3a2b10;color:#d29922}
    .v24b-WAIT{background:#2e2a1a;color:#b8a04a}.v24b-NO_TRADE{background:#21262d;color:#8b949e}
    .v24b-GRADE_GOOD{background:#1a3d1a;color:#3fb950}.v24b-GRADE_BAD{background:#3d1a1a;color:#f85149}
    .v24ok{color:#3fb950;font-weight:700}.v24bad{color:#f85149;font-weight:700}
    .v24official td{border-top:2px solid #b8a04a;border-bottom:2px solid #b8a04a}
    .v24dual{margin-top:10px;padding:10px;border:1px solid #30363d;border-radius:8px;display:flex;flex-direction:column;gap:6px}
    .v24cur{border:1px solid #30363d;border-radius:10px;padding:12px;margin:8px 0}
    .v24stale{border-color:#7a2a2a}
    .v24head{display:flex;gap:12px;align-items:center;margin-bottom:8px}
    .v24why{font-size:13px;margin:8px 0 2px}
    .v24tl{font-size:12px;width:100%}
  </style>`;
}
