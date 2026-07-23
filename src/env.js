/**
 * Minimal .env loader — no dependency, no secret echoing.
 *
 * Supports:
 *   KEY=value
 *   KEY="value with spaces"
 *   KEY="-----BEGIN...\n...\n-----END..."   (escaped newlines)
 *   KEY=<<PEM ... PEM   (heredoc block for real multi-line PEMs)
 *
 * Existing process.env values always win, so Railway-injected vars are never
 * clobbered by a stray local file.
 */

import fs from 'node:fs';
import path from 'node:path';

export function loadEnv(file = '.env') {
  const abs = path.resolve(process.cwd(), file);
  if (!fs.existsSync(abs)) return { loaded: false, keys: [] };

  const text = fs.readFileSync(abs, 'utf8');
  const lines = text.split(/\r?\n/);
  const keys = [];

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;

    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;

    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();

    // Heredoc form: KEY=<<PEM ... PEM
    const heredoc = value.match(/^<<(\w+)$/);
    if (heredoc) {
      const marker = heredoc[1];
      const buf = [];
      i += 1;
      while (i < lines.length && lines[i].trim() !== marker) {
        buf.push(lines[i]);
        i += 1;
      }
      value = buf.join('\n');
    } else if (
      (value.startsWith('"') && value.endsWith('"') && value.length > 1) ||
      (value.startsWith("'") && value.endsWith("'") && value.length > 1)
    ) {
      value = value.slice(1, -1);
    }

    if (!(key in process.env)) {
      process.env[key] = value;
    }
    keys.push(key);
  }

  return { loaded: true, keys };
}

/**
 * Report which required vars are present — by NAME ONLY.
 * Never returns or logs a value.
 */
export function credentialStatus(names) {
  return names.map((n) => ({
    name: n,
    present: Boolean(process.env[n] && process.env[n].length > 0),
  }));
}

/** Redact anything that looks like a secret before it can reach a log sink. */
export function redact(value) {
  if (typeof value !== 'string') return value;
  return value
    .replace(
      /-----BEGIN[\s\S]*?-----END[^-]*-----/g,
      '[REDACTED_PRIVATE_KEY]'
    )
    .replace(/\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{12,}\.[A-Za-z0-9_-]{20,}\b/g, '[REDACTED_JWT]');
}
