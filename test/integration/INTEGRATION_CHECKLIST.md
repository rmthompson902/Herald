# Integration Checklist

Hands-on verification against a real QLab workspace - none of this is automatable (see
`docs/claude-plan.md`'s Verification section). Most of it was already exercised live during
normal phase-by-phase development rather than saved up for the end; this doc collects that
history in one place and tracks what's still open before the production QLab Audio license
purchase.

## Already verified (during Phases 0-10)

- [x] **QLab OSC Controls permissions** - Workspace Settings -> Network -> OSC Controls needs
      read/edit/control enabled with no passcode. QLab's default denies *every* OSC command,
      including basic cue triggering, until this is set. Confirmed in Phase 0; easy to forget
      to re-check on the production machine's workspace when it's first opened there.
- [x] **OSC connectivity + keepalive past 61s** - `/thump` heartbeat and `/udpKeepAlive` verified
      to keep the UDP registration alive past QLab's 61s idle-drop window (Phase 0/2).
- [x] **Duration/levels accuracy on real cues** - `/cue/{n}/duration` and `/cue/{n}/levels`
      verified against real cue data, including the two-stage gating logic in
      `zoneResolver.parseLevelsMatrix` (Phase 0/4) - e.g. cue 101 correctly resolved to Zone 1
      only (the gated case), cues 102-104 correctly resolved to their expected zone sets.
- [x] **Live cue-list enumeration** - `/cueLists` + recursive flattening verified against the
      real workspace tree (Phase 0/5).
- [x] **Wall-clock single-schedule firing** - a seeded schedule fired repeatedly through
      cron-plus into real QLab playback, unattended, across Phases 3 and onward.
- [x] **Same-zone collision, both free paths** - verified via both the duration-timer fallback
      and a real `/updates`-confirmed early stop (Phase 8), including the confirm-before-fire
      retry loop for a cue QLab still reports running.
- [x] **VOG stop+play+non-resume** - verified for both a single-zone VOG cue and an all-zone
      one (Phase 9): real OSC `/stop` sent to every confirmed occupant in scope (confirmed via
      QLab's own reactive `/updates` push, not just bookkeeping), VOG cue played once
      afterward, and everything it interrupted was dropped rather than resumed.
- [x] **Health-monitor disconnect/reconnect + scheduler disarm/rearm** - verified against a
      real QLab quit/relaunch mid-session (Phase 10): `health_disconnect` logged immediately,
      zero schedule fires during the outage (confirming `isArmed()` correctly gated every due
      schedule rather than queuing or replaying them), `health_reconnect` logged on QLab coming
      back, normal firing resumed on the very next tick.
- [x] **Node-RED restart correctness (single restart)** - restarted mid-test during Phase 8 and
      again during Phase 10/11; auto-fires resumed on schedule afterward with no duplicate or
      missing cron-plus jobs observed.
- [x] **Free-tier nag-dialog risk** - confirmed in Phase 0 that OSC control/query/update-feed
      functionality all work on the unlicensed tier with no nag dialog interrupting anything.
- [x] **Restart correctness under repeated/rapid restarts (Phase 11)** - 5 consecutive real
      Node-RED restarts back-to-back (confirmed via a distinct process each time, not a failed
      kill silently reusing the old one - an actual methodology bug caught and fixed mid-test:
      the process's argv doesn't literally contain its own script path in `ps`'s output, since
      Node-RED sets its own process title, so the first attempt's `pkill -f` pattern silently
      matched nothing and 4 of the 5 "restarts" were really just re-hitting the one still-alive
      original process). Every one of the 5 real restarts logged `Startup: rebuilding 4
      cron-plus directive(s)` - identical every time (1 `toRemoveAllDynamic` + 3 enabled
      schedules, since `cronSync.rebuildAll` always wipes every dynamic job before re-adding
      from `schedules`, making each rebuild idempotent by construction) - and came back
      `connected`/`armed` immediately. The event log across the whole test window shows exactly
      5 `health_reconnect` lines (one per restart) and zero duplicate/orphaned queue entries.
      Also ran 3 consecutive `uvicorn` restarts (same distinct-PID discipline) - every page
      (`/`, `/schedules`, `/vog`, `/status`, `/history`) returned 200 immediately after each one.

## Open

- [ ] **launchd unattended auto-start, both processes** - plist templates are in
      `deploy/launchd/` (not yet installed - see that directory's README). Needs a real
      logout/login or reboot to verify RunAtLoad actually fires unattended, that the webapp's
      graceful "Node-RED unreachable" degradation covers whichever process happens to come up
      first, and that the scheduler correctly stays disarmed until QLab (started separately -
      QLab itself isn't managed by these plists) is confirmed live.
- [ ] **Multi-day soak** - inherently needs elapsed real time, not something to "finish" in one
      sitting. Covers: no memory growth in either process, `logs/events-*.log` daily rotation
      actually rolling over at midnight, 30-day retention actually pruning old files, and the
      queue engine behaving correctly across many real natural collisions rather than the
      manually-engineered ones used during development.
- [ ] **Production workspace re-check** - once the production QLab Audio license is purchased
      and the real venue workspace is open on the deployment machine, re-run the OSC Controls
      permission check above against *that* workspace specifically (it's a per-workspace
      setting, not global) and re-verify zone-map.json's Dante channel numbers still match the
      real physical routing.
