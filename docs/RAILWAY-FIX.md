# Railway deploy — diagnose & fix (phone-friendly)

**Written 2026-07-23 by the terminal agent for the founder.** Capture is running on the laptop
as a stopgap; Railway must take over so it survives the laptop closing.

## What I could and couldn't check

I **cannot** see your Railway dashboard or deploy logs from here — the Railway CLI on the laptop
is not logged in (`railway whoami` → Unauthorized) and no project is linked. So this is a
decision tree you run against what **you** see in the Railway UI.

**What I could confirm from the database:** in the 4.5 hours the laptop worker was down
(17:25–22:00 UTC) **zero rows** landed in `founder_alpha.fa_window_capture`. So Railway is
**not writing** — it is either not deployed, crashed, or running in dry-run.

**New: the worker now self-diagnoses on boot.** After you redeploy (the fix below pushes a new
commit), the very first lines in the Railway log will be a `PREFLIGHT:` block that names the
exact problem. Read that first.

---

## Step 1 — open the Railway deploy logs

Railway app → your project → the service → **Deployments** → tap the latest → **View Logs**.

Match what you see to one of these:

| What the log shows | Meaning | Go to |
|---|---|---|
| `PREFLIGHT FAILED: PEM newlines lost on paste` | **Most likely.** The private key lost its line breaks when pasted. | **Fix A** |
| `PREFLIGHT FAILED: PEM present but unparseable` | Key partially corrupted on paste. | **Fix A** |
| `[WARN] CAPTURE_DRY_RUN: TRUE …` and no DB rows | Dry-run left on — writing to disk, not Supabase. | **Fix B** |
| `[WARN] SUPABASE_URL: ends in /rest/v1 …` | URL has the wrong suffix. | **Fix C** |
| `error:1E08010C:DECODER routines::unsupported` | Old build, pre-preflight; it's the PEM. | **Fix A** |
| `permission denied for schema founder_alpha` | Grants missing (migration 002). | ping CTO |
| Build failed / image error / nothing runs | Build problem, not config. | **Fix D** |
| Deployments list is **empty** | Never deployed. | **Fix E** |

---

## Fix A — the private key (the usual culprit)

The key is multi-line. Pasted straight into Railway's single-line box, the line breaks vanish and
OpenSSL rejects it. Paste the **escaped single-line** form instead.

1. On the laptop, in Terminal, in the project folder, run:
   ```
   node -e 'const fs=require("fs");process.stdout.write(JSON.stringify(fs.readFileSync("kalshi-key.txt","utf8").trim()))'
   ```
2. It prints one long line starting `"-----BEGIN` and ending `-----"`. **Select and copy the
   whole thing, including both double-quotes.**
3. Railway → service → **Variables** → `KALSHI_PRIVATE_KEY_PEM` → edit → **use the "Raw Editor"
   / multi-line editor if offered** → delete the old value → paste → Save.
4. Railway redeploys automatically. Watch the log: `[OK  ] KALSHI_PRIVATE_KEY_PEM: parses as a
   private key`.

> Do this on a screen no one else can see — the command prints your private key.

---

## Fix B — dry-run is on

Railway → **Variables**. If `CAPTURE_DRY_RUN` exists and is `true`, **delete the variable**
(or set it to `false`). Save. It redeploys. Log should then say
`[sink] using Supabase sink`, **not** `using DRY-RUN sink`.

---

## Fix C — the Supabase URL

Railway → **Variables** → `SUPABASE_URL`. It must be exactly:

```
https://hahgdljmkbbykneclinf.supabase.co
```

No `/rest/v1` on the end, no trailing slash. Save → redeploy.

---

## Fix D — build failed

Railway → Deployments → open the failed one → **Build Logs**.

- The repo must be **private** but reachable by Railway (it needs GitHub access to your repo).
- Railway should use the `Dockerfile` automatically (config is in `railway.json`). If it's trying
  a Nixpacks/buildpack build instead, set the service **Builder = Dockerfile** in Settings.
- The Dockerfile build context was verified on the laptop — it boots cleanly — so a build failure
  here is almost always repo access or builder selection, not the code.

---

## Fix E — never deployed

1. **Make the repo private first:** github.com/fortunainc/founder-btc-alpha → Settings → Danger
   Zone → Change visibility → Private.
2. Railway → **New Project → Deploy from GitHub repo** → `fortunainc/founder-btc-alpha`.
3. Add the four Variables (values in the deploy checklist / your last message from the terminal):
   `KALSHI_KEY_ID`, `KALSHI_PRIVATE_KEY_PEM` (Fix A format), `SUPABASE_URL` (Fix C), and
   `SUPABASE_SERVICE_ROLE_KEY`. **Do not** set `CAPTURE_DRY_RUN`.
4. Settings → Deploy → **Replicas = 1** (more than one double-writes into append-only tables).
5. Settings → Networking → **no domain** (it's a worker).

---

## Step 2 — confirm it's actually writing

In the Railway log, within ~90s of a good deploy you want **all** of:

- `PREFLIGHT:` block, every line `[OK ]`
- `[sink] using Supabase sink (schema founder_alpha)` — **not** dry-run
- `discovered window KXBTC15M-… strike=…`
- `flushed N row(s) (supabase)` every ~5s
- `heartbeat … venues[coinbase=ok kraken=ok bitstamp=ok gemini=ok]` each minute

**Expect `1/4 sealed | PASS: b1=realized_vol_unavailable …` for the first ~12 minutes.** That's
the cold-start vol buffer filling; it's correct, not a fault. It reaches `4/4` within ~15 min.

## Step 3 — stop the laptop worker (IMPORTANT)

The laptop is writing right now. Once Railway shows `flushed … (supabase)`, the laptop and
Railway are **both** writing into append-only tables — permanent duplicates.

On the laptop, in Terminal:
```
pkill -f 'node src/worker.js'
```
Then tell the terminal agent (or check) that only Railway is writing.

---

## If stuck

Paste the first ~20 lines of the Railway log — especially the `PREFLIGHT:` block — to the
terminal agent. That block names the fault directly.
