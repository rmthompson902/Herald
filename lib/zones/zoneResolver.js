'use strict';

// Zone derivation, patch-based (see the patch-based spike in test/fixtures/qlab-osc-findings.md).
// Superseded the earlier crosspoint-matrix mechanism once the venue moved to one dedicated
// Messaging Audio Patch per zone - a cue's zone identity is now simply "which patch is it
// assigned to", not a gain-matrix reading.

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
  const patchId = await qlabProtocol.getCuePatch(cueNumber);
  if (patchId === null || patchId === undefined) return null;
  return patchMap.get(String(patchId)) ?? null;
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
 * resolveDurationSecondsByZone), so callers that need a zone's own discrete duration need
 * to know WHICH child cue to ask. If more than one child somehow resolves to the same zone
 * (not expected in the current real setup - each zone has exactly one child per group),
 * the first one encountered wins; this is a real, accepted limitation, not silently papered
 * over.
 */
async function collectZoneInfo(qlabProtocol, patchMap, node, zones, zoneToCueNumber) {
  if (Array.isArray(node.cues) && node.cues.length > 0) {
    // Container (Group/Cart/List) - union of every child's own zone(s), recursing for
    // nested groups. Each child is addressed by its own cue number (QLab 5's Group cue
    // children are addressed the same /cue/{number}/... way as any other cue, once given
    // one - see the patch spike).
    await Promise.all(node.cues.map((child) => collectZoneInfo(qlabProtocol, patchMap, child, zones, zoneToCueNumber)));
    return;
  }

  const zone = await resolveZoneForLeafCue(qlabProtocol, patchMap, node.number);
  if (zone) {
    zones.add(zone);
    if (!zoneToCueNumber.has(zone)) zoneToCueNumber.set(zone, node.number);
  }
}

/**
 * Resolves both the union of zones for a cue AND, per zone, the specific leaf cue number
 * that provides it - shared traversal backing both resolveZonesForCue (below) and
 * resolveDurationSecondsByZone.
 *
 * @param {object} qlabProtocol - exposes getCueLists(), getCuePatch(cueNumber)
 * @param {Map<string,string>} patchMap - patch id (as string) -> zone name
 * @param {string} cueNumber
 * @returns {Promise<{ zones: string[], zoneToCueNumber: Map<string,string> }>}
 */
async function resolveZoneInfoForCue(qlabProtocol, patchMap, cueNumber) {
  const cueLists = await qlabProtocol.getCueLists();
  const node = findCueNode(cueLists, cueNumber);
  if (!node) return { zones: [], zoneToCueNumber: new Map() };

  const zones = new Set();
  const zoneToCueNumber = new Map();
  await collectZoneInfo(qlabProtocol, patchMap, node, zones, zoneToCueNumber);
  return { zones: Array.from(zones), zoneToCueNumber };
}

/**
 * Resolves the union of zones for a cue - a leaf Audio cue resolves to 0/1 zone via its own
 * Messaging Audio Patch assignment; a Group/Cart cue resolves to the union of its children's
 * own zones, recursing for nested groups. Reuses the existing /cueLists tree fetch
 * (qlabProtocol.getCueLists()) rather than a new per-cue "children" query.
 *
 * @param {object} qlabProtocol - exposes getCueLists(), getCuePatch(cueNumber)
 * @param {Map<string,string>} patchMap - patch id (as string) -> zone name
 * @param {string} cueNumber
 * @returns {Promise<string[]>} deduplicated zone names
 */
async function resolveZonesForCue(qlabProtocol, patchMap, cueNumber) {
  const { zones } = await resolveZoneInfoForCue(qlabProtocol, patchMap, cueNumber);
  return zones;
}

/**
 * Resolves each of a cue's zones to ITS OWN discrete duration, rather than one shared
 * duration for the whole cue. For a plain leaf cue this is trivially { [zone]: the cue's
 * own duration }. For a Group cue whose children are scoped to different zones, QLab
 * reports the GROUP's own /cue/{n}/duration as the longest child's duration - using that
 * uniformly for every zone would hold a short zone "busy" (and ducked) for as long as its
 * longest sibling, and delay anything else queued behind it in that same zone. Querying
 * each zone's own child cue's duration directly avoids that.
 *
 * @param {object} qlabProtocol - exposes getCueLists(), getCuePatch(cueNumber), getDuration(cueNumber)
 * @param {Map<string,string>} patchMap
 * @param {string} cueNumber
 * @returns {Promise<Object<string,number>>} zone name -> duration in seconds (only zones
 *   whose own duration query succeeded are included)
 */
async function resolveDurationSecondsByZone(qlabProtocol, patchMap, cueNumber) {
  const { zoneToCueNumber } = await resolveZoneInfoForCue(qlabProtocol, patchMap, cueNumber);

  const entries = await Promise.all(
    Array.from(zoneToCueNumber.entries()).map(async ([zone, childCueNumber]) => {
      try {
        const durationSeconds = await qlabProtocol.getDuration(childCueNumber);
        return [zone, durationSeconds];
      } catch {
        return [zone, undefined];
      }
    })
  );

  const result = {};
  for (const [zone, durationSeconds] of entries) {
    if (typeof durationSeconds === 'number' && !Number.isNaN(durationSeconds)) {
      result[zone] = durationSeconds;
    }
  }
  return result;
}

module.exports = {
  resolveZoneForLeafCue,
  resolveZonesForCue,
  resolveZoneInfoForCue,
  resolveDurationSecondsByZone,
  findCueNode
};
