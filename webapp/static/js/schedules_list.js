/**
 * Schedules list page - wires up play-now, enable/disable toggle, and
 * delete row actions to the ScheduleAPI (see static/js/utils/api-client.js).
 */
/**
 * @param {string|null} iso - occurrence timestamp, or null if this schedule has none upcoming
 * @returns {string} - e.g. "in 12s (2:34:07 PM)", or a muted dash if there's nothing next
 */
function formatNextFire(iso) {
    if (!iso) {
        return '<span class="text-muted">no more occurrences</span>';
    }

    const when = new Date(iso);
    const secondsAway = Math.round((when.getTime() - Date.now()) / 1000);
    const clockTime = when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });

    if (secondsAway < 60) {
        return `in ${secondsAway}s <span class="text-muted">(${clockTime})</span>`;
    }
    if (secondsAway < 3600) {
        return `in ${Math.round(secondsAway / 60)}m <span class="text-muted">(${clockTime})</span>`;
    }
    return clockTime;
}

// scheduleId -> iso timestamp|null, refreshed periodically from the server;
// the on-screen countdown itself re-renders every second purely from this
// cache, so the page stays live without hitting the API 60 times a minute.
let nextOccurrencesCache = {};
let lastNextOccurrencesFetchAt = 0;

function anyOccurrenceDue() {
    return Object.values(nextOccurrencesCache).some(
        (iso) => iso && new Date(iso).getTime() - Date.now() <= 0
    );
}

function renderNextFireCells() {
    document.querySelectorAll('.next-fire-cell').forEach((cell) => {
        const scheduleId = cell.dataset.scheduleId;
        if (!Object.prototype.hasOwnProperty.call(nextOccurrencesCache, scheduleId)) return;

        const iso = nextOccurrencesCache[scheduleId];
        if (iso && new Date(iso).getTime() - Date.now() <= 0) {
            // Already due - leave the last countdown value on screen rather
            // than flashing an intermediate "0s"/negative state; the resync
            // below replaces it with the real next occurrence shortly.
            return;
        }
        cell.innerHTML = formatNextFire(iso);
    });

    // A schedule whose cached occurrence just passed needs its real next
    // occurrence (one interval later) from the server, rather than sitting
    // on a stale timestamp until the next scheduled 15s resync - fetch right
    // away, but no more than once every 3s so this can't run away.
    if (anyOccurrenceDue() && Date.now() - lastNextOccurrencesFetchAt > 3000) {
        loadNextOccurrences();
    }
}

function loadNextOccurrences() {
    lastNextOccurrencesFetchAt = Date.now();
    ScheduleAPI.getNextOccurrences().then((result) => {
        if (!result || result.status !== 'success') return;
        nextOccurrencesCache = result.nextOccurrences;
        renderNextFireCells();
    }).catch(() => {
        // Best-effort only - needs Node-RED live. Cells keep their "..." placeholder.
    });
}

document.addEventListener('DOMContentLoaded', () => {
    loadNextOccurrences();
    setInterval(renderNextFireCells, 1000);
    setInterval(loadNextOccurrences, 15000);

    document.querySelectorAll('.play-now-btn').forEach((button) => {
        button.addEventListener('click', async () => {
            const scheduleId = button.dataset.scheduleId;
            const result = await ButtonStateManager.handleAsync(
                button,
                () => ScheduleAPI.playNow(scheduleId),
                { loadingText: window.AppConstants.MESSAGES.LOADING, successText: 'Playing' }
            );
            if (result) {
                const message = result.queued
                    ? window.AppConstants.MESSAGES.SCHEDULE_QUEUED
                    : window.AppConstants.MESSAGES.SCHEDULE_PLAYED;
                window.showToast('Play Now', result.message || message, result.queued ? 'warning' : 'success');
            }
        });
    });

    document.querySelectorAll('.toggle-schedule-btn').forEach((button) => {
        button.addEventListener('click', async () => {
            const scheduleId = button.dataset.scheduleId;
            const result = await ButtonStateManager.handleAsync(
                button,
                () => ScheduleAPI.toggleSchedule(scheduleId),
                { loadingText: window.AppConstants.MESSAGES.LOADING }
            );
            if (result) {
                window.showToast('Schedule Updated', result.message || window.AppConstants.MESSAGES.SCHEDULE_TOGGLED, 'success');
                setTimeout(() => window.location.reload(), 600);
            }
        });
    });

    document.querySelectorAll('.delete-schedule-btn').forEach((button) => {
        button.addEventListener('click', () => {
            const scheduleId = button.dataset.scheduleId;
            ModalManager.showConfirmation(
                'Delete Schedule',
                window.AppConstants.MESSAGES.CONFIRM_DELETE_SCHEDULE,
                async () => {
                    const result = await APIClient.handleResponse(
                        ScheduleAPI.removeSchedule(scheduleId),
                        window.AppConstants.MESSAGES.SCHEDULE_REMOVED
                    );
                    if (result) {
                        window.location.reload();
                    }
                }
            );
        });
    });
});
