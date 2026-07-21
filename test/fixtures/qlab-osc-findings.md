# QLab OSC — Confirmed Behavior (Phase 0 spike, QLab 5.6.2, 2026-07-19)

Captured against a real running QLab 5.6.2 workspace (`20260717 test workspace.qlab5`,
workspace_id `310C5F76-7049-4413-896A-452758323543`). Raw traffic in
`qlab-spike-capture.jsonl`. This file is the reference for `lib/osc/qlabProtocol.js` and
`lib/zones/zoneResolver.js` — prefer these confirmed facts over the published OSC docs
where they conflict.

## No unlicensed-tier nag dialog observed

Confirmed with the project owner: no interruptive "unlicensed"/demo dialog appears on launch
or periodically on the free tier in their experience so far. Not expected to block unattended
auto-start. (Re-verify this holds on the actual production machine during Phase 8, since it's
based on the dev machine's observed behavior, not a documented guarantee.)

## OSC access must be explicitly enabled per-workspace

QLab's default OSC Controls (Workspace Settings → Network) deny all workspace-scoped
commands (`{"status":"denied"}`) unless read/edit/control permissions are enabled for
commands with no passcode. This is **not** a license restriction — it reproduced
identically on the unlicensed free tier once permissions were enabled. **Every deployed
QLab workspace needs this enabled**, or nothing in this system works. Worth a note in the
deployment/setup runbook, not just a dev-machine gotcha.

The workspace-agnostic `/workspaces` query works regardless of these permissions (returns
`version`, `displayName`, `udpReplyPort`, `uniqueID`, `port` for each open workspace) — useful
as a permission-independent liveness probe if we ever need one.

## Reply envelope

Every query reply comes back on `/reply` + original address, as a single JSON string arg:

```
/reply/cue/101/duration  ["{\"status\":\"ok\",\"data\":9.62,\"workspace_id\":\"...\",\"address\":\"/workspace/{id}/cue/101/duration\"}"]
```

Parse: `JSON.parse(msg.args[0].value)`, check `.status === 'ok'`, use `.data`.

## Confirmed working addresses

| Address | Notes |
|---|---|
| `/thump` | Replies `{"status":"ok","data":"thump",...}`. Workspace-scoped reply address despite being sent unscoped. |
| `/udpKeepAlive` (int or bool arg) | **No reply at all**, with either argument type — confirmed not a bug, it's silent-ack by design. Don't wait on a reply for this one. **Confirmed effective**: sent once at t=0, then a `/thump` probe at t=70s (past the documented 61s no-activity timeout) still got a reply — the keepalive genuinely prevents the drop, not just a silent no-op. |
| `/cueLists` | Returns the full nested cue tree: cue lists/carts contain `cues: [...]`, each cue has `number`, `uniqueID`, `type`, `listName` (often the underlying filename), `name` (operator-set display name, often blank), `armed`, and recurses via its own `cues` array for Group/Cart children. This alone gives us cue enumeration + `uniqueID` mapping — no separate per-cue `uniqueID` query needed if we already fetched `/cueLists`. |
| `/cue/{number}/duration` | Returns a plain float, seconds. |
| `/cue/{number}/levels` | Returns the level matrix — see below. |
| `/cue/{number}/uniqueID` | Returns QLab's internal cue id (matches what `/cueLists` already shows). |
| `/cue/{number}/valuesForKeys` (JSON array of key names, e.g. `["duration","uniqueID"]`) | Bulk query, returns a single JSON object with all requested keys — cheaper than separate calls if we need duration+uniqueID+levels together. **Worth trying `"levels"` as a key here too** to fold it into the same round trip. |
| `/cue/{number}/start`, `/cue/{number}/stop` | Confirmed trigger/stop both work once OSC permissions are enabled. **Important asymmetry**: QLab only sends an explicit `/reply/cue/{n}/start` (or `/stop`) message on **denial** - a successful start/stop plays/stops the cue with no reply at all. A naive request/await-reply wrapper (our first cut of `oscClient.request()`) times out on every successful call despite the cue actually working. Fixed via `oscClient.requestOptionalReply()`, which resolves on silence but still rejects if an explicit denied reply does arrive within the window - used by `qlabProtocol.playCue`/`stopCue`. Confirmed live: `request()` timed out on a real successful `/cue/101/start` (audibly confirmed playing) before this fix; `requestOptionalReply()` resolves cleanly after the fix. |
| `/updates 1` / `/updates 0` | Subscribe/unsubscribe — see below. |

## `/updates` push events — no payload, fires for the whole ancestry chain

Triggering `/cue/101/start` produced three near-simultaneous push notifications, each with
**empty args**:

```
/update/workspace/{ws_id}/cue_id/{cartUniqueID}      -- the containing Cart ("Zone 1")
/update/workspace/{ws_id}/cue_id/__root__            -- the root cue list
/update/workspace/{ws_id}/cue_id/{cueUniqueID}       -- the cue itself
```

...and the same three fired again ~100ms later (looks like one notification per internal
state tick, not one per logical event). Stopping the cue produced the identical pattern.

**Implication for `healthMonitor`/`zoneQueueEngine`:** the push event only tells us *something
about cue X changed* — never *what*. On receiving `/update/.../cue_id/{id}`, we must follow up
with an explicit query (`/cue/{id}/isRunning` or `valuesForKeys`) to learn the actual new
state. Budget for that round trip in the "confirm cue actually stopped" collision-engine path.
`__root__` and cart-level events can likely be ignored — we only care about updates keyed by a
`uniqueID` we're actively tracking in `cue_cache`.

This also confirms the `cue_cache.qlab_internal_id` reconciliation design was necessary and
correct: `/updates` is keyed by QLab's internal uniqueID, never by cue number.

## Levels matrix — real structure and the zone-derivation threshold

`/cue/101/levels` returned `[[0,0,0],[0,0,-60],[0,-60,0]]` — a 3×3 matrix, `[inChannel][outChannel]`,
index 0 = master row/column (matches the OSC dictionary's documented convention), indices 1-2 =
the two real channels on this dev machine's stereo test output device.

Confirmed with the project owner (who manually adjusted the cue's Levels tab to verify): QLab's
Levels tab has three distinct controls that all feed into this one matrix:
- **Main level** — one overall gain trim for the whole cue.
- **Per-channel level** — per input-channel gain.
- **Crosspoint matrix** — per (input channel → output channel) routing gain, this is the actual
  zone-routing mechanism for the real venue (each output channel on the Dante interface = one
  zone; both stereo input channels get summed into whichever single output channel represents
  the target zone).

The matrix returned by `/levels` already reflects the **composite effective gain** (main level +
per-channel + crosspoint combined) — there's no need to separately fetch and combine those three
controls. QLab represents "-inf" (fully muted) as **-60dB** in this OSC payload, not a literal
`-Infinity` value.

**Zone-derivation rule for `zoneResolver.parseLevelsMatrix` (revised — see below, confirmed with
project owner against a second real data point):**

Re-queried `/cue/101/levels` after the owner deliberately set: main level -6dB, input channel 1
level 0dB, input channel 2 level -60/muted, crosspoint ch1→out1 -2dB, crosspoint ch2→out2 -4dB.
Result:

```
                master(in)   ch1(in)    ch2(in)
master(out)  [ -6.0000,      0,         -60      ]   <- row 0 = each input channel's OWN level fader
out ch1      [ 0,            -2.0000,   -60      ]   <- crosspoint gains INTO output ch1
out ch2      [ 0,            -60,       -4.0000  ]   <- crosspoint gains INTO output ch2
```

The matrix has **two independent, cascading gain stages**, not one flat crosspoint grid:

- `matrix[0][X]` — input channel X's own level fader (row 0 doubles as "each channel's direct
  gain", not literally a routing destination).
- `matrix[Y][X]` (Y≥1) — the crosspoint routing gain from input channel X to real output
  channel Y.

Both stages are in dB, so they cascade (add): a signal only reaches output Y through input X if
**neither** stage is at the silence floor. In the data above, ch2→out2's crosspoint is an audible
-4dB, but channel 2's own input fader is muted at -60 — so output 2 is correctly silent overall,
even though the crosspoint cell alone looks audible. Checking the crosspoint cell in isolation
(the original, now-superseded plan) would have wrongly called output 2 "in zone."

**Confirmed rule:** output channel Y (Y≥1) is in the cue's zone set if there exists any input
channel X (X≥1) where `matrix[0][X] > -59 AND matrix[Y][X] > -59`. The master bus itself
(`matrix[0][0]`) is deliberately **not** checked as a third gate — the project owner confirmed
it will always be left at/near 0dB (used only for relative trim between cues), never used to
fully silence a cue, so treating it as always-open is a safe, explicit assumption (document it
as a comment in `parseLevelsMatrix`, don't silently bake it in unexplained).

**SUPERSEDED as of the patch-rework spike below — see that section.** The venue moved to one
dedicated Messaging Audio Patch per zone; the crosspoint-matrix mechanism above no longer
reflects real zone routing (confirmed live: `/cue/{n}/levels` on the new setup returns a large,
zone-irrelevant matrix, not the small 2-3-channel one this section was built against). Kept
here for history/context only — `parseLevelsMatrix`/`SILENCE_FLOOR_DB` and `getLevels` are
deleted from the codebase, not kept as a fallback.

## Patch-based zone-derivation spike (QLab 5.x, 2026-07-21)

Captured against the operator's real reworked workspace (still `workspace_id
310C5F76-7049-4413-896A-452758323543`), after moving to one dedicated Messaging Audio Patch
per zone plus a separate Music patch per zone. Queried via a fixed, hardcoded-address temporary
Node-RED debug endpoint (routed through the already-connected `oscClient`, not a standalone
script — see "Standalone-script connectivity gotcha" below for why). Raw capture:
`test/fixtures/qlab-patch-spike-capture.jsonl` is NOT used for this spike (it came back empty —
see gotcha below); results were instead captured via the temporary endpoint's JSON response,
saved to this write-up directly.

### Confirmed workspace layout (as of this spike)

| Cue number | Name | Type | Zone |
|---|---|---|---|
| 1100 | Zone 1 Messages (cue list) | Cue List | Zone 1 |
| 1101-1104 | Message 1-4 | Audio | Zone 1 (patch 1) |
| 1198 | Duck Music | Fade | Zone 1 |
| 1199 | Unduck Music | Fade | Zone 1 |
| 1200 | Zone 1 Music (cue list) | Cue List | Zone 1 (music) |
| 2100 | Zone 2 Messages (cue list) | Cue List | Zone 2 |
| 2101-2104 | Message 1-4 | Audio | Zone 2 (patch 3) |
| 2198 | Duck Music | Fade | Zone 2 |
| 2199 | Unduck Music | Fade | Zone 2 |
| 2200 | Zone 2 Music (cue list) | Cue List | Zone 2 (music) |
| 9900 | Multi Zone Messages (cue list) | Cue List | — |
| 9901 | Global Message 1 | **Group** | Zone 1 + Zone 2 (2 children) |
| 9902 | Global Message 2 | **Group** | Zone 1 + Zone 2 (2 children) |

### `/cue/{n}/patch` — confirmed working, returns a plain integer

```
/cue/1101/patch -> 1
/cue/2101/patch -> 3
```

Also confirmed foldable into the existing bulk `valuesForKeys` call (same pattern already used
for `duration`/`uniqueID`):
```
/cue/1101/valuesForKeys ["patch","duration","uniqueID","type"]
  -> { "patch": 1, "type": "Audio", "uniqueID": "E6C2AF88-...", "duration": 9.292 }
```

The returned integer is a **1-based index into `/settings/audio/patchList`'s array** (not a
uniqueID, not a name) — see below.

### `/settings/audio/patchList` — confirmed working; `/settings/audio/audioPatches` does not exist

```
/settings/audio/patchList -> [
  { "name": "Zone 1 Messages - Studio 24c - (2 Out)", "uniqueID": "BFA3E9C5-...", "routing": [1], "cueOutputChannels": 2, ... },  // index 0 = patch 1
  { "name": "Zone 1 Music - Studio 24c - (2 Out)",    "uniqueID": "CD0020EF-...", "routing": [1], "cueOutputChannels": 2, ... },  // index 1 = patch 2
  { "name": "Zone 2 Messages - Studio 24c - (2 Out)", "uniqueID": "2C8510DF-...", "routing": [1], "cueOutputChannels": 2, ... },  // index 2 = patch 3
  { "name": "Zone 2 Music - Studio 24c - (2 Out)",    "uniqueID": "4D97753B-...", "routing": [1], "cueOutputChannels": 2, ... }   // index 3 = patch 4
]
```

`/settings/audio/audioPatches` returns an explicit denial (`{"status":"error"}`) — not a real
address, drop it as a candidate. **Confirmed:** cue 1101's `patch: 1` → array index 0 → "Zone 1
Messages..." ✓. Cue 2101's `patch: 3` → array index 2 → "Zone 2 Messages..." ✓. So `getCuePatch`
returns the 1-based position in this list; resolving it to a zone means fetching this list once
(e.g. at startup, for validation - see the plan) and/or just keying `config/audio-patch-map.json`
directly off this same 1-based integer per zone, since it's stable for a given workspace session
(confirm whether it survives a QLab restart / workspace re-save before relying on it long-term —
not yet tested).

### `/cue/{n}/levels` — still replies, but is now zone-meaningless (safe to delete)

Both `/cue/1101/levels` and `/cue/2101/levels` returned a large (~130-column) matrix of mostly
`0`/`-60` values, structurally nothing like the small 2-3 channel matrix from the original
Phase-0-era single-shared-patch setup. It no longer has any simple relationship to which zone a
cue belongs to. Confirms the plan's decision to delete `parseLevelsMatrix`/`SILENCE_FLOOR_DB`/
`getLevels` outright rather than keep them as a fallback.

### Group cue children — confirmed nesting via `/cueLists`, but a real wrinkle: no cue number

`/cueLists` still nests exactly as before (`type`, recursive `cues: [...]`) — no new "get
children" OSC call needed, `qlabProtocol.getCueLists()`/`flattenCueTree` work unchanged. Real
captured shape for cue 9901 ("Global Message 1", `type: "Group"`):

```json
{
  "number": "9901", "uniqueID": "79E2E663-...", "type": "Group", "name": "Global Message 1",
  "cues": [
    { "number": "", "uniqueID": "6CBDD4D1-...", "type": "Audio", "name": "Message 1", "cues": [] },
    { "number": "", "uniqueID": "224531C2-...", "type": "Audio", "name": "Message 2", "cues": [] }
  ]
}
```

**Wrinkle:** the Group's own children have `number: ""` — no cue number at all, only a
`uniqueID`. Querying a child's patch assignment by number (`/cue/{number}/patch`) isn't possible
for these as captured. Two ways to handle this, raised with the operator:
- If the operator assigns real cue numbers to Group children (offered, not yet done as of this
  writing), the resolver can use one uniform addressing scheme (`/cue/{number}/patch`)
  everywhere, leaf or nested - no second code path needed. **Preferred if/when done.**
- Otherwise, the resolver must fall back to QLab's parallel `/cue_id/{uniqueId}/...` addressing
  scheme (already used elsewhere in this codebase for `getIsRunningByUniqueId`) for any child
  encountered with an empty `number` - i.e. `qlabProtocol` needs a `getCuePatchByUniqueId(uniqueId)`
  alongside `getCuePatch(cueNumber)`, and `zoneResolver`'s recursion picks whichever the node
  actually has.

`group_type`/`group_valuesForKeys` confirm `/cue/{n}/type` and `valuesForKeys(["type"])` both
correctly report `"Group"` for a container cue (not `"Cart"`, the only container type
previously captured in Phase 0 - both are real, both must be treated as containers in the
resolver's recursion).

### Standalone-script connectivity gotcha (methodology note, not a QLab fact)

The originally-planned standalone spike script (`scripts/phase-patch-qlab-spike.js`, a fresh
Node process with its own ephemeral local UDP port) got **zero replies** to anything, including
a bare `/thump`, even with the production Node-RED process fully stopped (ruling out a port
conflict). Meanwhile Node-RED's own already-running connection (and, confirmed via a temporary
debug endpoint routed through that same connection) worked immediately. Root cause not fully
isolated - plausible theories include a per-IP (not per-port) OSC-client registration inside
QLab that outlives the client socket closing, or a local firewall/permission quirk specific to
a freshly-invoked `node` process. Practical takeaway for any future spike: route ad-hoc OSC
queries through the already-connected production process (a temporary, narrowly-scoped debug
endpoint with fixed hardcoded addresses - never a caller-supplied arbitrary address, since that
would be an unauthenticated pass-through to a live venue control system) rather than opening a
second standalone UDP client.
