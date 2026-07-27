# launchd auto-start

Two per-user LaunchAgents (per-user, not system-wide, since QLab only runs in a logged-in GUI
session): `com.sitewide-audio-messaging.node-red.plist` (scheduling engine) and
`...webapp.plist` (FastAPI UI). Both auto-start at login (`RunAtLoad`) and auto-restart on
crash (`KeepAlive` + a 10s `ThrottleInterval` floor so a persistent failure crash-loops at a
bounded rate instead of as fast as the OS allows). No ordering dependency - the webapp
degrades gracefully if it comes up before Node-RED. QLab itself isn't managed by either plist.

Paths inside both plists are hardcoded to this machine - edit them first if deploying
elsewhere.

## Install

1. Stop any manually-running dev instances first (two processes fighting over the same port
   will both fail):
   ```
   lsof -i :1880 -i :8000
   kill -TERM <pid> <pid>
   ```
2. Copy and load:
   ```
   cp deploy/launchd/com.sitewide-audio-messaging.node-red.plist ~/Library/LaunchAgents/
   cp deploy/launchd/com.sitewide-audio-messaging.webapp.plist ~/Library/LaunchAgents/
   launchctl load ~/Library/LaunchAgents/com.sitewide-audio-messaging.node-red.plist
   launchctl load ~/Library/LaunchAgents/com.sitewide-audio-messaging.webapp.plist
   launchctl list | grep sitewide-audio-messaging
   ```
   Real PID + exit status `0` = running. `-` PID + nonzero exit status = crashing on startup -
   check `logs/launchd-*-error.log` (see the TCC gotcha below, the most likely cause).
3. Verify for real, not just PID presence:
   ```
   curl -s http://127.0.0.1:1880/api/health   # expect {"state":"connected","armed":true}
   curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8000/schedules   # expect 200
   ```
4. Prove `KeepAlive` actually works rather than assuming it:
   ```
   kill -9 <a pid from step 2>
   # re-check the health curl above - should self-heal within a few seconds, new PID
   ```

Logs: `logs/launchd-*.log` (stdout) / `logs/launchd-*-error.log` (stderr) - separate from
`logs/events-*.log` (business events) and Node-RED's own console output.

## macOS TCC / Full Disk Access gotcha

Symptom: `logs/launchd-webapp-error.log` shows `PermissionError: ... Operation not permitted:
'.../.venv/pyvenv.cfg'` and the webapp crash-loops. Cause: the venv's `uvicorn` shebang
invokes a Homebrew "framework" Python build that re-execs itself internally, and a
launchd-spawned process doesn't inherit the folder access your Terminal session already has -
**both** binaries in that re-exec chain need an explicit grant, not just one. Fix: System
Settings -> Privacy & Security -> Full Disk Access -> "+" -> `Cmd+Shift+G` (paste, don't
navigate Finder - easy to land on the wrong nested binary) -> add both:
```
/opt/homebrew/Cellar/python@3.12/3.12.3/Frameworks/Python.framework/Versions/3.12/bin/python3.12
/opt/homebrew/Cellar/python@3.12/3.12.3/Frameworks/Python.framework/Versions/3.12/Resources/Python.app/Contents/MacOS/Python
```
Then `launchctl unload`/`load` the webapp plist again. Node-RED's `node` binary didn't need
this on this machine - if it ever does elsewhere, same fix, path from `which node` there.

## Restarting to pick up code changes

Don't use a bare `kill` - it races `KeepAlive`. Use the agent-aware restart instead:
```
launchctl kickstart -k gui/$(id -u)/com.sitewide-audio-messaging.node-red
launchctl kickstart -k gui/$(id -u)/com.sitewide-audio-messaging.webapp
```

## Stop / uninstall

**Stop for now** (stays installed - `RunAtLoad`/`KeepAlive` resume next login unless you also
remove the plists below):
```
launchctl unload ~/Library/LaunchAgents/com.sitewide-audio-messaging.node-red.plist
launchctl unload ~/Library/LaunchAgents/com.sitewide-audio-messaging.webapp.plist
```

**Fully remove** (same as above, then delete the copies):
```
launchctl unload ~/Library/LaunchAgents/com.sitewide-audio-messaging.node-red.plist
launchctl unload ~/Library/LaunchAgents/com.sitewide-audio-messaging.webapp.plist
rm ~/Library/LaunchAgents/com.sitewide-audio-messaging.*.plist
```

Verify nothing's left running, don't just trust the commands succeeded:
```
launchctl list | grep sitewide-audio-messaging   # expect no output
lsof -i :1880 -i :8000                           # expect no output
```

Optional, neither required nor harmful to skip:
- The Full Disk Access grants from the TCC gotcha above (System Settings -> Privacy &
  Security -> Full Disk Access) - only matters if this machine won't run the webapp this way
  again.
- `logs/launchd-*.log` / `-error.log` - just history, not config; delete or leave them.
