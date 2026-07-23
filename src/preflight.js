/**
 * Startup preflight — turns a cryptic boot crash into a named fault.
 *
 * Runs before the worker touches the network. Every check logs a clear verdict,
 * so a Railway deploy that fails to write is self-diagnosing from the logs alone
 * rather than dying with `error:1E08010C:DECODER routines::unsupported`.
 *
 * Prints only NAMES and SHAPES of secrets, never values.
 */

import crypto from 'node:crypto';
import { normalisePem } from './kalshi-client.js';

/**
 * @returns {{ok:boolean, checks:Array<{name,status,detail}>, fatal:string|null}}
 */
export function preflight(env = process.env) {
  const checks = [];
  let fatal = null;

  const add = (name, status, detail) => checks.push({ name, status, detail });

  // --- Kalshi key id ---
  if (env.KALSHI_KEY_ID && env.KALSHI_KEY_ID.length > 10) {
    add('KALSHI_KEY_ID', 'OK', `present (${env.KALSHI_KEY_ID.length} chars)`);
  } else {
    add('KALSHI_KEY_ID', 'FAIL', 'missing or too short');
    fatal = fatal || 'KALSHI_KEY_ID missing';
  }

  // --- Kalshi PEM: the #1 Railway paste failure ---
  const rawPem = env.KALSHI_PRIVATE_KEY_PEM;
  if (!rawPem) {
    add('KALSHI_PRIVATE_KEY_PEM', 'FAIL', 'missing');
    fatal = fatal || 'KALSHI_PRIVATE_KEY_PEM missing';
  } else {
    const hasHeader = rawPem.includes('BEGIN') && rawPem.includes('PRIVATE KEY');
    const hasRealNewline = rawPem.includes('\n');
    const hasEscapedNewline = rawPem.includes('\\n');
    if (!hasHeader) {
      add('KALSHI_PRIVATE_KEY_PEM', 'FAIL',
        'no BEGIN/PRIVATE KEY header — value looks truncated or wrong');
      fatal = fatal || 'PEM has no header';
    } else if (!hasRealNewline && !hasEscapedNewline) {
      // A one-line PEM with neither real nor escaped newlines = newlines were
      // eaten on paste. This is the classic Railway single-line-field mistake.
      add('KALSHI_PRIVATE_KEY_PEM', 'FAIL',
        'header present but NO line breaks (real or \\n). Newlines were lost on ' +
        'paste. Re-paste as the escaped single-line form — see README-DEPLOY §3.');
      fatal = fatal || 'PEM newlines lost on paste';
    } else {
      // Actually try to parse it. This is the definitive test.
      try {
        crypto.createPrivateKey({ key: normalisePem(rawPem) });
        add('KALSHI_PRIVATE_KEY_PEM', 'OK',
          `parses as a private key (${hasEscapedNewline ? 'escaped-newline' : 'multi-line'} form)`);
      } catch (err) {
        add('KALSHI_PRIVATE_KEY_PEM', 'FAIL',
          `header present but OpenSSL refused it (${err.message.slice(0, 40)}...). ` +
          'Likely partially mangled on paste. Re-copy the whole key.');
        fatal = fatal || 'PEM present but unparseable';
      }
    }
  }

  // --- Supabase ---
  if (env.SUPABASE_URL) {
    const bad = /\/rest\/v1\/?$/.test(env.SUPABASE_URL);
    add('SUPABASE_URL', bad ? 'WARN' : 'OK',
      bad ? 'ends in /rest/v1 — supabase-js will double it to /rest/v1/rest/v1. Use the BASE url.'
          : env.SUPABASE_URL.replace(/^(https:\/\/[a-z0-9]{6}).*/, '$1…'));
  } else {
    add('SUPABASE_URL', 'WARN', 'missing — worker will fall back to DRY-RUN (writes nowhere useful)');
  }

  if (env.SUPABASE_SERVICE_ROLE_KEY && env.SUPABASE_SERVICE_ROLE_KEY.split('.').length === 3) {
    add('SUPABASE_SERVICE_ROLE_KEY', 'OK', 'present, JWT-shaped');
  } else {
    add('SUPABASE_SERVICE_ROLE_KEY', 'WARN',
      'missing or not JWT-shaped — worker will fall back to DRY-RUN');
  }

  // --- Runtime WebSocket: supabase-js createClient needs it ---
  // Node <22 has no global WebSocket; the sink injects `ws` to cover that, so
  // this is informational. A FAIL here would mean both the runtime AND the
  // injection are unavailable, which would break every DB write.
  const nodeMajor = Number(process.versions.node.split('.')[0]);
  if (typeof globalThis.WebSocket === 'function') {
    add('runtime WebSocket', 'OK', `present (Node ${process.versions.node})`);
  } else {
    add('runtime WebSocket', 'WARN',
      `Node ${process.versions.node} has no global WebSocket; sink injects ws. ` +
      (nodeMajor < 22 ? 'Base image should be Node 22+.' : ''));
  }

  // --- The silent killer: dry-run left on in production ---
  const dryRun = env.CAPTURE_DRY_RUN === 'true';
  if (dryRun) {
    add('CAPTURE_DRY_RUN', 'WARN',
      'TRUE — worker will write to container disk, NOT Supabase. Unset it for production.');
  } else {
    add('CAPTURE_DRY_RUN', 'OK', 'off (or unset) — live writes');
  }

  return { ok: !fatal, checks, fatal };
}

/** Log the preflight result. Returns ok. */
export function runPreflight(env = process.env, log = console) {
  const { ok, checks, fatal } = preflight(env);
  (log.info || log.log).call(log, 'PREFLIGHT:');
  for (const c of checks) {
    const line = `  [${c.status.padEnd(4)}] ${c.name}: ${c.detail}`;
    if (c.status === 'FAIL') (log.error || log.log).call(log, line);
    else if (c.status === 'WARN') (log.warn || log.log).call(log, line);
    else (log.info || log.log).call(log, line);
  }
  if (!ok) {
    (log.error || log.log).call(log, `PREFLIGHT FAILED: ${fatal}. See docs/RAILWAY-FIX.md`);
  }
  return ok;
}
