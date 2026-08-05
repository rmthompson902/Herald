# 07 · Deployment & operations

Both services run under **launchd** on the same Mac as QLab. The plist templates live in
[`deploy/launchd/`](../deploy/launchd).

## The model

Two per-user LaunchAgents (per-user, not system-wide, since QLab only runs in a logged-in GUI
session):

- `com.herald.node-red` — the scheduling engine.
- `com.herald.webapp` — the FastAPI UI.

Both auto-start at login (`RunAtLoad`) and auto-restart on crash (`KeepAlive`), with a 10s
`ThrottleInterval` floor so a persistent failure crash-loops at a bounded rate. There is **no
ordering dependency** — the webapp degrades gracefully if it comes up before Node-RED. QLab itself
is not managed by either plist.

> The committed plists are **templates** (`deploy/launchd/*.plist.template`) — `deploy/launchd/install.sh`
> renders and loads them for this machine's actual paths, so nothing needs hand-editing regardless of
> where the repo is checked out.

## Prerequisites

Install once, before anything else on a fresh machine:

```bash
brew install node          # Node v26 / npm 11 — no other version is tested against
brew install python@3.12   # any 3.12+ should work
```

Plus QLab itself, running locally with OSC control enabled (Workspace Settings → Network → OSC
Controls, read/edit/control, no passcode) — see
[06 · Development](06-development.md#running-locally).

Homebrew specifically (not the macOS system interpreter, `pyenv`, etc.) is what's actually verified
here — its "framework" Python build is what the [TCC/Full Disk Access
gotcha](#macos-tcc--full-disk-access-gotcha) below is written against. A different Python may work,
but its failure modes (if any) aren't documented.

## First-time setup

Do this once, before the steps below. Skip anything already done.

1. **Clone the repo** to wherever it will live permanently — any path works, nothing to configure
   afterward (see **Install** below).
2. **Install dependencies:**
   ```bash
   npm install
   python3.12 -m venv webapp/.venv && webapp/.venv/bin/pip install -r webapp/requirements-dev.txt
   ```
   Use `python3.12` explicitly, not bare `python3` — on a Mac with Xcode Command Line Tools
   installed, plain `python3` on `PATH` can resolve to Apple's CLT shim (`/usr/bin/python3` → CLT's
   bundled 3.9) instead of the Homebrew build from **Prerequisites** above, even after
   `brew install python@3.12`. A venv built against the wrong interpreter installs and runs fine in
   a Terminal session but fails under launchd — see the [TCC gotcha
   below](#macos-tcc--full-disk-access-gotcha). Sanity-check before moving on:
   ```bash
   cat webapp/.venv/pyvenv.cfg   # expect version = 3.12.x and a /opt/homebrew/... home path
   ```
   (`npm install` also registers the Husky pre-commit hooks via its `prepare` script — harmless on a
   deploy-only machine, matters if you'll also develop here.)
3. **Set the venue's zone map.** [`config/audio-patch-map.json`](../config/audio-patch-map.json) is
   prefilled with 4 zones, patch IDs, duck/unduck
   cue numbers that matches the example workspace. Deploying to a different venue or QLab show file? Edit it to match first. See
   [05 · Configuration](05-configuration.md#zone-map-configaudio-patch-mapjson). No `.env` file is
   required for a same-venue deploy: every setting already has a hardcoded default matching this
   venue (see [05 · Configuration](05-configuration.md)) — only add `config/.env` / `webapp/.env` if
   you need to override one of them.

There is **no separate database-migration step** — `data/schedule.db` and its schema are created
automatically the first time Node-RED starts (see [`lib/db/database.js`](../lib/db/database.js) and
[05 · Configuration](05-configuration.md#sqlite-schema)); the `data/` and `logs/` directories are
likewise created on demand.

## Install

1. **Stop any manually-running dev instances first** (two processes fighting over a port both fail):
   ```bash
   lsof -i :1880 -i :8000
   kill -TERM <pid> <pid>
   ```
2. **Render and load:**
   ```bash
   npm run deploy:install
   ```
   This resolves this checkout's real path and `node` binary, renders both
   `deploy/launchd/*.plist.template` into `~/Library/LaunchAgents/`, loads them, and runs the health
   checks from step 3 automatically — it's safe to re-run any time (after `git pull`, after moving
   the repo, whatever). A real PID + exit status `0` in its `launchctl list | grep herald` output
   means running; a `-` PID + nonzero exit means it's crashing on startup — check
   `logs/launchd-*-error.log` (the TCC gotcha below is the most likely cause).
3. **Verify for real, not just PID presence** (also run automatically by the script above — useful to
   re-run standalone later):
   ```bash
   curl -s http://127.0.0.1:1880/api/health          # expect {"state":"connected","armed":true}
   curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8000/schedules   # expect 200
   ```
4. **Prove `KeepAlive` actually works** rather than assuming it:
   ```bash
   kill -9 <a pid from step 2>   # re-check the health curl — should self-heal within seconds, new PID
   ```

Logs: `logs/launchd-*.log` (stdout) / `logs/launchd-*-error.log` (stderr), separate from
`logs/events-*.log` (business events — see [05 · Configuration](05-configuration.md#logging)) and
Node-RED's own console output.

## Restarting to pick up code changes

Don't use a bare `kill` — it races `KeepAlive`. Use the agent-aware restart:

```bash
launchctl kickstart -k gui/$(id -u)/com.herald.node-red
launchctl kickstart -k gui/$(id -u)/com.herald.webapp
```

## Operational behavior

- **Startup gate.** The scheduler stays disarmed until QLab is confirmed live; on boot, cron-plus
  jobs are fully rebuilt from `schedules`, so no timing state needs to survive a restart.
- **QLab restart.** If QLab quits mid-session the health monitor flips to `disconnected` and every
  schedule due during the outage is skipped (not queued or replayed); it rearms and resumes on the
  next tick once QLab responds again.

## macOS TCC / Full Disk Access gotcha

**Symptom:** `logs/launchd-webapp-error.log` shows `PermissionError: ... Operation not permitted:
'.../.venv/pyvenv.cfg'` and the webapp crash-loops. **Cause:** the venv's `uvicorn` shebang invokes
a Homebrew "framework" Python that re-execs itself, and a launchd-spawned process doesn't inherit
the folder access your Terminal session has — **both** binaries in that re-exec chain need an
explicit grant.

**Check the interpreter first.** This exact symptom also shows up if the venv wasn't built against
Homebrew's `python@3.12` in the first place (see the `python3.12` note in **First-time setup**
above) — most often because bare `python3` resolved to Apple's Command Line Tools shim instead:
```bash
cat webapp/.venv/pyvenv.cfg
```
If `home` points under `/Library/Developer/CommandLineTools/...` instead of `/opt/homebrew/...`,
stop here and rebuild the venv first — the Full Disk Access grant below targets the *Homebrew*
re-exec chain and won't fix a CLT-built venv:
```bash
rm -rf webapp/.venv
python3.12 -m venv webapp/.venv && webapp/.venv/bin/pip install -r webapp/requirements-dev.txt
```

**Fix:** System Settings → Privacy & Security → Full Disk Access → "+" → `Cmd+Shift+G` (paste the
path, don't navigate Finder — easy to land on the wrong nested binary) → add both binaries in the
re-exec chain. Resolve their exact paths on your machine (version-specific, don't hardcode them):

```bash
P1=$(readlink -f webapp/.venv/bin/python3)
P2="$(dirname "$(dirname "$P1")")/Resources/Python.app/Contents/MacOS/Python"
echo "$P1"; echo "$P2"
```

Then `launchctl unload`/`load` the webapp plist again (or just re-run `npm run deploy:install`).
Node-RED's `node` binary didn't need this on this machine; if it ever does elsewhere, same fix with
the path from `which node`.

## Stop / uninstall

```bash
npm run deploy:uninstall
```

Unloads both agents and removes their rendered plists from `~/Library/LaunchAgents/` — nothing
resumes at next login until you `npm run deploy:install` again. **The database is left alone by
default** — uninstalling the launchd registration isn't the same as wiping the app's data, so a
reinstall picks up right where the schedules/VOG messages left off.

Want a genuinely clean slate (e.g. tearing down a test setup)?
```bash
deploy/launchd/uninstall.sh --purge-data
```
This moves `data/` aside to a timestamped `data.bak.<timestamp>/` rather than deleting it outright —
delete that yourself once you're sure you don't need it. The next `install.sh` + Node-RED start then
creates a fresh, empty database (same auto-create behavior as **First-time setup** above).

**Verify nothing's left** — don't just trust the command succeeded:
```bash
launchctl list | grep herald   # expect no output
lsof -i :1880 -i :8000                            # expect no output
```

The Full Disk Access grants and old `logs/launchd-*.log` files are history, not config — leave or
delete them; neither is required.
