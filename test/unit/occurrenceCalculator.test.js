'use strict';

const {
  isoWeekday,
  isWithinActiveWindow,
  nextOccurrences,
  occurrencesUntil
} = require('../../lib/scheduling/occurrenceCalculator');

function schedule(overrides = {}) {
  return {
    intervalSeconds: 600,
    startTime: '09:00',
    endTime: '17:00',
    weekdays: [1, 2, 3, 4, 5, 6, 7],
    dateRangeStart: null,
    dateRangeEnd: null,
    ...overrides
  };
}

describe('isoWeekday', () => {
  it('maps Sunday to 7, not 0', () => {
    expect(isoWeekday(new Date(2026, 6, 19))).toBe(7); // 2026-07-19 is a Sunday
  });

  it('maps Monday to 1', () => {
    expect(isoWeekday(new Date(2026, 6, 20))).toBe(1); // 2026-07-20 is a Monday
  });
});

describe('nextOccurrences - basic interval within active hours', () => {
  it('grid-aligns to startTime and steps by intervalSeconds', () => {
    const s = schedule({ intervalSeconds: 600, startTime: '09:00', endTime: '17:00' });
    const from = new Date(2026, 6, 20, 9, 5, 0); // Monday 09:05

    const occurrences = nextOccurrences(s, from, 3);

    expect(occurrences.map((d) => d.toTimeString().slice(0, 8))).toEqual([
      '09:10:00',
      '09:20:00',
      '09:30:00'
    ]);
  });

  it('rolls over to the next allowed day once the active window closes', () => {
    const s = schedule({ intervalSeconds: 600, startTime: '09:00', endTime: '17:00' });
    const from = new Date(2026, 6, 20, 16, 55, 0); // Monday 16:55

    const occurrences = nextOccurrences(s, from, 2);

    expect(occurrences[0].toTimeString().slice(0, 8)).toBe('17:00:00');
    expect(occurrences[1].getDate()).toBe(21); // next day
    expect(occurrences[1].toTimeString().slice(0, 8)).toBe('09:00:00');
  });
});

describe('nextOccurrences - weekday restriction', () => {
  it('skips to the next allowed weekday', () => {
    const s = schedule({ weekdays: [1] }); // Mondays only
    const from = new Date(2026, 6, 21, 10, 0, 0); // Tuesday

    const occurrences = nextOccurrences(s, from, 1);

    expect(isoWeekday(occurrences[0])).toBe(1);
    expect(occurrences[0].getDate()).toBe(27); // next Monday
  });
});

describe('nextOccurrences - date range restriction', () => {
  it('does not fire before dateRangeStart', () => {
    const s = schedule({ dateRangeStart: '2026-08-01', dateRangeEnd: '2026-08-31' });
    const from = new Date(2026, 6, 20, 10, 0, 0); // July, before range

    const occurrences = nextOccurrences(s, from, 1);

    expect(occurrences[0].getFullYear()).toBe(2026);
    expect(occurrences[0].getMonth()).toBe(7); // August (0-indexed)
    expect(occurrences[0].getDate()).toBe(1);
  });

  it('never fires after dateRangeEnd (returns fewer than requested rather than scanning forever)', () => {
    const s = schedule({
      dateRangeStart: '2026-08-01',
      dateRangeEnd: '2026-08-01',
      startTime: '09:00',
      endTime: '09:00',
      intervalSeconds: 600
    });
    const from = new Date(2026, 7, 1, 9, 0, 0);

    const occurrences = nextOccurrences(s, from, 5);

    expect(occurrences).toHaveLength(1); // only one grid slot exists in the whole allowed range
  });
});

describe('nextOccurrences - no startTime/endTime means all day', () => {
  it('grid starts at midnight and runs to end of day', () => {
    const s = schedule({ startTime: null, endTime: null, intervalSeconds: 3600 });
    const from = new Date(2026, 6, 20, 0, 0, 0);

    const occurrences = nextOccurrences(s, from, 3);

    expect(occurrences.map((d) => d.toTimeString().slice(0, 8))).toEqual([
      '00:00:00',
      '01:00:00',
      '02:00:00'
    ]);
  });
});

describe('nextOccurrences - DST spring-forward (America/New_York, 2026-03-08)', () => {
  const originalTz = process.env.TZ;
  beforeAll(() => {
    process.env.TZ = 'America/New_York';
  });
  afterAll(() => {
    process.env.TZ = originalTz;
  });

  it('dedupes grid slots that collapse into the same real instant across the DST gap', () => {
    // Confirmed empirically: setSeconds' wall-clock overflow resolves both a 02:00 and
    // 03:00 target to the identical real timestamp on this date, since 02:00-02:59
    // doesn't exist. Naive stepping would otherwise report a duplicate "occurrence".
    const s = schedule({ startTime: '01:00', endTime: '04:00', intervalSeconds: 1800 });
    const from = new Date(2026, 2, 8, 0, 30, 0);

    // Day 1's raw grid has 7 slots (01:00, 01:30, 02:00, 02:30, 03:00, 03:30, 04:00) but
    // two DST-collapsed pairs (02:00->03:00 and 02:30->03:30) dedupe down to 5 unique
    // instants - request exactly that many to assert the day-1 shape precisely.
    const occurrences = nextOccurrences(s, from, 5);
    const timestamps = occurrences.map((d) => d.getTime());

    expect(new Set(timestamps).size).toBe(timestamps.length); // no duplicate instants
    expect(occurrences.map((d) => d.toTimeString().slice(0, 8))).toEqual([
      '01:00:00',
      '01:30:00',
      '03:00:00',
      '03:30:00',
      '04:00:00'
    ]);
  });
});

describe('occurrencesUntil', () => {
  it('returns every occurrence within the window, none outside it', () => {
    const s = schedule({ intervalSeconds: 3600, startTime: '09:00', endTime: '11:00', weekdays: [1] }); // Mondays 9-11am hourly
    const from = new Date(2026, 6, 20, 0, 0, 0); // Monday
    const until = new Date(2026, 6, 20, 23, 59, 59); // same Monday, end of day

    const occurrences = occurrencesUntil(s, from, until);

    expect(occurrences.map((d) => d.toTimeString().slice(0, 8))).toEqual([
      '09:00:00',
      '10:00:00',
      '11:00:00'
    ]);
  });

  it('returns an empty array when the window contains no allowed occurrences', () => {
    const s = schedule({ weekdays: [1] }); // Mondays only
    const from = new Date(2026, 6, 21, 0, 0, 0); // Tuesday
    const until = new Date(2026, 6, 22, 23, 59, 59); // through Wednesday - no Monday in range

    expect(occurrencesUntil(s, from, until)).toEqual([]);
  });

  it('spans multiple days correctly', () => {
    const s = schedule({ intervalSeconds: 43200, startTime: '00:00', endTime: '23:59' }); // twice a day, every day
    const from = new Date(2026, 6, 20, 0, 0, 0);
    const until = new Date(2026, 6, 22, 23, 59, 59); // 3-day window

    const occurrences = occurrencesUntil(s, from, until);

    expect(occurrences).toHaveLength(6); // 2/day x 3 days
  });
});

describe('isWithinActiveWindow', () => {
  it('true inside the window, false outside it', () => {
    const s = schedule({ startTime: '09:00', endTime: '17:00', weekdays: [1, 2, 3, 4, 5] });

    expect(isWithinActiveWindow(s, new Date(2026, 6, 20, 12, 0, 0))).toBe(true); // Monday noon
    expect(isWithinActiveWindow(s, new Date(2026, 6, 20, 8, 0, 0))).toBe(false); // before start
    expect(isWithinActiveWindow(s, new Date(2026, 6, 25, 12, 0, 0))).toBe(false); // Saturday
  });
});
