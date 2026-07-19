/**
 * Schedules list page - wires up play-now, enable/disable toggle, and
 * delete row actions to the ScheduleAPI (see static/js/utils/api-client.js).
 */
document.addEventListener('DOMContentLoaded', () => {
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
