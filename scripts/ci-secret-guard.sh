#!/usr/bin/env bash
# TSM CI SECRET-PRESENCE GUARD
# Fails the build if credential material is tracked in git or embedded in tracked
# content. Prints offending PATHS and LINE NUMBERS only — never the secret value.
# Run in CI before build:  bash scripts/ci-secret-guard.sh
# Exit 0 = clean, 1 = secret detected, 2 = runner error.
#
# Design notes:
#   • Detects tracked secret-pattern FILENAMES (keys, tokens, pem, p12, .save backups).
#   • Detects real private keys by HEADER + BODY (a header alone — used in format /
#     validation tests like "truncated PEM is fatal" — is NOT flagged).
#   • Detects long credential-literal assignments (api_key/secret/token/password=...).
#   • Allowlists templates (.env.example), .gitignore, docs, and this guard itself.
set -euo pipefail

ALLOW='(^|/)\.env\.example$|(^|/)\.gitignore$|(^|/)scripts/ci-secret-guard\.sh$|(^|/)docs/|(^|/)\.github/'
fail=0

# 1) No secret-pattern FILENAMES tracked.
bad_names="$(git ls-files \
  | grep -iE '(^|/)([^/]*key[^/]*\.txt|[^/]*token[^/]*\.txt|[^/]*secret[^/]*\.(txt|json|ya?ml|env|cfg|conf|ini)|[^/]*\.pem|[^/]*\.key|[^/]*\.p12|[^/]*\.pfx|[^/]*\.save)$' \
  | grep -vE "$ALLOW" || true)"
if [ -n "$bad_names" ]; then
  echo "BLOCKED: secret-pattern files are tracked in git:"
  echo "$bad_names" | sed 's/^/  - /'
  fail=1
fi

files="$(git ls-files | grep -vE "$ALLOW" || true)"

# 2a) Escaped single-line PEM: header IMMEDIATELY followed by a key body (>=40 base64).
hits_inline="$(printf '%s\n' "$files" | tr '\n' '\0' | xargs -0 -r grep -HnI -E \
  -e '-----BEGIN [A-Z ]*PRIVATE KEY-----[^A-Za-z0-9]{0,6}[A-Za-z0-9+/]{40,}' 2>/dev/null \
  | cut -d: -f1,2 || true)"

# 2b) Multi-line PEM: a file that has a PRIVATE KEY header AND a standalone base64 body
#     line (>=64 chars). Header-only format strings have no body line, so they pass.
hits_block=""
while IFS= read -r f; do
  [ -z "$f" ] && continue
  if grep -qE -- '-----BEGIN [A-Z ]*PRIVATE KEY-----' "$f" 2>/dev/null \
     && grep -qE '^[A-Za-z0-9+/]{64,}={0,2}$' "$f" 2>/dev/null; then
    ln="$(grep -nE '^[A-Za-z0-9+/]{64,}={0,2}$' "$f" | head -1 | cut -d: -f1)"
    hits_block="${hits_block}${f}:${ln}"$'\n'
  fi
done <<< "$files"

# 2c) Long credential-literal assignments.
hits_assign="$(printf '%s\n' "$files" | tr '\n' '\0' | xargs -0 -r grep -HnI -E \
  '(api[_-]?key|secret|token|password|private[_-]?key)[[:space:]]*[:=][[:space:]]*["'"'"'][A-Za-z0-9/_+.=-]{24,}' 2>/dev/null \
  | grep -vE 'process\.env|import\.meta\.env|includes\(|expected|placeholder|your[_-]|<[A-Za-z]|xxxx|REDACTED|example|status\(' \
  | cut -d: -f1,2 || true)"

content="$(printf '%s\n%s\n%s\n' "$hits_inline" "$hits_block" "$hits_assign" | grep -vE '^\s*$' | sort -u || true)"
if [ -n "$content" ]; then
  echo "BLOCKED: private-key/credential content in tracked files (path:line, value withheld):"
  echo "$content" | sed 's/^/  - /'
  fail=1
fi

if [ "$fail" -eq 0 ]; then
  echo "ci-secret-guard: OK — no tracked secret files or credential content detected."
fi
exit "$fail"
