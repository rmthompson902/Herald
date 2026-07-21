'use strict';

// QLab-specific OSC verbs, built on the confirmed reply shapes/behavior captured in
// test/fixtures/qlab-osc-findings.md against a real QLab 5.6.2 workspace.

function flattenCueTree(cueListsOrCues, out = []) {
  for (const cue of cueListsOrCues) {
    out.push({
      number: cue.number,
      uniqueID: cue.uniqueID,
      type: cue.type,
      name: cue.name,
      listName: cue.listName,
      armed: cue.armed
    });
    if (Array.isArray(cue.cues) && cue.cues.length > 0) {
      flattenCueTree(cue.cues, out);
    }
  }
  return out;
}

class QlabProtocol {
  constructor(oscClient) {
    this._client = oscClient;
  }

  /** Heartbeat - confirms the workspace is alive and responding. */
  thump() {
    return this._client.request('/thump');
  }

  /** Fire-and-forget: QLab never replies to this, confirmed in Phase 0. */
  keepAlive() {
    this._client.send('/udpKeepAlive', [{ type: 'i', value: 1 }]);
  }

  /** Cue duration in seconds, accounting for trim/repeat - source of truth, never cached blindly. */
  async getDuration(cueNumber) {
    return this._client.request(`/cue/${cueNumber}/duration`);
  }

  /**
   * Which Audio Patch a cue is assigned to, as a 1-based integer index into
   * getAudioPatches()'s array - the zone-derivation primitive now that each zone has its own
   * dedicated Messaging Audio Patch (see the patch-based spike in
   * test/fixtures/qlab-osc-findings.md). Confirmed live: cue 1101 -> 1, cue 2101 -> 3.
   */
  async getCuePatch(cueNumber) {
    return this._client.request(`/cue/${cueNumber}/patch`);
  }

  /**
   * Enumerates every Audio Patch configured in the workspace (name/uniqueID/routing per
   * patch) - used to validate config/audio-patch-map.json's patch ids against what's real.
   * Confirmed live; `/settings/audio/audioPatches` (an earlier candidate) does not exist.
   */
  async getAudioPatches() {
    return this._client.request('/settings/audio/patchList');
  }

  async getUniqueId(cueNumber) {
    return this._client.request(`/cue/${cueNumber}/uniqueID`);
  }

  /**
   * Whether a cue is currently playing, addressed by QLab's internal uniqueID rather than
   * cue number - QLab's OSC dictionary supports `/cue_id/{id}/...` as an addressing scheme
   * parallel to `/cue/{number}/...` (same query verbs). Used by zoneQueueEngine to confirm
   * an occupied zone has actually freed on receiving a `/update/.../cue_id/{id}` push,
   * since that push carries no payload of its own (see test/fixtures/qlab-osc-findings.md).
   */
  async getIsRunningByUniqueId(uniqueId) {
    return this._client.request(`/cue_id/${uniqueId}/isRunning`);
  }

  /**
   * Full nested cue-list/cart tree as QLab returns it (lists/carts contain `cues: [...]`).
   *
   * De-dupes concurrent in-flight calls into one shared OSC round trip. `/cueLists` is a
   * single, cue-number-agnostic address that every zone/duration resolution needs
   * regardless of which specific cue it's ultimately after - when several schedules become
   * due at once, each independently calling this, QLab was observed (live testing) to
   * answer only ONE of several simultaneous identical-address queries, leaving the rest to
   * sit unanswered until their own client-side timeout (3s) rejected them - a real bug: the
   * "losing" schedules' fires were delayed a full 3s before ever reaching the zone queue,
   * so an unrelated zone's message appeared to wait on a completely different zone's. Since
   * the whole tree is identical for every caller in that instant (nothing about it is
   * per-cue), sharing one in-flight request/reply across all of them is always correct, not
   * just a performance nicety - it eliminates the race entirely rather than degrading after
   * losing it.
   */
  async getCueLists() {
    if (!this._pendingCueListsRequest) {
      this._pendingCueListsRequest = this._client.request('/cueLists').finally(() => {
        this._pendingCueListsRequest = null;
      });
    }
    return this._pendingCueListsRequest;
  }

  /** Flat list of every cue in the workspace, recursively walking lists/carts/groups. */
  async listCues() {
    const cueLists = await this.getCueLists();
    return flattenCueTree(cueLists);
  }

  // QLab only sends an explicit reply to /start and /stop on DENIAL - success is silent
  // (confirmed empirically: a successful /cue/101/start plays the cue with no reply at
  // all). requestOptionalReply resolves on silence, but still rejects on a denial that
  // does arrive - see lib/osc/oscClient.js.
  async playCue(cueNumber) {
    return this._client.requestOptionalReply(`/cue/${cueNumber}/start`, [], { timeoutMs: 500 });
  }

  async stopCue(cueNumber) {
    return this._client.requestOptionalReply(`/cue/${cueNumber}/stop`, [], { timeoutMs: 500 });
  }

  /** Subscribes to the /update/... push feed; QLab replies but with no data of interest. */
  async subscribeUpdates() {
    return this._client.request('/updates', [{ type: 'i', value: 1 }]);
  }

  async unsubscribeUpdates() {
    return this._client.request('/updates', [{ type: 'i', value: 0 }]);
  }
}

module.exports = { QlabProtocol, flattenCueTree };
