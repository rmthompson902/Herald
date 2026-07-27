/**
 * Zone queue visualizer (/queues) - one card per zone, each showing that zone's
 * currently-playing cue (pinned above the table, live countdown) and a single merged
 * table of upcoming cues: already-queued FIFO entries and future cron-projected
 * occurrences, interleaved by fire time (see lib/scheduling/zoneUpcomingOccurrences.js).
 * Trimmed to two columns (Cue, Fires) - a name/status/duration column each added enough
 * text that rows were wrapping to multiple lines, so the "is playing" dot now lives
 * inline in the Cue cell and duration is folded into the Fires cell (as the live clock
 * for the currently-playing row only - everything else just shows when it fires).
 *
 * Live state arrives over the shared SocketIO connection declared in base.html (the
 * bare `socket` identifier below - see static/js/status.js for the same pattern):
 *   - queue_state_update: full occupancy/queued snapshot, replaces the cache and
 *     re-renders every card.
 *   - queue_event: one raw engine event: queued/fired/zone_freed/etc. mean a zone's
 *     cached upcoming batch may now be stale (a live entry it had deduped against just
 *     changed), so that zone's batch is dropped and re-fetched from offset 0;
 *     suspected_playback_failure drives the per-zone warning badge.
 *
 * Duration is never fabricated: a currently-playing cue whose duration was never
 * resolved (knownDurationMs: null) renders as "Duration unknown" text, never a fake
 * countdown clock.
 */

const RECENT_FAILURE_WINDOW_MS = 10 * 60 * 1000; // how long the warning badge stays lit
const UPCOMING_BATCH_SIZE = 25;
const INVALIDATING_EVENTS = new Set([
  'queued',
  'dropped_stale',
  'fired',
  'zone_freed',
  'queue_overflow_dropped',
  'preempted_before_fire'
]);

let occupancyByZone = {};
let queuedByZone = {};
const upcomingByZone = {}; // zone -> { items, offset, hasMore, loading }
const recentFailureAtByZone = {};
const observerByZone = {};

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function zoneNames() {
  return Array.from(document.querySelectorAll('.zone-queue-card')).map((el) => el.dataset.zone);
}

function emptyUpcomingState() {
  return { items: [], offset: 0, hasMore: true, loading: false };
}

function loadUpcomingBatch(zone, { reset = false } = {}) {
  const state = upcomingByZone[zone] || emptyUpcomingState();
  if (state.loading) return;
  if (!reset && !state.hasMore) return;

  state.loading = true;
  upcomingByZone[zone] = state;
  const offset = reset ? 0 : state.offset;

  QueueAPI.getUpcoming(zone, offset, UPCOMING_BATCH_SIZE)
    .then((result) => {
      if (!result || result.status !== 'success') {
        state.loading = false;
        return;
      }
      const previousItems = offset === 0 ? [] : upcomingByZone[zone].items || [];
      upcomingByZone[zone] = {
        items: previousItems.concat(result.occurrences),
        offset: offset + result.occurrences.length,
        hasMore: result.hasMore,
        loading: false
      };
      renderZoneCard(zone);
    })
    .catch(() => {
      state.loading = false;
    });
}

function invalidateUpcoming(zone) {
  if (!zoneNames().includes(zone)) return; // an unconfigured/renamed zone - nothing to render
  upcomingByZone[zone] = emptyUpcomingState();
  loadUpcomingBatch(zone, { reset: true });
}

function renderClockMarkup(knownDurationMs) {
  if (knownDurationMs == null) {
    return '<span class="text-muted queue-duration-unknown">Duration unknown</span>';
  }
  return `
        <div class="queue-clock">
            <span class="queue-clock-time"></span>
            <div class="queue-clock-rail"><div class="queue-clock-fill" style="width: 100%"></div></div>
        </div>`;
}

/**
 * The occupancy map has three genuinely distinct states, not two - conflating the first
 * two (both have firedAt == null) previously mislabeled an ordinary cue that was still
 * going through the duck-wait/confirm-before-fire admission chain as "Unducking", which
 * is only ever true for the THIRD state below:
 *   1. Admitted but not yet fired (zoneQueueEngine.js's _tryAdvance, `confirmed: false`) -
 *      a real cue, reserved while its zone's duck cue plays or a getIsRunningByUniqueId
 *      retry loop resolves. firedAt/expectedEndAt are null because it hasn't actually
 *      started yet, not because it's a placeholder.
 *   2. Actually fired and playing (`_fire`, `confirmed: true`, firedAt set) - the normal
 *      live-countdown case.
 *   3. The synthetic unduck-wait marker (`_maybeUnduck`) - a zone reserved with no real
 *      cue at all while its unduck cue plays. The ONLY reliable signal for this is
 *      `entry.id === null` (see that function's own unduckEntry literal), not firedAt -
 *      state 1 has a null firedAt too, but a real entry.id.
 */
function renderOccupancyRow(occupancy) {
  const { entry, expectedEndAt, knownDurationMs, firedAt } = occupancy;

  if (entry.id === null) {
    return `
        <tr class="queue-row-now-playing" data-role="now-playing">
            <td colspan="2"><span class="queue-status-dot is-playing" aria-hidden="true"></span>Unducking&hellip;</td>
        </tr>`;
  }

  const name = escapeHtml(entry.name || String(entry.cueNumber));

  if (firedAt == null) {
    return `
        <tr class="queue-row-now-playing" data-role="now-playing">
            <td><span class="queue-status-dot is-playing" aria-hidden="true"></span>${name}</td>
            <td class="text-muted">Starting&hellip;</td>
        </tr>`;
  }

  return `
    <tr class="queue-row-now-playing" data-role="now-playing"
        data-fired-at="${firedAt}" data-expected-end-at="${expectedEndAt}"
        data-known-duration-ms="${knownDurationMs == null ? '' : knownDurationMs}">
        <td><span class="queue-status-dot is-playing" aria-hidden="true"></span>${name}</td>
        <td class="queue-clock-cell">${renderClockMarkup(knownDurationMs)}</td>
    </tr>`;
}

/**
 * A row already admitted into zoneQueueEngine's real per-zone FIFO (queuedByZone) is
 * genuinely different from a merely-projected future occurrence: it's blocked on the zone
 * clearing, not counting down to a future due moment - its own dueAt is often already in
 * the past the instant two schedules land on the same moment (the later one waits its
 * turn), which is exactly why showing a countdown for it drove the "Fires" text into
 * negative numbers. Showing "Waiting" instead is both more honest and sidesteps the
 * negative-countdown case entirely, rather than needing to clamp it.
 */
function renderFiresCell(row) {
  if (row.isWaiting) {
    return (
      '<span class="text-muted" data-bs-toggle="tooltip" data-bs-placement="top" ' +
      'data-bs-title="Queued - will play as soon as the zone clears.">Waiting</span>'
    );
  }
  const iso = new Date(row.dueAtMs).toISOString();
  // A projected occurrence can already be (very briefly) overdue at first paint if it's
  // due right as this card loads/re-renders - same "hold, don't go negative" rule tickZone
  // applies on every subsequent tick, just needing a starting value here too.
  const text =
    row.dueAtMs - Date.now() <= 0
      ? '<span class="text-muted">due now</span>'
      : TimeFormat.formatNextFire(iso);
  return `<span data-due-at="${iso}">${text}</span>`;
}

function renderUpcomingRow(row) {
  const dotClass = row.isWaiting ? 'is-waiting' : 'is-idle';
  return `
    <tr>
        <td><span class="queue-status-dot ${dotClass}" aria-hidden="true"></span>${escapeHtml(row.name)}</td>
        <td>${renderFiresCell(row)}</td>
    </tr>`;
}

function normalizeQueued(entry) {
  return { dueAtMs: entry.dueAt, name: entry.name || String(entry.cueNumber), isWaiting: true };
}

function normalizeUpcoming(occurrence) {
  return {
    dueAtMs: new Date(occurrence.dueAt).getTime(),
    name: occurrence.cueDisplayName || occurrence.name || occurrence.qlabCueNumber,
    isWaiting: false
  };
}

function renderZoneCard(zone) {
  const tbody = document.querySelector(`tbody[data-zone-tbody="${CSS.escape(zone)}"]`);
  if (!tbody) return;

  const occupancy = occupancyByZone[zone];
  const queued = (queuedByZone[zone] || []).map(normalizeQueued);
  const upcoming = ((upcomingByZone[zone] || {}).items || []).map(normalizeUpcoming);
  const merged = queued.concat(upcoming).sort((a, b) => a.dueAtMs - b.dueAtMs);

  const rows = [];
  if (occupancy) rows.push(renderOccupancyRow(occupancy));

  if (!occupancy && merged.length === 0) {
    rows.push(`
        <tr class="text-muted">
            <td colspan="2" class="text-center py-4"><i class="fas fa-calendar-check me-2"></i>Nothing scheduled for this zone yet.</td>
        </tr>`);
  } else {
    merged.forEach((row) => rows.push(renderUpcomingRow(row)));
  }

  const hasMore = (upcomingByZone[zone] || {}).hasMore;
  if (hasMore) {
    rows.push(`
        <tr data-zone-sentinel="${escapeHtml(zone)}">
            <td colspan="2" class="text-center text-muted py-2"><i class="fas fa-spinner fa-spin me-1"></i>Loading more&hellip;</td>
        </tr>`);
  }

  tbody.innerHTML = rows.join('');
  tickZone(zone);
  observeSentinel(zone);
}

function renderAllZoneCards() {
  zoneNames().forEach(renderZoneCard);
}

/** Recomputes every visible countdown purely from cached data - no network call, same
 *  "cheap local tick" discipline as schedules_list.js's renderNextFireCells. Covers both
 *  the pinned now-playing row's draining clock AND every upcoming/queued row's "Fires"
 *  text (previously only the clock ticked - the Fires column sat frozen at its
 *  render-time value instead of counting down like the Schedules page's Next Fire
 *  column does). */
function tickZone(zone) {
  const tbody = document.querySelector(`tbody[data-zone-tbody="${CSS.escape(zone)}"]`);
  if (!tbody) return;

  const nowPlayingRow = tbody.querySelector('tr[data-role="now-playing"]');
  if (
    nowPlayingRow &&
    nowPlayingRow.dataset.knownDurationMs !== undefined &&
    nowPlayingRow.dataset.knownDurationMs !== ''
  ) {
    const knownDurationMs = Number(nowPlayingRow.dataset.knownDurationMs);
    const expectedEndAt = Number(nowPlayingRow.dataset.expectedEndAt);
    const remaining = Math.max(0, expectedEndAt - Date.now());
    const pct = knownDurationMs > 0 ? Math.round((remaining / knownDurationMs) * 100) : 0;

    const fill = nowPlayingRow.querySelector('.queue-clock-fill');
    const time = nowPlayingRow.querySelector('.queue-clock-time');
    if (fill) {
      fill.style.width = `${pct}%`;
      fill.classList.toggle('is-ending', pct <= 15);
    }
    if (time) time.textContent = TimeFormat.formatClockTime(remaining);
  }

  tbody.querySelectorAll('[data-due-at]').forEach((el) => {
    // Once due, hold the last-rendered text rather than counting on into negative
    // numbers (same guard schedules_list.js's renderNextFireCells applies) - this
    // element only exists on non-waiting rows in the first place (see
    // renderFiresCell), so a brief overdue window here just means the next
    // queue_state_update/queue_event hasn't caught up yet, not a real bug.
    if (new Date(el.dataset.dueAt).getTime() - Date.now() <= 0) return;
    el.innerHTML = TimeFormat.formatNextFire(el.dataset.dueAt);
  });
}

function tickAll() {
  zoneNames().forEach(tickZone);
  zoneNames().forEach(updateWarningBadge);
}

function updateWarningBadge(zone) {
  const badge = document.querySelector(`[data-zone-warning-badge="${CSS.escape(zone)}"]`);
  if (!badge) return;
  const lastFailureAt = recentFailureAtByZone[zone];
  const isRecent = lastFailureAt && Date.now() - lastFailureAt < RECENT_FAILURE_WINDOW_MS;
  badge.classList.toggle('d-none', !isRecent);
}

function observeSentinel(zone) {
  if (observerByZone[zone]) {
    observerByZone[zone].disconnect();
    delete observerByZone[zone];
  }

  const card = document.querySelector(`.zone-queue-card[data-zone="${CSS.escape(zone)}"]`);
  const scrollRoot = card && card.querySelector('.zone-queue-scroll');
  const sentinel = card && card.querySelector('[data-zone-sentinel]');
  if (!card || !scrollRoot || !sentinel) return;

  const observer = new IntersectionObserver(
    (entries) => {
      entries.forEach((entry) => {
        if (entry.isIntersecting) {
          observer.disconnect();
          loadUpcomingBatch(zone);
        }
      });
    },
    { root: scrollRoot, threshold: 0 }
  );

  observer.observe(sentinel);
  observerByZone[zone] = observer;
}

function eventZones(evt) {
  if (evt.extra && evt.extra.zone) return [evt.extra.zone];
  if (evt.entry && Array.isArray(evt.entry.zones)) return evt.entry.zones;
  return [];
}

document.addEventListener('DOMContentLoaded', () => {
  QueueAPI.getState()
    .then((result) => {
      if (result && result.status === 'success') {
        occupancyByZone = result.occupancy || {};
        queuedByZone = result.queued || {};
        renderAllZoneCards();
      }
    })
    .catch(() => {
      // Best-effort - the initial upcoming-batch fetch below and the eventual socket
      // push both still work independently of this call succeeding.
    });

  zoneNames().forEach((zone) => loadUpcomingBatch(zone, { reset: true }));

  setInterval(tickAll, 1000);

  socket.on('queue_state_update', (state) => {
    occupancyByZone = state.occupancy || {};
    queuedByZone = state.queued || {};
    renderAllZoneCards();
  });

  socket.on('queue_event', (evt) => {
    if (INVALIDATING_EVENTS.has(evt.event)) {
      eventZones(evt).forEach(invalidateUpcoming);
    }
    if (evt.event === 'suspected_playback_failure' && evt.extra && evt.extra.zone) {
      recentFailureAtByZone[evt.extra.zone] = Date.now();
      updateWarningBadge(evt.extra.zone);
    }
  });
});
