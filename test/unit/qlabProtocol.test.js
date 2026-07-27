'use strict';

const { QlabProtocol, flattenCueTree } = require('../../lib/osc/qlabProtocol');
const cueListsFixture = require('../fixtures/qlab-cuelists.json');

function fakeClient() {
  return { request: jest.fn(), send: jest.fn(), requestOptionalReply: jest.fn() };
}

describe('QlabProtocol', () => {
  it('getDuration requests the right address', async () => {
    const client = fakeClient();
    client.request.mockResolvedValue(9.62);
    const protocol = new QlabProtocol(client);

    await expect(protocol.getDuration('101')).resolves.toBe(9.62);
    expect(client.request).toHaveBeenCalledWith('/cue/101/duration');
  });

  it('getCuePatch requests the right address and returns the patch id untouched', async () => {
    const client = fakeClient();
    client.request.mockResolvedValue(1);
    const protocol = new QlabProtocol(client);

    await expect(protocol.getCuePatch('1101')).resolves.toBe(1);
    expect(client.request).toHaveBeenCalledWith('/cue/1101/patch');
  });

  it('getAudioPatches requests the workspace patch list', async () => {
    const client = fakeClient();
    const patches = [
      { name: 'Zone 1 Messages', uniqueID: 'abc', routing: [1], cueOutputChannels: 2 }
    ];
    client.request.mockResolvedValue(patches);
    const protocol = new QlabProtocol(client);

    await expect(protocol.getAudioPatches()).resolves.toBe(patches);
    expect(client.request).toHaveBeenCalledWith('/settings/audio/patchList');
  });

  it('playCue/stopCue use requestOptionalReply, not request (success is silent, see oscClient)', async () => {
    const client = fakeClient();
    client.requestOptionalReply.mockResolvedValue(undefined);
    const protocol = new QlabProtocol(client);

    await protocol.playCue('101');
    await protocol.stopCue('101');

    expect(client.requestOptionalReply).toHaveBeenCalledWith('/cue/101/start', [], {
      timeoutMs: 500
    });
    expect(client.requestOptionalReply).toHaveBeenCalledWith('/cue/101/stop', [], {
      timeoutMs: 500
    });
    expect(client.request).not.toHaveBeenCalled();
  });

  it('getIsRunningByUniqueId queries by cue_id, not cue number', async () => {
    const client = fakeClient();
    client.request.mockResolvedValue(true);
    const protocol = new QlabProtocol(client);

    await expect(
      protocol.getIsRunningByUniqueId('780D5905-28E3-47D3-9718-7D668C957415')
    ).resolves.toBe(true);
    expect(client.request).toHaveBeenCalledWith(
      '/cue_id/780D5905-28E3-47D3-9718-7D668C957415/isRunning'
    );
  });

  it('keepAlive is fire-and-forget (uses send, not request)', () => {
    const client = fakeClient();
    const protocol = new QlabProtocol(client);

    protocol.keepAlive();

    expect(client.send).toHaveBeenCalledWith('/udpKeepAlive', [{ type: 'i', value: 1 }]);
    expect(client.request).not.toHaveBeenCalled();
  });

  it('getCueLists de-dupes concurrent calls into a single OSC request (QLab only answers one of several simultaneous identical-address queries)', async () => {
    const client = fakeClient();
    let resolveRequest;
    client.request.mockReturnValue(
      new Promise((resolve) => {
        resolveRequest = resolve;
      })
    );
    const protocol = new QlabProtocol(client);

    const p1 = protocol.getCueLists();
    const p2 = protocol.getCueLists();
    const p3 = protocol.getCueLists();

    expect(client.request).toHaveBeenCalledTimes(1);
    expect(client.request).toHaveBeenCalledWith('/cueLists');

    resolveRequest(cueListsFixture.data);
    const [r1, r2, r3] = await Promise.all([p1, p2, p3]);
    expect(r1).toBe(cueListsFixture.data);
    expect(r2).toBe(cueListsFixture.data);
    expect(r3).toBe(cueListsFixture.data);
  });

  it('getCueLists issues a fresh request for a call that starts after the previous one already resolved', async () => {
    const client = fakeClient();
    client.request
      .mockResolvedValueOnce(cueListsFixture.data)
      .mockResolvedValueOnce(cueListsFixture.data);
    const protocol = new QlabProtocol(client);

    await protocol.getCueLists();
    await protocol.getCueLists();

    expect(client.request).toHaveBeenCalledTimes(2);
  });

  it('getCueLists issues a fresh request after a prior in-flight one rejects (not permanently stuck sharing a failed call)', async () => {
    const client = fakeClient();
    client.request.mockRejectedValueOnce(
      new Error('OSC request timed out waiting for /reply/cueLists')
    );
    client.request.mockResolvedValueOnce(cueListsFixture.data);
    const protocol = new QlabProtocol(client);

    await expect(protocol.getCueLists()).rejects.toThrow('timed out');
    await expect(protocol.getCueLists()).resolves.toBe(cueListsFixture.data);
    expect(client.request).toHaveBeenCalledTimes(2);
  });

  it('listCues flattens the real cueLists fixture into a flat cue array', async () => {
    const client = fakeClient();
    client.request.mockResolvedValue(cueListsFixture.data);
    const protocol = new QlabProtocol(client);

    const cues = await protocol.listCues();
    const numbers = cues.map((c) => c.number);

    expect(numbers).toEqual(expect.arrayContaining(['101', '102', '103', '104']));
    const cue101 = cues.find((c) => c.number === '101');
    expect(cue101.uniqueID).toBe('780D5905-28E3-47D3-9718-7D668C957415');
    expect(cue101.type).toBe('Audio');
  });
});

describe('flattenCueTree', () => {
  it('recurses into nested cues arrays', () => {
    const flat = flattenCueTree(cueListsFixture.data);
    // 2 carts (Zone 1, Zone 2) + 4 cues inside Zone 1
    expect(flat).toHaveLength(6);
  });
});
