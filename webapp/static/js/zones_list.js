/**
 * Zones list page - wires up delete-zone actions to the ZoneAPI (see
 * static/js/utils/api-client.js). Add/Edit are plain links to zones/form.html, no JS needed
 * on this page for those.
 */
document.addEventListener('DOMContentLoaded', () => {
    document.querySelectorAll('.delete-zone-btn').forEach((button) => {
        button.addEventListener('click', () => {
            const zoneName = button.dataset.zoneName;
            ModalManager.showConfirmation(
                'Delete Zone',
                window.AppConstants.MESSAGES.CONFIRM_DELETE_ZONE,
                async () => {
                    const result = await APIClient.handleResponse(
                        ZoneAPI.removeZone(zoneName),
                        window.AppConstants.MESSAGES.ZONE_REMOVED
                    );
                    if (result) {
                        window.location.reload();
                    }
                }
            );
        });
    });
});
