/**
 * VOG messages list page - wires up trigger, enable/disable toggle, and
 * delete row actions to the VogAPI (see static/js/utils/api-client.js).
 */
document.addEventListener('DOMContentLoaded', () => {
  // Enabled *is* armed for VOG - the toggle is the real safety gate (see
  // docs/03-domain-concepts.md), so an armed Trigger fires immediately with no
  // extra confirmation step. A disarmed message's button is server-rendered
  // disabled and the backend rejects it too either way.
  document.querySelectorAll('.trigger-vog-btn').forEach((button) => {
    button.addEventListener('click', async () => {
      const vogId = button.dataset.vogId;
      const result = await ButtonStateManager.handleAsync(
        button,
        () => VogAPI.triggerVogMessage(vogId),
        { loadingText: window.AppConstants.MESSAGES.TRIGGERING, successText: 'Triggered' }
      );
      if (result) {
        window.showToast(
          'VOG Triggered',
          result.message || window.AppConstants.MESSAGES.VOG_TRIGGERED,
          'warning'
        );
      }
    });
  });

  document.querySelectorAll('.toggle-vog-btn').forEach((button) => {
    button.addEventListener('click', async () => {
      const vogId = button.dataset.vogId;
      const result = await ButtonStateManager.handleAsync(
        button,
        () => VogAPI.toggleVogMessage(vogId),
        { loadingText: window.AppConstants.MESSAGES.LOADING }
      );
      if (result) {
        window.showToast('VOG Message Updated', result.message || 'Updated', 'success');
        setTimeout(() => window.location.reload(), 600);
      }
    });
  });

  document.querySelectorAll('.delete-vog-btn').forEach((button) => {
    button.addEventListener('click', () => {
      const vogId = button.dataset.vogId;
      ModalManager.showConfirmation(
        'Delete VOG Message',
        window.AppConstants.MESSAGES.CONFIRM_DELETE_VOG,
        async () => {
          const result = await APIClient.handleResponse(
            VogAPI.removeVogMessage(vogId),
            window.AppConstants.MESSAGES.VOG_REMOVED
          );
          if (result) {
            window.location.reload();
          }
        }
      );
    });
  });

  const enableAllBtn = document.getElementById('enableAllVogBtn');
  if (enableAllBtn) {
    enableAllBtn.addEventListener('click', async () => {
      const result = await ButtonStateManager.handleAsync(
        enableAllBtn,
        () => VogAPI.bulkSetEnabled(true),
        { loadingText: window.AppConstants.MESSAGES.LOADING }
      );
      if (result) {
        window.showToast(
          'VOG Messages Updated',
          window.AppConstants.MESSAGES.VOG_ENABLED_ALL,
          'success'
        );
        setTimeout(() => window.location.reload(), 600);
      }
    });
  }

  const disableAllBtn = document.getElementById('disableAllVogBtn');
  if (disableAllBtn) {
    disableAllBtn.addEventListener('click', () => {
      ModalManager.showConfirmation(
        'Disarm All VOG Messages',
        window.AppConstants.MESSAGES.CONFIRM_DISABLE_ALL_VOG,
        async () => {
          const result = await ButtonStateManager.handleAsync(
            disableAllBtn,
            () => VogAPI.bulkSetEnabled(false),
            { loadingText: window.AppConstants.MESSAGES.LOADING }
          );
          if (result) {
            window.showToast(
              'VOG Messages Updated',
              window.AppConstants.MESSAGES.VOG_DISABLED_ALL,
              'success'
            );
            setTimeout(() => window.location.reload(), 600);
          }
        }
      );
    });
  }
});
