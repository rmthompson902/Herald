/**
 * VOG message add/edit form - shared between /vog/new and /vog/{id}/edit
 * (see webapp/templates/vog/form.html).
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
      // Manual cue-number entry still works without a live cue list.
    });

  const form = document.getElementById('vogForm');
  const submitBtn = document.getElementById('vogSubmitBtn');
  const vogId = form.dataset.vogId;

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const payload = {
      name: form.name.value,
      qlab_cue_number: form.qlab_cue_number.value,
      enabled: form.enabled.checked
    };

    const operation = vogId
      ? () => VogAPI.updateVogMessage(vogId, payload)
      : () => VogAPI.createVogMessage(payload);

    const result = await ButtonStateManager.handleAsync(submitBtn, operation, {
      loadingText: window.AppConstants.MESSAGES.SAVING,
      successText: 'Saved'
    });

    if (result && result.status === 'success') {
      window.showToast(
        'VOG Message Saved',
        result.message || window.AppConstants.MESSAGES.VOG_ADDED,
        'success'
      );
      setTimeout(() => {
        window.location.href = '/vog';
      }, 600);
    } else if (result) {
      window.showToast('Error', result.message || 'Could not save VOG message', 'error');
    }
  });
});
