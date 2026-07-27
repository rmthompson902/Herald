/**
 * Schedule add/edit form - shared between /schedules/new and
 * /schedules/{id}/edit (see webapp/templates/schedules/form.html).
 */
document.addEventListener('DOMContentLoaded', () => {
  const cueInput = document.getElementById('qlab_cue_number');
  const cueMenu = cueInput.closest('.cue-picker').querySelector('.cue-picker-menu');
  CueAPI.getAllCues()
    .then((result) => {
      if (result && result.status === 'success' && Array.isArray(result.cues)) {
        new CuePicker(cueInput, cueMenu, result.cues);
      }
    })
    .catch(() => {
      // Cue browsing needs Node-RED/QLab live - without it the operator
      // just types the cue number manually, no hard failure.
    });

  const form = document.getElementById('scheduleForm');
  const submitBtn = document.getElementById('scheduleSubmitBtn');
  const scheduleId = form.dataset.scheduleId;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const weekdays = Array.from(form.querySelectorAll('.weekday-check:checked')).map((el) =>
      parseInt(el.value, 10)
    );

    const payload = {
      name: form.name.value,
      qlab_cue_number: form.qlab_cue_number.value,
      interval_seconds: parseInt(form.interval_seconds.value, 10),
      start_time: form.start_time.value || null,
      end_time: form.end_time.value || null,
      weekdays: weekdays.length ? weekdays : [1, 2, 3, 4, 5, 6, 7],
      date_range_start: form.date_range_start.value || null,
      date_range_end: form.date_range_end.value || null,
      enabled: form.enabled.checked
    };

    const operation = scheduleId
      ? () => ScheduleAPI.updateSchedule(scheduleId, payload)
      : () => ScheduleAPI.createSchedule(payload);

    const result = await ButtonStateManager.handleAsync(submitBtn, operation, {
      loadingText: window.AppConstants.MESSAGES.SAVING,
      successText: 'Saved'
    });

    if (result && result.status === 'success') {
      window.showToast(
        'Schedule Saved',
        result.message || window.AppConstants.MESSAGES.SCHEDULE_ADDED,
        'success'
      );
      setTimeout(() => {
        window.location.href = '/schedules';
      }, 600);
    } else if (result) {
      window.showToast('Error', result.message || 'Could not save schedule', 'error');
    }
  });
});
