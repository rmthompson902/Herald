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
   * Raw [outputChannel][inputChannel] level matrix for a cue - feed this straight into
   * lib/zones/zoneResolver.js's parseLevelsMatrix, don't reinterpret it here.
   */
  async getLevels(cueNumber) {
    return this._client.request(`/cue/${cueNumber}/levels`);
  }

  async getUniqueId(cueNumber) {
    return this._client.request(`/cue/${cueNumber}/uniqueID`);
  }

  /** Full nested cue-list/cart tree as QLab returns it (lists/carts contain `cues: [...]`). */
  async getCueLists() {
    return this._client.request('/cueLists');
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
