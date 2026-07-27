/**
 * Zone queue visualizer (/queue) - one card per zone, each showing that zone's
 * currently-playing cue (pinned above the table, live countdown) and a single merged
 * table of upcoming cues: already-queued FIFO entries and future cron-projected
 * occurrences, interleaved by fire time (see lib/scheduling/zoneUpcomingOccurrences.js).
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
 * Duration is never fabricated: a cue whose duration was never resolved
 * (knownDurationMs: null) renders as "Duration unknown" text, never a fake countdown.
 */

const RECENT_FAILURE_WINDOW_MS = 10 * 60 * 1000; // how long the warning badge stays lit
const UPCOMING_BATCH_SIZE = 25;
const INVALIDATING_EVENTS = new Set(['queued', 'dropped_stale', 'fired', 'zone_freed', 'queue_overflow_dropped', 'preempted_before_fire']);

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

    QueueAPI.getUpcoming(zone, offset, UPCOMING_BATCH_SIZE).then((result) => {
        if (!result || result.status !== 'success') {
            state.loading = false;
            return;
        }
        const previousItems = offset === 0 ? [] : (upcomingByZone[zone].items || []);
        upcomingByZone[zone] = {
            items: previousItems.concat(result.occurrences),
            offset: offset + result.occurrences.length,
            hasMore: result.hasMore,
            loading: false
        };
        renderZoneCard(zone);
    }).catch(() => {
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

function renderNowPlayingRow(occupancy) {
    const { entry, expectedEndAt, knownDurationMs, firedAt } = occupancy;

    if (firedAt == null) {
        // The synthetic unduck-wait marker (see zoneQueueEngine.js's markDucked/_maybeUnduck) -
        // the zone is claimed but nothing is actually playing yet, so there's no cue/duration
        // to show, only that the zone isn't free.
        return `
        <tr class="queue-row-now-playing" data-role="now-playing">
            <td colspan="4"><span class="queue-status-dot is-playing" aria-hidden="true"></span>Unducking&hellip;</td>
        </tr>`;
    }

    const name = escapeHtml(entry.name || String(entry.cueNumber));
    const cueNumber = escapeHtml(String(entry.cueNumber));

    return `
    <tr class="queue-row-now-playing" data-role="now-playing"
        data-fired-at="${firedAt}" data-expected-end-at="${expectedEndAt}"
        data-known-duration-ms="${knownDurationMs == null ? '' : knownDurationMs}">
        <td>${name} <code>${cueNumber}</code></td>
        <td><span class="queue-status-dot is-playing" aria-hidden="true"></span>Now playing</td>
        <td class="queue-clock-cell">${renderClockMarkup(knownDurationMs)}</td>
        <td class="text-muted">&mdash;</td>
    </tr>`;
}

function renderUpcomingRow(row) {
    const durationText = row.durationSeconds != null
        ? `${row.durationSeconds.toFixed(1)}s`
        : '<span class="text-muted">&mdash;</span>';

    return `
    <tr>
        <td>${escapeHtml(row.name)} <code>${escapeHtml(String(row.cueNumber))}</code></td>
        <td><span class="queue-status-dot is-idle" aria-hidden="true"></span>${row.statusLabel}</td>
        <td>${durationText}</td>
        <td>${TimeFormat.formatNextFire(new Date(row.dueAtMs).toISOString())}</td>
    </tr>`;
}

function normalizeQueued(entry) {
    return {
        dueAtMs: entry.dueAt,
        name: entry.name || entry.cueNumber,
        cueNumber: entry.cueNumber,
        durationSeconds: entry.durationSeconds ?? null,
        statusLabel: 'Queued'
    };
}

function normalizeUpcoming(occurrence) {
    return {
        dueAtMs: new Date(occurrence.dueAt).getTime(),
        name: occurrence.cueDisplayName || occurrence.name || occurrence.qlabCueNumber,
        cueNumber: occurrence.qlabCueNumber,
        durationSeconds: occurrence.durationSeconds ?? null,
        statusLabel: 'Scheduled'
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
    if (occupancy) rows.push(renderNowPlayingRow(occupancy));

    if (!occupancy && merged.length === 0) {
        rows.push(`
        <tr class="text-muted">
            <td colspan="4" class="text-center py-4"><i class="fas fa-calendar-check me-2"></i>Nothing scheduled for this zone yet.</td>
        </tr>`);
    } else {
        merged.forEach((row) => rows.push(renderUpcomingRow(row)));
    }

    const hasMore = (upcomingByZone[zone] || {}).hasMore;
    if (hasMore) {
        rows.push(`
        <tr data-zone-sentinel="${escapeHtml(zone)}">
            <td colspan="4" class="text-center text-muted py-2"><i class="fas fa-spinner fa-spin me-1"></i>Loading more&hellip;</td>
        </tr>`);
    }

    tbody.innerHTML = rows.join('');
    tickZone(zone);
    observeSentinel(zone);
}

function renderAllZoneCards() {
    zoneNames().forEach(renderZoneCard);
}

/** Recomputes every visible countdown purely from cached firedAt/knownDurationMs - no
 *  network call, same "cheap local tick" discipline as schedules_list.js. */
function tickZone(zone) {
    const row = document.querySelector(`tbody[data-zone-tbody="${CSS.escape(zone)}"] tr[data-role="now-playing"]`);
    if (!row || row.dataset.knownDurationMs === undefined || row.dataset.knownDurationMs === '') return;

    const knownDurationMs = Number(row.dataset.knownDurationMs);
    const expectedEndAt = Number(row.dataset.expectedEndAt);
    const remaining = Math.max(0, expectedEndAt - Date.now());
    const pct = knownDurationMs > 0 ? Math.round((remaining / knownDurationMs) * 100) : 0;

    const fill = row.querySelector('.queue-clock-fill');
    const time = row.querySelector('.queue-clock-time');
    if (fill) {
        fill.style.width = `${pct}%`;
        fill.classList.toggle('is-ending', pct <= 15);
    }
    if (time) time.textContent = TimeFormat.formatClockTime(remaining);
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

    const observer = new IntersectionObserver((entries) => {
        entries.forEach((entry) => {
            if (entry.isIntersecting) {
                observer.disconnect();
                loadUpcomingBatch(zone);
            }
        });
    }, { root: scrollRoot, threshold: 0 });

    observer.observe(sentinel);
    observerByZone[zone] = observer;
}

function eventZones(evt) {
    if (evt.extra && evt.extra.zone) return [evt.extra.zone];
    if (evt.entry && Array.isArray(evt.entry.zones)) return evt.entry.zones;
    return [];
}

document.addEventListener('DOMContentLoaded', () => {
    QueueAPI.getState().then((result) => {
        if (result && result.status === 'success') {
            occupancyByZone = result.occupancy || {};
            queuedByZone = result.queued || {};
            renderAllZoneCards();
        }
    }).catch(() => {
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
