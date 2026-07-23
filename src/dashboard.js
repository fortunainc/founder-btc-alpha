/**
 * Founder-only read-only dashboard.
 *
 * Serves exactly ONE route: GET /dash?token=<FOUNDER_DASH_TOKEN>. Everything
 * else 404s with no detail. The page is fully self-contained (inline CSS, no
 * external requests), renders Pacific time, and auto-refreshes every 10s via a
 * meta refresh (the token in the URL is preserved on reload).
 *
 * SECURITY POSTURE (this process holds the Supabase service_role key):
 *  - Only GET /dash is handled; all other paths/methods 404.
 *  - The token is compared in constant time; a missing/empty FOUNDER_DASH_TOKEN
 *    DISABLES the route (503) so it can never be served wide open.
 *  - The token is never logged. Request logs omit the query string.
 *  - The route performs ONLY SELECTs against founder_alpha views/tables. It
 *    cannot write, and it never reflects user input into the page.
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

const fmtPT = (iso, opts = {}) => {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone: PT,
      month: 'short', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
      ...opts,
    }).format(new Date(iso));
  } catch {
    return '—';
  }
};

const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

const pct = (p) => (p == null || Number.isNaN(Number(p)) ? '—' : `${(Number(p) * 100).toFixed(1)}%`);

const CALL_COLORS = {
  YES: '#3fb950', NO: '#f85149', FAIR: '#58a6ff', THIN: '#8b949e',
};

/** Query the views the dashboard needs. Never throws — returns an errors map. */
async function loadData(client) {
  const out = { errors: {} };

  const alive = await client
    .from('fa_window_capture')
    .select('ts')
    .order('ts', { ascending: false })
    .limit(1);
  out.latestCaptureTs = alive.error ? null : alive.data?.[0]?.ts ?? null;
  if (alive.error) out.errors.capture = alive.error.message;

  const calls = await client
    .from('v_fa_window_calls')
    .select('window_id,seal_point,close_ts,strike,market_p,consensus_p,divergence,call,outcome,call_correct')
    .order('close_ts', { ascending: false })
    .limit(45);
  out.calls = calls.error ? [] : calls.data;
  if (calls.error) out.errors.calls = `${calls.error.code || ''} ${calls.error.message}`.trim();

  const board = await client
    .from('v_fa_call_scoreboard')
    .select('seal_point,call,n_total,n_graded,n_correct,accuracy,mean_abs_divergence');
  out.board = board.error ? [] : board.data;
  if (board.error) out.errors.board = `${board.error.code || ''} ${board.error.message}`.trim();

  return out;
}

function renderCallsTable(rows) {
  if (!rows.length) return '<p class="muted">No sealed windows yet.</p>';
  const body = rows.map((r) => {
    const color = CALL_COLORS[r.call] || '#8b949e';
    let result = '<span class="muted">pending</span>';
    if (r.outcome) {
      if (r.call === 'THIN' || r.call_correct == null) {
        result = `<span class="muted">${esc(r.outcome)}</span>`;
      } else if (r.call_correct) {
        result = `<span style="color:#3fb950">✓ right</span>`;
      } else {
        result = `<span style="color:#f85149">✗ wrong</span>`;
      }
    }
    const div = r.divergence == null ? '—'
      : `${Number(r.divergence) >= 0 ? '+' : ''}${(Number(r.divergence) * 100).toFixed(1)}pp`;
    return `<tr>
      <td class="mono">${fmtPT(r.close_ts, { month: undefined, day: undefined })}</td>
      <td class="mono small">${esc(String(r.window_id).replace('KXBTC15M-', ''))}</td>
      <td class="mono">${esc(r.seal_point)}</td>
      <td><span class="pill" style="background:${color}22;color:${color};border:1px solid ${color}55">${esc(r.call)}</span></td>
      <td class="mono">${pct(r.consensus_p)}</td>
      <td class="mono muted">${pct(r.market_p)}</td>
      <td class="mono">${div}</td>
      <td>${result}</td>
    </tr>`;
  }).join('');
  return `<table>
    <thead><tr>
      <th>close (PT)</th><th>window</th><th>seal</th><th>call</th>
      <th>models</th><th>market</th><th>div</th><th>result</th>
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
      <td class="mono">${acc}</td>
      <td class="mono muted">${r.mean_abs_divergence == null ? '—' : (Number(r.mean_abs_divergence) * 100).toFixed(1) + 'pp'}</td>
    </tr>`;
  }).join('');
  return `<table>
    <thead><tr><th>seal</th><th>call</th><th>total</th><th>graded</th><th>accuracy</th><th>mean |div|</th></tr></thead>
    <tbody>${body}</tbody></table>`;
}

function renderPage(data) {
  const now = Date.now();
  const aliveAgeS = data.latestCaptureTs
    ? Math.round((now - new Date(data.latestCaptureTs).getTime()) / 1000)
    : null;
  const alive = aliveAgeS != null && aliveAgeS <= 60;
  const aliveColor = alive ? '#3fb950' : '#f85149';
  const aliveText = aliveAgeS == null ? 'no data'
    : alive ? `live · ${aliveAgeS}s ago` : `STALE · ${aliveAgeS}s ago`;

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
    font:14px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,Helvetica,Arial,sans-serif; }
  .wrap { max-width:1000px; margin:0 auto; padding:16px; }
  .shadow { background:#3d2d00; color:#f0c674; border:1px solid #8a6d00;
    padding:8px 12px; border-radius:8px; font-weight:600; text-align:center; letter-spacing:.03em; }
  header { display:flex; align-items:center; justify-content:space-between; gap:12px; margin:16px 0 8px; flex-wrap:wrap; }
  h1 { font-size:18px; margin:0; font-weight:650; }
  h2 { font-size:13px; text-transform:uppercase; letter-spacing:.08em; color:#8b949e; margin:24px 0 8px; }
  .alive { display:inline-flex; align-items:center; gap:8px; font-weight:600; }
  .dot { width:10px; height:10px; border-radius:50%; box-shadow:0 0 8px currentColor; }
  table { width:100%; border-collapse:collapse; background:#161b22; border-radius:8px; overflow:hidden; }
  th,td { padding:6px 10px; text-align:left; border-bottom:1px solid #21262d; white-space:nowrap; }
  th { font-size:11px; text-transform:uppercase; letter-spacing:.05em; color:#8b949e; background:#0f141a; }
  tr:last-child td { border-bottom:none; }
  .mono { font-family:ui-monospace,SFMono-Regular,Menlo,monospace; }
  .small { font-size:12px; } .muted { color:#8b949e; }
  .pill { padding:1px 8px; border-radius:999px; font-weight:700; font-size:12px; font-family:ui-monospace,monospace; }
  .err { background:#3d1a1a; color:#ff9d9d; border:1px solid #7a2a2a; padding:6px 10px; border-radius:8px; margin-top:8px; font-size:12px; }
  .foot { color:#6e7681; font-size:11px; margin:24px 0 8px; text-align:center; }
  .scroll { overflow-x:auto; }
</style></head>
<body><div class="wrap">
  <div class="shadow">SHADOW MODE — research only · no orders · no capital · labeled shadow until Day-14</div>
  <header>
    <h1>Founder BTC Alpha · KXBTC15M</h1>
    <span class="alive"><span class="dot" style="color:${aliveColor};background:${aliveColor}"></span>
      capture <span style="color:${aliveColor}">${esc(aliveText)}</span></span>
  </header>
  ${errBanner}
  <h2>Window calls — models vs market</h2>
  <div class="scroll">${renderCallsTable(data.calls)}</div>
  <h2>Call scoreboard</h2>
  <div class="scroll">${renderBoard(data.board)}</div>
  <p class="foot">as of ${fmtPT(new Date().toISOString())} PT · auto-refresh 10s ·
    YES/NO = actionable mispricing · FAIR = market agrees within 1pp · THIN = no models or sub-threshold ·
    FAIR "right" = settled with the market's favourite (validates the market, not our models)</p>
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
    // Log method + path only, never the query string (it carries the token).
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

    // Only GET /dash exists. Everything else is invisible.
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
        // Self-contained page: forbid any external subresource or connection.
        'content-security-policy':
          "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'",
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

export { renderPage, loadData, timingSafeEqual };
