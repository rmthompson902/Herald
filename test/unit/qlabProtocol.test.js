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

  it('getLevels returns the raw matrix untouched', async () => {
    const client = fakeClient();
    const matrix = [[0, 0, 0], [0, 0, -60], [0, -60, 0]];
    client.request.mockResolvedValue(matrix);
    const protocol = new QlabProtocol(client);

    await expect(protocol.getLevels('101')).resolves.toBe(matrix);
    expect(client.request).toHaveBeenCalledWith('/cue/101/levels');
  });

  it('playCue/stopCue use requestOptionalReply, not request (success is silent, see oscClient)', async () => {
    const client = fakeClient();
    client.requestOptionalReply.mockResolvedValue(undefined);
    const protocol = new QlabProtocol(client);

    await protocol.playCue('101');
    await protocol.stopCue('101');

    expect(client.requestOptionalReply).toHaveBeenCalledWith('/cue/101/start', [], { timeoutMs: 500 });
    expect(client.requestOptionalReply).toHaveBeenCalledWith('/cue/101/stop', [], { timeoutMs: 500 });
    expect(client.request).not.toHaveBeenCalled();
  });

  it('getIsRunningByUniqueId queries by cue_id, not cue number', async () => {
    const client = fakeClient();
    client.request.mockResolvedValue(true);
    const protocol = new QlabProtocol(client);

    await expect(protocol.getIsRunningByUniqueId('780D5905-28E3-47D3-9718-7D668C957415')).resolves.toBe(true);
    expect(client.request).toHaveBeenCalledWith('/cue_id/780D5905-28E3-47D3-9718-7D668C957415/isRunning');
  });

  it('keepAlive is fire-and-forget (uses send, not request)', () => {
    const client = fakeClient();
    const protocol = new QlabProtocol(client);

    protocol.keepAlive();

    expect(client.send).toHaveBeenCalledWith('/udpKeepAlive', [{ type: 'i', value: 1 }]);
    expect(client.request).not.toHaveBeenCalled();
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
