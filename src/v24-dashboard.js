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
const badge = (rec) => `<span class="v24b v24b-${esc(rec)}">${esc(rec)}</span>`;
const frac = (label, a, b, extra = '') => b > 0 ? `${label}: <b>${((a / b) * 100).toFixed(1)}%</b> — ${a} of ${b}${extra}` : `${label}: <b>—</b> (0 samples)`;

function officialFor(officials, windowId) {
  const d = (officials ?? []).find((o) => o.window_id === windowId);
  if (!d) return null;
  const side = d.recommendation === 'TAKE_YES' ? 'YES' : 'NO';
  return { revision_seq: Number(d.evidence?.revision_seq ?? 1), side, entry_ask: num(side === 'YES' ? d.up_ask : d.down_ask), sealed_at: d.sealed_at };
}

export function renderV24({ revisions = [], grades = [], officials = [], comparison = [], nowMs = Date.now() } = {}) {
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
  if (latest) {
    const off = officialFor(officials, latest.window_id);
    if (off && marketOpen) {
      const ins = instructionFor(latest, off.side);
      dual = `<div class="v24dual"><b>New users:</b> ${badge(latest.recommendation)} &nbsp;·&nbsp; <b>Existing ${esc(off.side)} position (official entry ${Math.round(off.entry_ask * 100)}¢):</b> <span class="v24b v24b-${ins.action.startsWith('EXIT') ? 'NO' : ins.action === 'TAKE_PROFIT' ? 'YES' : 'WAIT'}">${esc(ins.action.replace(/_/g, ' '))}</span><br><span class="muted small">Why: ${esc(ins.reason)}${ins.exec_bid != null ? ` · executable exit ${Math.round(ins.exec_bid * 100)}¢` : ''}</span></div>`;
    } else if (marketOpen) {
      dual = `<div class="v24dual"><b>New users:</b> ${badge(latest.recommendation)} &nbsp;·&nbsp; <span class="muted small">no official entry yet this market — position guidance appears once one fires</span></div>`;
    }
  }

  const current = !latest ? '<p class="muted">No revisions yet — engine awaiting activation (V24_SHADOW).</p>' : `
    <div class="v24cur ${staleWarn ? 'v24stale' : ''}">
      ${staleWarn ? '<div class="err">⚠ ANALYSIS STALE: last refresh ' + Math.round(ageS / 60) + 'm ago (limit 3m) — DO NOT treat the recommendation below as current. Refresh process may be down.</div>' : ''}
      <div class="v24head">${badge(latest.recommendation)}
        <span class="muted small">rev #${latest.revision_seq} · analyzed ${fmtT(latest.evaluated_at)} PT · data age ${latest.data_status?.data_age_ms != null ? Math.round(latest.data_status.data_age_ms / 1000) + 's' : '?'} · ${ageS}s since analysis</span></div>
      <div class="facts">
        <div class="fact"><span>BTC now</span><b>${latest.spot != null ? '$' + Number(latest.spot).toLocaleString() : '—'}</b></div>
        <div class="fact"><span>Strike</span><b>${latest.strike != null ? '$' + Number(latest.strike).toLocaleString() : '—'}</b></div>
        <div class="fact"><span>Time left</span><b>${latest.tau_sec != null ? Math.floor(latest.tau_sec / 60) + 'm ' + (latest.tau_sec % 60) + 's' : '—'}</b></div>
        <div class="fact"><span>Max entry</span><b>${latest.entry_limit != null ? Math.round(latest.entry_limit * 100) + '¢' : '—'}</b></div>
        <div class="fact"><span>Conviction</span><b>${latest.conviction != null ? (latest.conviction * 100).toFixed(0) + '%' : '—'}</b></div>
      </div>
      <p class="v24why">${esc(latest.reason)}</p>
      ${latest.waiting_for ? `<p class="muted small">Waiting for: ${esc(latest.waiting_for)}</p>` : ''}
      ${latest.change_reason ? `<p class="muted small">Change: ${esc(latest.change_reason)}</p>` : ''}
      ${dual}
    </div>`;

  const perf = (m, label) => `<tr><td>${label}</td><td>${m.resolved}</td><td>${m.correct}</td><td>${m.incorrect}</td>
    <td>${m.accuracy_pct != null ? `${m.accuracy_pct}% <span class="muted small">(${m.correct}/${m.accuracy_n})</span>` : '— <span class="muted small">(0)</span>'}</td>
    <td>${m.wait_revisions}</td><td>${m.no_trade_revisions}</td><td>$${m.net_usd.toFixed(2)}</td><td>$${m.max_drawdown_usd.toFixed(2)}</td></tr>`;

  const timelines = v24Timelines(revisions).map((mkt) => `
    <details><summary>${esc(mkt.window_id)} — ${mkt.revs.length} revisions · latest ${badge(mkt.latest.recommendation)} ${fmtT(mkt.latest.evaluated_at)} PT</summary>
      <table class="v24tl"><thead><tr><th>time</th><th>rev</th><th>state</th><th>conv</th><th>entry≤</th><th>reason</th></tr></thead><tbody>
      ${mkt.revs.map((r) => `<tr><td>${fmtT(r.evaluated_at)}</td><td>#${r.revision_seq}</td><td>${badge(r.recommendation)}</td>
        <td>${r.conviction != null ? (r.conviction * 100).toFixed(0) + '%' : '—'}</td>
        <td>${r.entry_limit != null ? Math.round(r.entry_limit * 100) + '¢' : '—'}</td>
        <td class="small">${esc(r.reason ?? '')}${r.waiting_for ? ' · waiting: ' + esc(r.waiting_for) : ''}</td></tr>`).join('')}
      </tbody></table></details>`).join('');

  const compRows = comparison.map((c) => `<tr><td>${esc(c.name)}</td><td class="small">${esc(c.methodology)}</td><td>${c.resolved ?? '—'}</td>
    <td>${c.correct ?? '—'}</td><td>${c.incorrect ?? '—'}</td>
    <td>${c.accuracy_pct != null ? `${c.accuracy_pct}% <span class="muted small">(${c.correct}/${c.correct + c.incorrect})</span>` : '—'}</td>
    <td>${c.net_usd != null ? '$' + Number(c.net_usd).toFixed(2) : '—'}</td><td>${esc(c.status)}</td></tr>`).join('');

  return `
  <section class="card v24" id="v24">
    <h2>1 · TSM Technical — current recommendation <span class="muted small">(v2.4 founder technical · SHADOW · experiment btc-v24-technical-e1)</span></h2>
    ${current}
    <h2 style="margin-top:18px">2 · TSM Technical — success rate &amp; call history</h2>
    <p class="muted small">Official call = FIRST actionable YES/NO meeting the executable entry (pre-registered). WAIT / NO TRADE are abstentions — never counted as incorrect. Every percentage shows its sample.</p>
    <div class="scroll"><table><thead><tr><th>period</th><th>resolved</th><th>✓</th><th>✗</th><th>accuracy</th><th>WAIT revs</th><th>NO TRADE revs</th><th>modeled net</th><th>max DD</th></tr></thead>
    <tbody>${perf(day, 'today')}${perf(wk, '7d')}${perf(mo, '30d')}${perf(life, 'lifetime')}</tbody></table></div>
    <p class="muted small">${frac('YES accuracy', life.yes_correct, life.yes_n)} · ${frac('NO accuracy', life.no_correct, life.no_n)} · streak ${life.streak >= 0 ? '+' + life.streak : life.streak} · ${life.revision_count} revisions over ${life.markets_covered} markets</p>
    <h3>Per-market recommendation timelines (every revision, in order — nothing hidden after the outcome)</h3>
    ${timelines || '<p class="muted">No markets yet.</p>'}
    <h2 style="margin-top:18px">2b · Managed trades — position manager (${PM_POLICY_VERSION}, SHADOW)</h2>
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
      if (!rows.length) return '<p class="muted">No managed trades yet.</p>';
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
    <h2 style="margin-top:18px">3 · Previous approaches — comparison</h2>
    <div class="scroll"><table><thead><tr><th>engine</th><th>methodology</th><th>resolved</th><th>✓</th><th>✗</th><th>accuracy</th><th>net</th><th>status</th></tr></thead>
    <tbody>${compRows}</tbody></table></div>
  </section>
  <style>
    .v24b{padding:2px 10px;border-radius:8px;font-weight:700;font-size:13px}
    .v24b-YES{background:#1a3d1a;color:#3fb950}.v24b-NO{background:#3d1a1a;color:#f85149}
    .v24b-WAIT{background:#3d331a;color:#f0c674}.v24b-NO_TRADE{background:#21262d;color:#8b949e}
    .v24cur{border:1px solid #30363d;border-radius:10px;padding:12px;margin:8px 0}
    .v24stale{border-color:#7a2a2a}
    .v24head{display:flex;gap:12px;align-items:center;margin-bottom:8px}
    .v24why{font-size:13px;margin:8px 0 2px}
    .v24tl{font-size:12px;width:100%}
  </style>`;
}
