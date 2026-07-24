/**
 * Zone add/edit form - shared between /zones/new and /zones/{zone_name}/edit
 * (see webapp/templates/zones/form.html).
 */
document.addEventListener('DOMContentLoaded', () => {
    const form = document.getElementById('zoneForm');
    const submitBtn = document.getElementById('zoneSubmitBtn');
    const isEditing = form.dataset.editing === 'true';

    const patchSelect = document.getElementById('messaging_patch_id');
    const currentPatchId = patchSelect.dataset.currentPatchId || '';

    ZoneAPI.getPatches().then((result) => {
        patchSelect.innerHTML = '';
        if (!result || result.status !== 'success' || !Array.isArray(result.patches)) {
            const opt = document.createElement('option');
            opt.value = '';
            opt.textContent = 'Could not load patches from QLab';
            patchSelect.appendChild(opt);
            return;
        }

        const placeholder = document.createElement('option');
        placeholder.value = '';
        placeholder.textContent = 'Select a patch…';
        patchSelect.appendChild(placeholder);

        result.patches.forEach((patch) => {
            const opt = document.createElement('option');
            opt.value = patch.patchId;
            opt.textContent = `${patch.patchId} — ${patch.name}`;
            if (patch.patchId === currentPatchId) opt.selected = true;
            patchSelect.appendChild(opt);
        });
    }).catch(() => {
        patchSelect.innerHTML = '<option value="">Could not load patches from QLab</option>';
    });

    // Only present on the "add" form - a real message cue number in the new zone, used
    // purely to autofill the fields below (never submitted itself).
    const referenceCueInput = document.getElementById('reference_cue_number');
    if (referenceCueInput) {
        referenceCueInput.addEventListener('blur', async () => {
            const cueNumber = referenceCueInput.value.trim();
            if (!cueNumber) return;

            const result = await ZoneAPI.discover(cueNumber).catch(() => null);
            if (!result || result.status !== 'success') return;

            if (result.patchId) {
                const match = Array.from(patchSelect.options).find((opt) => opt.value === result.patchId);
                if (match) patchSelect.value = result.patchId;
            }
            if (result.zoneName) form.zone_name.value = result.zoneName;
            if (result.duckCueNumber) form.duck_cue_number.value = result.duckCueNumber;
            if (result.unduckCueNumber) form.unduck_cue_number.value = result.unduckCueNumber;
        });
    }

    form.addEventListener('submit', async (event) => {
        event.preventDefault();

        const payload = {
            messaging_patch_id: form.messaging_patch_id.value,
            duck_cue_number: form.duck_cue_number.value,
            unduck_cue_number: form.unduck_cue_number.value
        };

        const zoneName = form.zone_name.value;
        const operation = isEditing
            ? () => ZoneAPI.updateZone(zoneName, payload)
            : () => ZoneAPI.createZone({ zone_name: zoneName, ...payload });

        const result = await ButtonStateManager.handleAsync(submitBtn, operation, {
            loadingText: window.AppConstants.MESSAGES.SAVING,
            successText: 'Saved'
        });

        if (result && result.status === 'success') {
            const message = isEditing ? window.AppConstants.MESSAGES.ZONE_UPDATED : window.AppConstants.MESSAGES.ZONE_ADDED;
            window.showToast('Zone Saved', result.message || message, 'success');
            setTimeout(() => { window.location.href = '/settings'; }, 600);
        } else if (result) {
            window.showToast('Error', result.message || 'Could not save zone', 'error');
        }
    });
});
