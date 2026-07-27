/**
 * Global "Refresh Cue Data" button - baked into the shared page_header macro
 * (partials/components/page_header.html), so it's present on every page
 * without each page needing to wire it up separately. Re-reads every
 * referenced cue's duration/zones from QLab; Node-RED also sweeps this
 * automatically every 5 minutes, so this button is for "show me the change
 * I just made in QLab right now" rather than the only way it happens.
 */
document.addEventListener('DOMContentLoaded', () => {
  const button = document.getElementById('refreshCuesBtn');
  if (!button) return;

  button.addEventListener('click', async () => {
    const result = await ButtonStateManager.handleAsync(button, () => CueAPI.refreshAllCues(), {
      loadingText: window.AppConstants.MESSAGES.REFRESHING,
      successText: 'Refreshed'
    });
    if (result) {
      window.showToast('Cue Data Refreshed', window.AppConstants.MESSAGES.CUE_REFRESHED, 'success');
      setTimeout(() => window.location.reload(), 500);
    }
  });
});
