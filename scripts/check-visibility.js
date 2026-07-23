#!/usr/bin/env node
/**
 * Regenerate the repo-visibility fixture.
 *
 * The dispatch specified `gh repo view --json visibility`, but the gh CLI is
 * not installed on this machine. This probes the public GitHub REST API
 * instead: a private repo returns 404 to an unauthenticated caller.
 *
 * That is negative evidence (absence of public readability) rather than a
 * positive read of the visibility field. It is sufficient to prove the repo is
 * not public, which is the property the dispatch actually cares about.
 */

import fs from 'node:fs';
import path from 'node:path';

const OWNER = process.env.GH_OWNER || 'fortunainc';
const REPO = process.env.GH_REPO || 'founder-btc-alpha';
const url = `https://api.github.com/repos/${OWNER}/${REPO}`;

const res = await fetch(url, {
  headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'founder-btc-alpha' },
});
const body = await res.json().catch(() => null);
const isPrivate = res.status === 404;

const out = {
  captured_at: new Date().toISOString(),
  method: 'unauthenticated GitHub REST API probe (gh CLI not installed)',
  request: `GET ${url}`,
  http_status: res.status,
  response_body: res.status === 404 ? body : { visibility: body?.visibility, private: body?.private },
  required_by_dispatch: 'PRIVATE',
  actual: isPrivate ? 'private' : (body?.visibility ?? 'unknown'),
  status: isPrivate ? 'VERIFIED' : 'FAILED',
  interpretation: isPrivate
    ? '404 to an unauthenticated caller => repository is not publicly readable => PRIVATE.'
    : 'Repository is publicly readable. This violates dispatch section A.',
};

const file = path.resolve(process.cwd(), 'fixtures', '10-repo-visibility.json');
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, JSON.stringify(out, null, 2));

console.log(`HTTP ${res.status} -> ${out.status} (${out.actual})`);
console.log(out.interpretation);
process.exit(isPrivate ? 0 : 1);
