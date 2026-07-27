'use strict';

// Zone derivation, patch-based (see the patch-based spike in test/fixtures/qlab-osc-findings.md).
// Superseded the earlier crosspoint-matrix mechanism once the venue moved to one dedicated
// Messaging Audio Patch per zone - a cue's zone identity is now simply "which patch is it
// assigned to", not a gain-matrix reading.

/**
 * Leaf-cue zone lookup, plus the raw patch id behind the decision - the patch id is what
 * lets a caller distinguish "this cue has no patch assignment at all" (a normal, harmless
 * case - not every cue is a messaging cue) from "this cue has a real patch assignment, but
 * that patch isn't mapped to any zone in config/audio-patch-map.json" (almost always a
 * config gap - e.g. a new zone added in QLab before its entry was added to that file, the
 * exact bug this was written to stop being silent).
 *
 * @param {object} qlabProtocol - exposes getCuePatch(cueNumber) -> Promise<number|null>
 * @param {Map<string,string>} patchMap - patch id (as string) -> zone name
 * @param {string} cueNumber
 * @returns {Promise<{ zone: string|null, patchId: number|null }>}
 */
async function resolveZoneDetailsForLeafCue(qlabProtocol, patchMap, cueNumber) {
  const patchId = await qlabProtocol.getCuePatch(cueNumber);
  if (patchId === null || patchId === undefined) return { zone: null, patchId: null };
  return { zone: patchMap.get(String(patchId)) ?? null, patchId };
}

/**
 * Leaf-cue zone lookup: which zone does this cue's own Messaging Audio Patch assignment
 * belong to? Returns null if the cue has no patch assignment, or its patch isn't mapped to
 * any zone (e.g. a Music patch, or a patch not yet configured in
 * config/audio-patch-map.json) - null, not an empty array, distinguishes "not a messaging
 * cue" from a cue that genuinely resolves to zero zones.
 *
 * @param {object} qlabProtocol - exposes getCuePatch(cueNumber) -> Promise<number|null>
 * @param {Map<string,string>} patchMap - patch id (as string) -> zone name
 * @param {string} cueNumber
 * @returns {Promise<string|null>}
 */
async function resolveZoneForLeafCue(qlabProtocol, patchMap, cueNumber) {
  const { zone } = await resolveZoneDetailsForLeafCue(qlabProtocol, patchMap, cueNumber);
  return zone;
}

/** Finds the cue-tree node matching cueNumber, searching every list/group recursively. */
function findCueNode(cueListsOrCues, cueNumber) {
  const target = String(cueNumber);
  for (const cue of cueListsOrCues) {
    if (String(cue.number) === target) return cue;
    if (Array.isArray(cue.cues) && cue.cues.length > 0) {
      const found = findCueNode(cue.cues, cueNumber);
      if (found) return found;
    }
  }
  return null;
}

/**
 * Walks a cue-tree node, collecting both the union of zones AND, per zone, which specific
 * leaf cue number actually provides that zone's audio - a Group cue's own OSC-reported
 * duration is QLab's longest-child value, not any individual zone's real duration (see
 * resolveZoneDetailsForCue), so callers that need a zone's own discrete duration need
 * to know WHICH child cue to ask. If more than one child somehow resolves to the same zone
 * (not expected in the current real setup - each zone has exactly one child per group),
 * the first one encountered wins; this is a real, accepted limitation, not silently papered
 * over.
 *
 * Also collects `unmappedLeafCues` - every leaf cue whose patch id IS assigned but isn't in
 * patchMap - so callers can log a diagnostic warning for the config-gap case without
 * confusing it with a cue that legitimately has no patch (see resolveZoneDetailsForLeafCue).
 */
async function collectZoneInfo(
  qlabProtocol,
  patchMap,
  node,
  zones,
  zoneToCueNumber,
  unmappedLeafCues
) {
  if (Array.isArray(node.cues) && node.cues.length > 0) {
    // Container (Group/Cart/List) - union of every child's own zone(s), recursing for
    // nested groups. Each child is addressed by its own cue number (QLab 5's Group cue
    // children are addressed the same /cue/{number}/... way as any other cue, once given
    // one - see the patch spike).
    await Promise.all(
      node.cues.map((child) =>
        collectZoneInfo(qlabProtocol, patchMap, child, zones, zoneToCueNumber, unmappedLeafCues)
      )
    );
    return;
  }

  const { zone, patchId } = await resolveZoneDetailsForLeafCue(qlabProtocol, patchMap, node.number);
  if (zone) {
    zones.add(zone);
    if (!zoneToCueNumber.has(zone)) zoneToCueNumber.set(zone, node.number);
  } else if (patchId !== null) {
    unmappedLeafCues.push({ cueNumber: node.number, patchId });
  }
}

/**
 * Resolves both the union of zones for a cue AND, per zone, the specific leaf cue number
 * that provides it - shared traversal backing resolveZoneDetailsForCue (below). A leaf
 * Audio cue resolves to 0/1 zone via its own Messaging Audio Patch assignment; a Group/Cart
 * cue resolves to the union of its children's own zones, recursing for nested groups.
 * Reuses the existing /cueLists tree fetch (qlabProtocol.getCueLists()) rather than a new
 * per-cue "children" query. A failure of the tree fetch/traversal itself PROPAGATES (never
 * silently swallowed) - the caller's zone list is safety-critical (it determines real
 * collision protection), and returning an empty result on a transient OSC failure would be
 * indistinguishable from a legitimately zero-zone (unrouted) cue, which fires immediately
 * with no collision protection at all.
 *
 * @param {object} qlabProtocol - exposes getCueLists(), getCuePatch(cueNumber)
 * @param {Map<string,string>} patchMap - patch id (as string) -> zone name
 * @param {string} cueNumber
 * `cueDisplayName` is the cue's own QLab name (from the same tree node), so the webapp can
 * show a friendly label instead of the bare cue number - null if the cue isn't found.
 *
 * @returns {Promise<{ zones: string[], zoneToCueNumber: Map<string,string>, unmappedLeafCues: Array<{cueNumber: string, patchId: number}>, cueDisplayName: (string|null) }>}
 */
async function resolveZoneInfoForCue(qlabProtocol, patchMap, cueNumber) {
  const cueLists = await qlabProtocol.getCueLists();
  const node = findCueNode(cueLists, cueNumber);
  if (!node)
    return { zones: [], zoneToCueNumber: new Map(), unmappedLeafCues: [], cueDisplayName: null };

  const zones = new Set();
  const zoneToCueNumber = new Map();
  const unmappedLeafCues = [];
  await collectZoneInfo(qlabProtocol, patchMap, node, zones, zoneToCueNumber, unmappedLeafCues);
  return {
    zones: Array.from(zones),
    zoneToCueNumber,
    unmappedLeafCues,
    cueDisplayName: node.name ?? null
  };
}

/**
 * Resolves each of a cue's zones to its own complete play details - the specific leaf cue
 * number that actually provides that zone's audio, that leaf's own discrete duration, and
 * its own QLab internal uniqueID - rather than one shared value assumed to apply to every
 * zone. This matters because a Group cue's own OSC-reported `/duration` is QLab's
 * LONGEST-child value, not any individual zone's real duration: uniformly applying that (or
 * the group's own uniqueId) to every zone would hold a short zone "busy"/ducked for as long
 * as its longest sibling and delay anything queued behind it in that same zone. Firing each
 * zone's own specific child cue number (rather than the group's) is what lets each zone's
 * queue admit/duck/fire/unduck completely independently of the others (see
 * zoneQueueEngine.js and ADR 0001 decision 4's amendment) - this is the one place that
 * resolution happens, replacing what used to be two separate consumers
 * (resolveZonesForCue/resolveDurationSecondsByZone) each re-walking the tree on their own.
 *
 * Zone membership itself (the tree walk, via resolveZoneInfoForCue) is safety-critical and
 * never silently swallowed - a failure there propagates. Each zone's OWN duration/uniqueId
 * queries are independently best-effort: if one fails, that zone still appears in `zones`
 * and `zoneDetails` (with its correctly-resolved `cueNumber`), just with `durationSeconds`/
 * `qlabInternalId` left `undefined` - callers already tolerate a missing duration (falling
 * back to a default) and a missing uniqueId (skipping the live isRunning confirm for that
 * zone), exactly as a plain single-zone cue would if its own query failed.
 *
 * @param {object} qlabProtocol - exposes getCueLists(), getCuePatch(cueNumber), getDuration(cueNumber), getUniqueId(cueNumber)
 * @param {Map<string,string>} patchMap - patch id (as string) -> zone name
 * @param {string} cueNumber
 * @returns {Promise<{ zones: string[], zoneDetails: Object<string, { cueNumber: string, durationSeconds: (number|undefined), qlabInternalId: (string|undefined) }>, unmappedLeafCues: Array<{cueNumber: string, patchId: number}>, cueDisplayName: (string|null) }>}
 */
async function resolveZoneDetailsForCue(qlabProtocol, patchMap, cueNumber) {
  const { zones, zoneToCueNumber, unmappedLeafCues, cueDisplayName } = await resolveZoneInfoForCue(
    qlabProtocol,
    patchMap,
    cueNumber
  );

  const zoneDetails = {};
  await Promise.all(
    Array.from(zoneToCueNumber.entries()).map(async ([zone, childCueNumber]) => {
      const [durationSeconds, qlabInternalId] = await Promise.all([
        qlabProtocol.getDuration(childCueNumber).catch(() => undefined),
        qlabProtocol.getUniqueId(childCueNumber).catch(() => undefined)
      ]);
      zoneDetails[zone] = { cueNumber: childCueNumber, durationSeconds, qlabInternalId };
    })
  );

  return { zones, zoneDetails, unmappedLeafCues, cueDisplayName };
}

module.exports = {
  resolveZoneForLeafCue,
  resolveZoneInfoForCue,
  resolveZoneDetailsForCue,
  findCueNode
};
