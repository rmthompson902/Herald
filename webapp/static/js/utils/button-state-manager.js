/**
 * Button State Manager Utility
 * Manages button loading states and prevents duplicate form submissions
 */
class ButtonStateManager {
    /**
     * Set button to loading state. An icon-only button (edit/delete/toggle/play,
     * etc.) is just disabled while loading - its icon does not spin, since a
     * spin only means something for an actual refresh/reload action. A
     * text button gets a genuine loading spinner (Bootstrap's spinner-border)
     * in place of its label, which already serves as that button's real
     * "in progress" indicator - the refresh buttons (Refresh Cue Data, Refresh
     * Log Entries) are text buttons and get this for free, no special-casing
     * needed.
     * @param {HTMLElement} button - The button element
     * @param {string} loadingText - Text to display during loading
     */
    static setLoading(button, loadingText = 'Loading') {
        if (!button) return;

        button.dataset.originalContent = button.innerHTML;
        button.dataset.originalDisabled = button.disabled;

        const isIconOnlyButton = button.classList.contains('action-btn-notext') ||
                                 button.classList.contains('btn-square');

        if (!isIconOnlyButton) {
            button.innerHTML = `<span class="spinner-border spinner-border-sm me-2" role="status" aria-hidden="true"></span>${loadingText}`;
        }

        button.disabled = true;
        button.classList.add('loading');
    }

    /**
     * Reset button to original state
     * @param {HTMLElement} button - The button element
     */
    static reset(button) {
        if (!button) return;

        if (button.dataset.originalContent) {
            button.innerHTML = button.dataset.originalContent;
            delete button.dataset.originalContent;
        }

        if (button.dataset.originalDisabled !== undefined) {
            button.disabled = button.dataset.originalDisabled === 'true';
            delete button.dataset.originalDisabled;
        } else {
            button.disabled = false;
        }

        button.classList.remove('loading', 'btn-success', 'btn-danger', 'btn-primary', 'btn-info', 'btn-warning');
    }

    /**
     * Set button to success state temporarily
     * @param {HTMLElement} button - The button element
     * @param {string} successText - Text to display for success
     * @param {number} duration - Duration in milliseconds
     */
    static setSuccess(button, successText = 'Success', duration = 2000) {
        if (!button) return;

        const originalContent = button.dataset.originalContent || button.innerHTML;
        const originalDisabled = button.dataset.originalDisabled !== undefined ?
            button.dataset.originalDisabled === 'true' : false;

        const isIconOnlyButton = button.classList.contains('action-btn-notext') ||
                                 button.classList.contains('btn-square');

        if (isIconOnlyButton) {
            button.innerHTML = '<i class="fas fa-check text-success"></i>';
        } else {
            button.innerHTML = `<i class="fas fa-check me-1"></i> ${successText}`;
            button.classList.add('btn-success');
        }

        button.disabled = true;

        setTimeout(() => {
            button.innerHTML = originalContent;
            button.disabled = originalDisabled;
            if (!isIconOnlyButton) {
                button.classList.remove('btn-success');
            }
            button.classList.remove('loading');
            delete button.dataset.originalContent;
            delete button.dataset.originalDisabled;
        }, duration);
    }

    /**
     * Set button to error state temporarily
     * @param {HTMLElement} button - The button element
     * @param {string} errorText - Text to display for error
     * @param {number} duration - Duration in milliseconds
     */
    static setError(button, errorText = 'Error', duration = 3000) {
        if (!button) return;

        const originalContent = button.dataset.originalContent || button.innerHTML;
        const originalDisabled = button.dataset.originalDisabled !== undefined ?
            button.dataset.originalDisabled === 'true' : false;

        const isIconOnlyButton = button.classList.contains('action-btn-notext') ||
                                 button.classList.contains('btn-square');

        if (isIconOnlyButton) {
            button.innerHTML = '<i class="fas fa-times text-danger"></i>';
        } else {
            button.innerHTML = `<i class="fas fa-times me-1"></i> ${errorText}`;
            button.classList.add('btn-danger');
        }

        button.disabled = true;

        setTimeout(() => {
            button.innerHTML = originalContent;
            button.disabled = originalDisabled;
            if (!isIconOnlyButton) {
                button.classList.remove('btn-danger');
            }
            button.classList.remove('loading');
            delete button.dataset.originalContent;
            delete button.dataset.originalDisabled;
        }, duration);
    }

    /**
     * Handle async operation with button state management
     * @param {HTMLElement} button - The button element
     * @param {Function} operation - Async operation to perform
     * @param {Object} options - Options for text and duration
     */
    static async handleAsync(button, operation, options = {}) {
        const {
            loadingText = 'Loading',
            successText = 'Success',
            errorText = 'Error',
            successDuration = 2000,
            errorDuration = 3000
        } = options;

        try {
            this.setLoading(button, loadingText);
            const result = await operation();

            if (result && result.status === 'success') {
                this.setSuccess(button, successText, successDuration);
            } else {
                this.setError(button, errorText, errorDuration);
            }

            return result;
        } catch (error) {
            this.setError(button, errorText, errorDuration);
            throw error;
        }
    }
}
