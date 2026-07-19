/**
 * VOG messages list page - wires up trigger, enable/disable toggle, and
 * delete row actions to the VogAPI (see static/js/utils/api-client.js).
 */
document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.trigger-vog-btn').forEach((button) => {
        button.addEventListener('click', () => {
            const vogId = button.dataset.vogId;
            ModalManager.showConfirmation(
                'Trigger VOG Message',
                window.AppConstants.MESSAGES.CONFIRM_TRIGGER_VOG,
                async () => {
                    const result = await ButtonStateManager.handleAsync(
                        button,
                        () => VogAPI.triggerVogMessage(vogId),
                        { loadingText: window.AppConstants.MESSAGES.TRIGGERING, successText: 'Triggered' }
                    );
                    if (result) {
                        window.showToast('VOG Triggered', result.message || window.AppConstants.MESSAGES.VOG_TRIGGERED, 'warning');
                    }
                }
            );
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
});
