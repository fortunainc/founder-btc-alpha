# CTO INSTRUCTION — founder-btc-alpha terminal: execute immediately on read
Capture is DOWN (local worker killed ~10:24 PT, Railway not yet writing). Founder is away.
DO NOW, autonomously:
1. Restart the local worker in live mode (CAPTURE_DRY_RUN unset/false), single instance, so capture + sealing resume. Confirm rows land in founder_alpha.fa_window_capture (ts newer than 2026-07-23T17:24Z).
2. Diagnose the Railway deploy: is it Failed/Crashed or Success-but-dry-run? Read the deploy logs. Most likely: KALSHI_PRIVATE_KEY_PEM mangled on paste (multi-line), or CAPTURE_DRY_RUN implicitly set, or build failure. Write the exact fix to docs/RAILWAY-FIX.md for the founder (phone-friendly steps).
3. Do NOT run both local AND Railway writing simultaneously (double-write into append-only). Local is the stopgap; when Railway is confirmed writing, stop local.
4. Note in docs/CTO-NOTES.md what you found + did.
