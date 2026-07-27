/**
 * Schedules list page - wires up play-now, enable/disable toggle, and
 * delete row actions to the ScheduleAPI (see static/js/utils/api-client.js).
 * Column-sort behavior for the per-zone tables lives in the shared
 * static/js/utils/sortable-tables.js, not here - it wires itself up on any
 * page with a `.sortable-table`, VOG's list page included. Countdown
 * formatting (formatNextFire) lives in the shared static/js/utils/time-format.js,
 * now that queue_visualizer.js is a second consumer of it.
 */
const { formatNextFire } = window.TimeFormat;

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

    const enableAllBtn = document.getElementById('enableAllSchedulesBtn');
    if (enableAllBtn) {
        enableAllBtn.addEventListener('click', async () => {
            const result = await ButtonStateManager.handleAsync(
                enableAllBtn,
                () => ScheduleAPI.bulkSetEnabled(true),
                { loadingText: window.AppConstants.MESSAGES.LOADING }
            );
            if (result) {
                window.showToast('Schedules Updated', window.AppConstants.MESSAGES.SCHEDULES_ENABLED_ALL, 'success');
                setTimeout(() => window.location.reload(), 600);
            }
        });
    }

    const disableAllBtn = document.getElementById('disableAllSchedulesBtn');
    if (disableAllBtn) {
        disableAllBtn.addEventListener('click', () => {
            ModalManager.showConfirmation(
                'Disable All Schedules',
                window.AppConstants.MESSAGES.CONFIRM_DISABLE_ALL_SCHEDULES,
                async () => {
                    const result = await ButtonStateManager.handleAsync(
                        disableAllBtn,
                        () => ScheduleAPI.bulkSetEnabled(false),
                        { loadingText: window.AppConstants.MESSAGES.LOADING }
                    );
                    if (result) {
                        window.showToast('Schedules Updated', window.AppConstants.MESSAGES.SCHEDULES_DISABLED_ALL, 'success');
                        setTimeout(() => window.location.reload(), 600);
                    }
                }
            );
        });
    }
});
