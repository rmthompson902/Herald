'use strict';

const { validateSchedule } = require('../../lib/scheduling/scheduleModel');

describe('validateSchedule', () => {
  it('normalizes a minimal valid schedule with defaults applied', () => {
    const result = validateSchedule({ name: ' Lobby ', qlabCueNumber: ' MSG.LOBBY.SAFETY ', intervalSeconds: 600 });
    expect(result).toEqual({
      name: 'Lobby',
      qlabCueNumber: 'MSG.LOBBY.SAFETY',
      intervalSeconds: 600,
      startTime: null,
      endTime: null,
      weekdays: [1, 2, 3, 4, 5, 6, 7],
      dateRangeStart: null,
      dateRangeEnd: null,
      enabled: true
    });
  });

  it('rejects missing name/cue/interval', () => {
    expect(() => validateSchedule({})).toThrow(/name is required/);
    expect(() => validateSchedule({ name: 'x' })).toThrow(/qlabCueNumber is required/);
    expect(() => validateSchedule({ name: 'x', qlabCueNumber: 'y' })).toThrow(/intervalSeconds is required/);
  });

  it('rejects a non-positive or non-integer interval', () => {
    expect(() =>
      validateSchedule({ name: 'x', qlabCueNumber: 'y', intervalSeconds: 0 })
    ).toThrow(/intervalSeconds must be a positive integer/);
    expect(() =>
      validateSchedule({ name: 'x', qlabCueNumber: 'y', intervalSeconds: 12.5 })
    ).toThrow(/intervalSeconds must be a positive integer/);
  });

  it('validates HH:MM time format and start < end', () => {
    expect(() =>
      validateSchedule({ name: 'x', qlabCueNumber: 'y', intervalSeconds: 60, startTime: '9:00' })
    ).toThrow(/startTime must be HH:MM/);
    expect(() =>
      validateSchedule({
        name: 'x',
        qlabCueNumber: 'y',
        intervalSeconds: 60,
        startTime: '17:00',
        endTime: '09:00'
      })
    ).toThrow(/startTime must be before endTime/);
  });

  it('validates weekdays as unique integers 1-7', () => {
    expect(() =>
      validateSchedule({ name: 'x', qlabCueNumber: 'y', intervalSeconds: 60, weekdays: [] })
    ).toThrow(/weekdays must be/);
    expect(() =>
      validateSchedule({ name: 'x', qlabCueNumber: 'y', intervalSeconds: 60, weekdays: [1, 1] })
    ).toThrow(/weekdays must be/);
    expect(() =>
      validateSchedule({ name: 'x', qlabCueNumber: 'y', intervalSeconds: 60, weekdays: [0] })
    ).toThrow(/weekdays must be/);
  });

  it('sorts weekdays and validates date range ordering', () => {
    const result = validateSchedule({
      name: 'x',
      qlabCueNumber: 'y',
      intervalSeconds: 60,
      weekdays: [5, 1, 3],
      dateRangeStart: '2026-06-01',
      dateRangeEnd: '2026-08-31'
    });
    expect(result.weekdays).toEqual([1, 3, 5]);

    expect(() =>
      validateSchedule({
        name: 'x',
        qlabCueNumber: 'y',
        intervalSeconds: 60,
        dateRangeStart: '2026-08-31',
        dateRangeEnd: '2026-06-01'
      })
    ).toThrow(/dateRangeStart must be on or before dateRangeEnd/);
  });
});
