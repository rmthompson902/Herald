# launchd auto-start

Two per-user LaunchAgents (not system LaunchDaemons - QLab itself only runs in a logged-in
GUI session, so these start alongside that same login rather than before anyone logs in):

- `com.sitewide-audio-messaging.node-red.plist` - the scheduling engine
- `com.sitewide-audio-messaging.webapp.plist` - the FastAPI operator UI

Both `RunAtLoad` (start automatically at login) and `KeepAlive` (restart automatically if the
process ever exits/crashes). No ordering dependency between them - the webapp degrades
gracefully if it comes up before Node-RED is ready. QLab itself is not managed by either plist;
it needs its own separate auto-launch (e.g. a Login Item) if unattended startup should include it.

Paths inside both plists are hardcoded to this machine's actual locations
(`/Users/ryanthompson/Documents/_dev/Sitewide-Audio-Messaging`, `/opt/homebrew/bin/node`) -
edit them first if this is ever deployed to a different machine or user account.

## Install

```
cp deploy/launchd/com.sitewide-audio-messaging.node-red.plist ~/Library/LaunchAgents/
cp deploy/launchd/com.sitewide-audio-messaging.webapp.plist ~/Library/LaunchAgents/
launchctl load ~/Library/LaunchAgents/com.sitewide-audio-messaging.node-red.plist
launchctl load ~/Library/LaunchAgents/com.sitewide-audio-messaging.webapp.plist
```

Check status:

```
launchctl list | grep sitewide-audio-messaging
```

Logs land in `logs/launchd-*.log` (stdout) and `logs/launchd-*-error.log` (stderr) - separate
from `logs/events-*.log` (the business event log) and Node-RED's own console output.

## Uninstall / stop

```
launchctl unload ~/Library/LaunchAgents/com.sitewide-audio-messaging.node-red.plist
launchctl unload ~/Library/LaunchAgents/com.sitewide-audio-messaging.webapp.plist
rm ~/Library/LaunchAgents/com.sitewide-audio-messaging.*.plist
```
