'use strict';

const TIME_PATTERN = /^([01]\d|2[0-3]):([0-5]\d)$/;
const DATE_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Validates and normalizes raw schedule input (e.g. from a dashboard form submission)
 * into the shape schedulesRepo expects. Throws with a descriptive message on invalid
 * input - this is the single place schedule input gets validated, so both the dashboard
 * create/edit flow and any programmatic caller go through the same rules.
 */
function validateSchedule(input) {
  const errors = [];

  if (!input.name || typeof input.name !== 'string' || input.name.trim() === '') {
    errors.push('name is required');
  }

  if (!input.qlabCueNumber || typeof input.qlabCueNumber !== 'string' || input.qlabCueNumber.trim() === '') {
    errors.push('qlabCueNumber is required');
  }

  if (input.intervalSeconds != null) {
    if (!Number.isInteger(input.intervalSeconds) || input.intervalSeconds <= 0) {
      errors.push('intervalSeconds must be a positive integer when provided');
    }
  } else {
    errors.push('intervalSeconds is required (v1 supports interval-based schedules only)');
  }

  for (const [field, value] of [['startTime', input.startTime], ['endTime', input.endTime]]) {
    if (value != null && !TIME_PATTERN.test(value)) {
      errors.push(`${field} must be HH:MM (24-hour) when provided, got "${value}"`);
    }
  }

  if (input.startTime != null && input.endTime != null && input.startTime >= input.endTime) {
    errors.push('startTime must be before endTime');
  }

  const weekdays = input.weekdays ?? [1, 2, 3, 4, 5, 6, 7];
  if (
    !Array.isArray(weekdays) ||
    weekdays.length === 0 ||
    !weekdays.every((d) => Number.isInteger(d) && d >= 1 && d <= 7) ||
    new Set(weekdays).size !== weekdays.length
  ) {
    errors.push('weekdays must be a non-empty array of unique integers 1-7 (1=Monday..7=Sunday)');
  }

  for (const [field, value] of [
    ['dateRangeStart', input.dateRangeStart],
    ['dateRangeEnd', input.dateRangeEnd]
  ]) {
    if (value != null && !DATE_PATTERN.test(value)) {
      errors.push(`${field} must be YYYY-MM-DD when provided, got "${value}"`);
    }
  }

  if (
    input.dateRangeStart != null &&
    input.dateRangeEnd != null &&
    input.dateRangeStart > input.dateRangeEnd
  ) {
    errors.push('dateRangeStart must be on or before dateRangeEnd');
  }

  if (errors.length > 0) {
    throw new Error(`Invalid schedule: ${errors.join('; ')}`);
  }

  return {
    name: input.name.trim(),
    qlabCueNumber: input.qlabCueNumber.trim(),
    intervalSeconds: input.intervalSeconds,
    startTime: input.startTime ?? null,
    endTime: input.endTime ?? null,
    weekdays: [...weekdays].sort((a, b) => a - b),
    dateRangeStart: input.dateRangeStart ?? null,
    dateRangeEnd: input.dateRangeEnd ?? null,
    enabled: input.enabled !== false
  };
}

module.exports = { validateSchedule };
