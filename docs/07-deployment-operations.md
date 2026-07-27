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

> Paths inside both plists are hardcoded to this machine — edit them first if deploying elsewhere.

## Install

1. **Stop any manually-running dev instances first** (two processes fighting over a port both fail):
   ```bash
   lsof -i :1880 -i :8000
   kill -TERM <pid> <pid>
   ```
2. **Copy and load:**
   ```bash
   cp deploy/launchd/com.herald.node-red.plist ~/Library/LaunchAgents/
   cp deploy/launchd/com.herald.webapp.plist ~/Library/LaunchAgents/
   launchctl load ~/Library/LaunchAgents/com.herald.node-red.plist
   launchctl load ~/Library/LaunchAgents/com.herald.webapp.plist
   launchctl list | grep herald
   ```
   A real PID + exit status `0` means running. A `-` PID + nonzero exit means it's crashing on
   startup — check `logs/launchd-*-error.log` (the TCC gotcha below is the most likely cause).
3. **Verify for real, not just PID presence:**
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

**Fix:** System Settings → Privacy & Security → Full Disk Access → "+" → `Cmd+Shift+G` (paste the
path, don't navigate Finder — easy to land on the wrong nested binary) → add both:

```
/opt/homebrew/Cellar/python@3.12/3.12.3/Frameworks/Python.framework/Versions/3.12/bin/python3.12
/opt/homebrew/Cellar/python@3.12/3.12.3/Frameworks/Python.framework/Versions/3.12/Resources/Python.app/Contents/MacOS/Python
```

Then `launchctl unload`/`load` the webapp plist again. Node-RED's `node` binary didn't need this on
this machine; if it ever does elsewhere, same fix with the path from `which node`.

## Stop / uninstall

**Stop for now** (stays installed — resumes next login unless you also remove the plists):
```bash
launchctl unload ~/Library/LaunchAgents/com.herald.node-red.plist
launchctl unload ~/Library/LaunchAgents/com.herald.webapp.plist
```

**Fully remove** (as above, then delete the copies):
```bash
rm ~/Library/LaunchAgents/com.herald.*.plist
```

**Verify nothing's left** — don't just trust the commands succeeded:
```bash
launchctl list | grep herald   # expect no output
lsof -i :1880 -i :8000                            # expect no output
```

The Full Disk Access grants and old `logs/launchd-*.log` files are history, not config — leave or
delete them; neither is required.
