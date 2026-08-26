# ADR 0012: `/cueLists` over TCP+SLIP, not UDP

## Status

Accepted.

## Context

Reported by the operator: after configuring zones and adding a cue schedule against a real,
large workspace ("20260824 US Open 2026.qlab5"), the schedule showed no zone assigned, even
though the cue's Messaging Audio Patch was correctly configured in both QLab and
`config/audio-patch-map.json`.

Traced to `qlabProtocol.getCueLists()` — the query `zoneResolver.js` depends on to walk
QLab's full cue tree and resolve a cue's zone(s) — reliably failing against this workspace
with "OSC request timed out waiting for /reply/cueLists", every time, at exactly the
client's 3000ms timeout (`DEFAULT_TIMEOUT_MS`, `lib/osc/oscClient.js`). The flat, unvarying
3.00s failure time (not organic latency, which would vary) was the first sign this wasn't a
"QLab is slow" problem.

Confirmed independently of Herald's own code, using standalone probes (`oscsend`/raw `nc`,
then a hand-rolled TCP+SLIP client) run directly against the live QLab instance:

- Bumping the timeout was investigated and ruled out first: waiting up to 45 real seconds
  for a `/cueLists` reply over UDP got zero bytes back, every time. The reply isn't slow, it
  never arrives, at any timeout.
- With QLab's own Console logging enabled, sending `/cueLists` confirmed QLab genuinely
  builds and attempts to send a reply — described in the console log as "a very very very
  long reply."
- Measuring it directly: QLab's real `/cueLists` reply for this workspace is **~653,000
  bytes**. A single UDP datagram's practical ceiling is **~65,507 bytes** — roughly 1/10th
  the size. QLab attempts the send, but the OS's UDP layer cannot transmit a payload that
  size as one datagram, so it never leaves — this is a hard protocol ceiling, not a
  timing/network-hiccup issue.
- The identical reply, sent over TCP using QLab's documented SLIP (RFC 1055) framing,
  arrived cleanly in ~40ms.

This cascades: `getCueLists()` failing means `zoneResolver.js` never completes zone
resolution, so a schedule never gets a zone, and every real fire path that depends on it
(`onDue`, `createSchedule`, `updateSchedule`, `playNow`, and the 5-minute
`periodicCueRefresh` sweep — see `node-red/lib/handlers/schedules.js` and
`node-red/lib/refreshCueCache.js`) either warns-and-skips or reports an error. This affects
any workspace whose cue tree serializes past ~65KB, which for a real multi-day show with a
large cue count is the normal case, not an edge case.

## Decision

Add a dedicated TCP+SLIP path to `OscClient` (`lib/osc/oscClient.js`), used only by
`getCueLists()`:

- **New method, not a new class**: `OscClient.requestOverTcp(address, args, { timeoutMs })`,
  alongside the existing `request()`/`requestOptionalReply()`/`send()`. `qlabProtocol.js`
  still takes a single client.
- **`osc.TCPSocketPort`**, already present in the installed `osc` npm dependency
  (`node_modules/osc/src/platforms/osc-node.js`) — it extends `SLIPPort` internally, so RFC
  1055 framing (confirmed to match QLab's own convention, live) is automatic. No new
  dependency.
- **Per-call lifecycle**: each call opens a fresh TCP connection to the same
  `qlabOscHost`/`qlabOscPort` already used for UDP, sends one message, awaits one reply,
  then always closes the connection — no persistent connection, no reconnect logic. At
  realistic show-day call volume (dozens of schedules, some under 5-minute intervals) the
  connect/close overhead is negligible on loopback, and this means a QLab restart mid-show
  needs no special handling — the next call just reconnects.
- **Scope**: `getCueLists()`/`listCues()` only. Every other `QlabProtocol` method (thump,
  keepAlive, cue duration/patch/uniqueID, play/stop, `/updates`) stays on UDP unchanged —
  their replies are small, bounded values, nowhere near the datagram ceiling.
- **No UDP fallback**: `getCueLists()` always uses TCP now; the prior
  `client.request('/cueLists')` call is fully replaced, not attempted first. A UDP-first
  fallback would reintroduce a guaranteed multi-second wait (for the UDP attempt to time
  out) on every call against any large workspace, forever, for no benefit.
- **Shared timeout**: reuses the existing `DEFAULT_TIMEOUT_MS = 3000` — no new timeout
  constant. Real observed TCP latency (~40ms) leaves ample margin.
- **`HealthMonitor` unaffected**: `core.health.isArmed()` remains purely UDP-heartbeat-based
  (thump/keepAlive/`/disconnect`) — it never treated `/cueLists` replies (UDP or TCP) as a
  liveness signal in the first place. A TCP `getCueLists()` failure surfaces exactly as
  before: rejected, caught by `refreshCueCache`'s existing try/catch, turned into
  `{ error }`, already handled by every caller.
- **Does not emit `'message'` on `OscClient`** for a TCP reply, unlike the UDP path.
  `getCueLists()` runs on every schedule create/update/fire and every periodic sweep;
  routing a ~653KB payload through the same logging path as every other OSC message would
  be a real log-bloat regression. `HealthMonitor`'s own message listener only ever inspected
  messages ending in `/disconnect`, so this has no effect on health tracking.
- The envelope-parsing/status-check logic (`resolve` on `status: ok`, `reject` on denial or
  a malformed reply) is shared between the UDP and TCP paths via an extracted
  `_settleFromReply` helper, rather than duplicated.

7 new/updated unit tests: 6 in `oscClient.test.js` (successful TCP round trip and connection
close; timeout and close; connection error and close; QLab-denied reply over TCP; no
`'message'` emitted on `OscClient` for a TCP reply; no double-settle/double-close on late
events) and 1 in `qlabProtocol.test.js` (`getCueLists()` calls `requestOverTcp`, never
`request`) plus the existing `getCueLists`/`listCues` tests updated to assert against
`requestOverTcp` instead of `request`. All unit tests pass. Live-verified against the real
"20260824 US Open 2026.qlab5" workspace: `GET /api/cues` (backed by `listCues()`), previously
failing with the UDP timeout, now returns the full real cue list promptly; a schedule
targeting a cue in that workspace now resolves its configured zone correctly instead of
showing "Not Yet Assigned".

See `test/fixtures/qlab-osc-findings.md` for the raw empirical measurements.
