'use strict';

const SECONDS_PER_DAY = 86400;
const MAX_DAYS_TO_SCAN = 366 * 2; // safety bound: don't scan forever for an impossible schedule

function isoWeekday(date) {
  const jsDay = date.getDay(); // 0=Sunday..6=Saturday
  return jsDay === 0 ? 7 : jsDay;
}

function dateOnlyString(date) {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

function parseTimeToSeconds(hhmm) {
  if (hhmm == null) return null;
  const [h, m] = hhmm.split(':').map(Number);
  return h * 3600 + m * 60;
}

function secondsSinceMidnight(date) {
  return date.getHours() * 3600 + date.getMinutes() * 60 + date.getSeconds();
}

function startOfDay(date) {
  const d = new Date(date);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** Is `date` a calendar day this schedule is allowed to run on at all (weekday + date range)? */
function isDayAllowed(scheduleRow, date) {
  if (!scheduleRow.weekdays.includes(isoWeekday(date))) return false;

  const dateStr = dateOnlyString(date);
  if (scheduleRow.dateRangeStart && dateStr < scheduleRow.dateRangeStart) return false;
  if (scheduleRow.dateRangeEnd && dateStr > scheduleRow.dateRangeEnd) return false;

  return true;
}

/**
 * Is this exact moment within the schedule's allowed weekday/date-range/active-hours
 * window? Used as a defensive re-check at fire-time, guarding against any disagreement
 * between cron-plus's own internal timing and our own schedule semantics (e.g. across a
 * DST transition).
 */
function isWithinActiveWindow(scheduleRow, date) {
  if (!isDayAllowed(scheduleRow, date)) return false;

  const startSeconds = parseTimeToSeconds(scheduleRow.startTime) ?? 0;
  const endSeconds = parseTimeToSeconds(scheduleRow.endTime) ?? SECONDS_PER_DAY - 1;
  const nowSeconds = secondsSinceMidnight(date);

  return nowSeconds >= startSeconds && nowSeconds <= endSeconds;
}

/**
 * All grid-aligned occurrence times (as seconds-since-midnight) for one calendar day,
 * stepping every intervalSeconds starting from the day's startTime (or midnight).
 */
function gridTimesForDay(scheduleRow) {
  const startSeconds = parseTimeToSeconds(scheduleRow.startTime) ?? 0;
  const endSeconds = parseTimeToSeconds(scheduleRow.endTime) ?? SECONDS_PER_DAY - 1;
  const interval = scheduleRow.intervalSeconds;

  const times = [];
  for (let t = startSeconds; t <= endSeconds; t += interval) {
    times.push(t);
  }
  return times;
}

/**
 * Computes the next `count` occurrences at or after `from`, honoring weekdays,
 * date range, and active-hours window. Independent of cron-plus's own internal state -
 * this drives the dashboard's "next scheduled playback time" display directly from the
 * schedule row.
 */
function nextOccurrences(scheduleRow, from, count) {
  const results = [];
  const seenTimestamps = new Set();
  let cursorDay = startOfDay(from);
  let daysScanned = 0;

  while (results.length < count && daysScanned < MAX_DAYS_TO_SCAN) {
    if (isDayAllowed(scheduleRow, cursorDay)) {
      const isFromDay = dateOnlyString(cursorDay) === dateOnlyString(from);
      const minSeconds = isFromDay ? secondsSinceMidnight(from) : 0;

      for (const seconds of gridTimesForDay(scheduleRow)) {
        if (seconds >= minSeconds && results.length < count) {
          const occurrence = new Date(cursorDay);
          occurrence.setSeconds(occurrence.getSeconds() + seconds);
          const timestamp = occurrence.getTime();
          // isFromDay's minSeconds only excludes earlier grid points; an exact-equal
          // match to `from` itself is a valid next occurrence (e.g. "starting now").
          // Dedupe against every timestamp seen so far (not just the previous one): on
          // a DST spring-forward day, setSeconds' wall-clock overflow can resolve two
          // NON-adjacent grid targets (e.g. both 02:00->03:00 and 02:30->03:30) to
          // identical real instants, since 02:00-02:59 doesn't exist that day -
          // confirmed empirically, see test/unit/occurrenceCalculator.test.js.
          if (occurrence >= from && !seenTimestamps.has(timestamp)) {
            results.push(occurrence);
            seenTimestamps.add(timestamp);
          }
        }
      }
    }

    cursorDay = new Date(cursorDay);
    cursorDay.setDate(cursorDay.getDate() + 1);
    daysScanned += 1;
  }

  return results;
}

const MAX_OCCURRENCES_PER_WINDOW = 10000; // safety cap against pathological configs (e.g. 1s interval over a huge window)

/**
 * All occurrences in [from, until] - used to build a bounded batch of dates for
 * cron-plus's `expressionType: "dates"` schedules (see lib/scheduling/cronSync.js),
 * since cron-plus's dates mode takes a fixed list, not a perpetual generator. Sized by a
 * time window rather than a count so it scales sensibly regardless of intervalSeconds
 * (a fixed count would exhaust in minutes for a 30s-interval schedule but last months for
 * a daily one).
 */
function occurrencesUntil(scheduleRow, from, until) {
  const results = [];
  const seenTimestamps = new Set();
  let cursorDay = startOfDay(from);
  let daysScanned = 0;
  const maxDays = Math.min(
    MAX_DAYS_TO_SCAN,
    Math.ceil((until - from) / (SECONDS_PER_DAY * 1000)) + 2
  );

  while (
    cursorDay <= until &&
    daysScanned < maxDays &&
    results.length < MAX_OCCURRENCES_PER_WINDOW
  ) {
    if (isDayAllowed(scheduleRow, cursorDay)) {
      const isFromDay = dateOnlyString(cursorDay) === dateOnlyString(from);
      const minSeconds = isFromDay ? secondsSinceMidnight(from) : 0;

      for (const seconds of gridTimesForDay(scheduleRow)) {
        if (seconds < minSeconds) continue;
        const occurrence = new Date(cursorDay);
        occurrence.setSeconds(occurrence.getSeconds() + seconds);
        const timestamp = occurrence.getTime();

        if (occurrence >= from && occurrence <= until && !seenTimestamps.has(timestamp)) {
          results.push(occurrence);
          seenTimestamps.add(timestamp);
        }
      }
    }

    cursorDay = new Date(cursorDay);
    cursorDay.setDate(cursorDay.getDate() + 1);
    daysScanned += 1;
  }

  return results;
}

module.exports = {
  isoWeekday,
  dateOnlyString,
  parseTimeToSeconds,
  isDayAllowed,
  isWithinActiveWindow,
  gridTimesForDay,
  nextOccurrences,
  occurrencesUntil
};
