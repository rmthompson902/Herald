'use strict';

const { getUpcomingOccurrencesForZone } = require('../../lib/scheduling/zoneUpcomingOccurrences');

const FAKE_DB = {}; // never touched directly - all access goes through the injected repos

function schedule(id, { qlabCueNumber = String(id), name = `Schedule ${id}` } = {}) {
  return { id, name, qlabCueNumber };
}

function cue(qlabCueNumber, { zones = [], durationSeconds = 5, cueDisplayName = `Cue ${qlabCueNumber}` } = {}) {
  return { qlabCueNumber, zones, durationSeconds, cueDisplayName };
}

function fakeDeps({ schedules = [], cues = {}, occurrencesBySchedule = {} } = {}) {
  return {
    schedulesRepo: { listEnabled: jest.fn(() => schedules) },
    cueCacheRepo: { getByCueNumber: jest.fn((_db, qlabCueNumber) => cues[qlabCueNumber] ?? null) },
    nextOccurrences: jest.fn((scheduleRow, _from, count) =>
      (occurrencesBySchedule[scheduleRow.id] ?? []).slice(0, count)
    )
  };
}

describe('getUpcomingOccurrencesForZone', () => {
  it('returns an empty page for a zone with no matching schedules', () => {
    const deps = fakeDeps({ schedules: [schedule(1)], cues: { 1: cue('1', { zones: ['Zone 2'] }) } });

    const result = getUpcomingOccurrencesForZone(FAKE_DB, 'Zone 1', deps);

    expect(result).toEqual({ occurrences: [], hasMore: false });
  });

  it('excludes a schedule whose cue has never been resolved into cue_cache', () => {
    const deps = fakeDeps({ schedules: [schedule(1)], cues: {} });

    const result = getUpcomingOccurrencesForZone(FAKE_DB, 'Zone 1', deps);

    expect(result.occurrences).toEqual([]);
  });

  it('merge-sorts occurrences from multiple schedules in the same zone by fire time', () => {
    const deps = fakeDeps({
      schedules: [schedule(1, { qlabCueNumber: '1' }), schedule(2, { qlabCueNumber: '2' })],
      cues: { 1: cue('1', { zones: ['Zone 1'] }), 2: cue('2', { zones: ['Zone 1'] }) },
      occurrencesBySchedule: {
        1: [new Date('2026-01-01T00:02:00Z'), new Date('2026-01-01T00:04:00Z')],
        2: [new Date('2026-01-01T00:01:00Z'), new Date('2026-01-01T00:03:00Z')]
      }
    });

    const result = getUpcomingOccurrencesForZone(FAKE_DB, 'Zone 1', deps, { count: 25 });

    expect(result.occurrences.map((o) => o.dueAt)).toEqual([
      '2026-01-01T00:01:00.000Z',
      '2026-01-01T00:02:00.000Z',
      '2026-01-01T00:03:00.000Z',
      '2026-01-01T00:04:00.000Z'
    ]);
    expect(result.hasMore).toBe(false);
  });

  it('pages across a batch boundary without repeating or skipping entries', () => {
    const occurrences = Array.from({ length: 30 }, (_, i) => new Date(Date.UTC(2026, 0, 1, 0, i)));
    const deps = fakeDeps({
      schedules: [schedule(1)],
      cues: { 1: cue('1', { zones: ['Zone 1'] }) },
      occurrencesBySchedule: { 1: occurrences }
    });

    const firstPage = getUpcomingOccurrencesForZone(FAKE_DB, 'Zone 1', deps, { offset: 0, count: 25 });
    const secondPage = getUpcomingOccurrencesForZone(FAKE_DB, 'Zone 1', deps, { offset: 25, count: 25 });

    expect(firstPage.occurrences).toHaveLength(25);
    expect(firstPage.hasMore).toBe(true);
    expect(secondPage.occurrences).toHaveLength(5);
    expect(secondPage.hasMore).toBe(false);
    expect(firstPage.occurrences[0].dueAt).toBe(occurrences[0].toISOString());
    expect(secondPage.occurrences[4].dueAt).toBe(occurrences[29].toISOString());
  });

  it('terminates in bounded time for a no-end-date schedule (delegates the actual scan bound to nextOccurrences)', () => {
    const deps = fakeDeps({
      schedules: [schedule(1)],
      cues: { 1: cue('1', { zones: ['Zone 1'] }) },
      occurrencesBySchedule: { 1: [new Date('2026-01-01T00:00:00Z')] }
    });

    getUpcomingOccurrencesForZone(FAKE_DB, 'Zone 1', deps, { count: 25 });

    // Confirms the module asks nextOccurrences for a bounded count (offset+count), never an
    // unbounded/open-ended request - nextOccurrences itself (MAX_DAYS_TO_SCAN) is what
    // actually guards against scanning forever for a schedule with no end date.
    expect(deps.nextOccurrences).toHaveBeenCalledWith(expect.objectContaining({ id: 1 }), expect.any(Date), 26);
  });

  it('drops only the earliest occurrence for a schedule already represented by a live occupancy/queued entry', () => {
    const deps = fakeDeps({
      schedules: [schedule(1)],
      cues: { 1: cue('1', { zones: ['Zone 1'] }) },
      occurrencesBySchedule: {
        1: [new Date('2026-01-01T00:00:00Z'), new Date('2026-01-01T00:05:00Z'), new Date('2026-01-01T00:10:00Z')]
      }
    });

    const result = getUpcomingOccurrencesForZone(FAKE_DB, 'Zone 1', deps, {
      count: 25,
      liveScheduleIds: new Set([1])
    });

    expect(result.occurrences.map((o) => o.dueAt)).toEqual([
      '2026-01-01T00:05:00.000Z',
      '2026-01-01T00:10:00.000Z'
    ]);
  });

  it('carries cue duration and display name through for each occurrence, independent of whether the cue has fired', () => {
    const deps = fakeDeps({
      schedules: [schedule(1, { qlabCueNumber: '5' })],
      cues: { 5: cue('5', { zones: ['Zone 1'], durationSeconds: 12, cueDisplayName: 'Welcome Announcement' }) },
      occurrencesBySchedule: { 1: [new Date('2026-01-01T00:00:00Z')] }
    });

    const result = getUpcomingOccurrencesForZone(FAKE_DB, 'Zone 1', deps);

    expect(result.occurrences[0]).toMatchObject({
      scheduleId: 1,
      qlabCueNumber: '5',
      cueDisplayName: 'Welcome Announcement',
      durationSeconds: 12
    });
  });
});
