/**
 * Modal Manager Utility
 * Manages Bootstrap modals with consistent behavior
 */
/* exported ModalManager */
class ModalManager {
  /**
   * Show a modal
   * @param {string} modalId - Modal element ID
   * @param {Object} options - Bootstrap modal options
   */
  static show(modalId, options = {}) {
    const modalElement = document.getElementById(modalId);
    if (!modalElement) {
      console.error(`Modal with ID '${modalId}' not found`);
      return null;
    }

    const modal = new bootstrap.Modal(modalElement, options);
    modal.show();
    return modal;
  }

  /**
   * Hide a modal
   * @param {string} modalId - Modal element ID
   */
  static hide(modalId) {
    const modalElement = document.getElementById(modalId);
    if (!modalElement) {
      console.error(`Modal with ID '${modalId}' not found`);
      return;
    }

    const modal = bootstrap.Modal.getInstance(modalElement);
    if (modal) {
      modal.hide();
    }
  }

  /**
   * Clear form fields in a modal
   * @param {string} modalId - Modal element ID
   * @param {string} formSelector - Form selector within modal
   */
  static clearForm(modalId, formSelector = 'form') {
    const modalElement = document.getElementById(modalId);
    if (!modalElement) {
      console.error(`Modal with ID '${modalId}' not found`);
      return;
    }

    const form = modalElement.querySelector(formSelector);
    if (form) {
      form.reset();

      form.querySelectorAll('.is-invalid, .is-valid').forEach((element) => {
        element.classList.remove('is-invalid', 'is-valid');
      });

      form.querySelectorAll('.invalid-feedback').forEach((element) => {
        element.textContent = '';
      });
    }
  }

  /**
   * Reset modal to initial state
   * @param {string} modalId - Modal element ID
   */
  static reset(modalId) {
    this.clearForm(modalId);

    const modalElement = document.getElementById(modalId);
    if (modalElement) {
      modalElement.querySelectorAll('button').forEach((button) => {
        ButtonStateManager.reset(button);
      });
    }
  }

  /**
   * Set modal title
   * @param {string} modalId - Modal element ID
   * @param {string} title - New title
   */
  static setTitle(modalId, title) {
    const modalElement = document.getElementById(modalId);
    if (!modalElement) {
      console.error(`Modal with ID '${modalId}' not found`);
      return;
    }

    const titleElement = modalElement.querySelector('.modal-title');
    if (titleElement) {
      titleElement.textContent = title;
    }
  }

  /**
   * Populate form fields in a modal
   * @param {string} modalId - Modal element ID
   * @param {Object} data - Data to populate
   * @param {string} formSelector - Form selector within modal
   */
  static populateForm(modalId, data, formSelector = 'form') {
    const modalElement = document.getElementById(modalId);
    if (!modalElement) {
      console.error(`Modal with ID '${modalId}' not found`);
      return;
    }

    const form = modalElement.querySelector(formSelector);
    if (!form) {
      console.error(`Form '${formSelector}' not found in modal '${modalId}'`);
      return;
    }

    Object.entries(data).forEach(([key, value]) => {
      const field = form.querySelector(`[name="${key}"], #${key}`);
      if (field) {
        if (field.type === 'checkbox') {
          field.checked = Boolean(value);
        } else if (field.type === 'radio') {
          const radioButton = form.querySelector(`input[name="${key}"][value="${value}"]`);
          if (radioButton) {
            radioButton.checked = true;
          }
        } else {
          field.value = value || '';
        }
      }
    });
  }

  /**
   * Get form data from a modal
   * @param {string} modalId - Modal element ID
   * @param {string} formSelector - Form selector within modal
   * @returns {Object} - Form data
   */
  static getFormData(modalId, formSelector = 'form') {
    const modalElement = document.getElementById(modalId);
    if (!modalElement) {
      console.error(`Modal with ID '${modalId}' not found`);
      return {};
    }

    const form = modalElement.querySelector(formSelector);
    if (!form) {
      console.error(`Form '${formSelector}' not found in modal '${modalId}'`);
      return {};
    }

    const formData = new FormData(form);
    const data = {};

    for (const [key, value] of formData.entries()) {
      data[key] = value;
    }

    return data;
  }

  /**
   * Add event listener to modal
   * @param {string} modalId - Modal element ID
   * @param {string} event - Event type
   * @param {Function} callback - Event callback
   */
  static addEventListener(modalId, event, callback) {
    const modalElement = document.getElementById(modalId);
    if (!modalElement) {
      console.error(`Modal with ID '${modalId}' not found`);
      return;
    }

    modalElement.addEventListener(event, callback);
  }

  /**
   * Show confirmation modal
   * @param {string} title - Modal title
   * @param {string} message - Confirmation message
   * @param {Function} onConfirm - Confirmation callback
   * @param {Function} onCancel - Cancel callback
   */
  static showConfirmation(title, message, onConfirm, onCancel = null) {
    let confirmModal = document.getElementById('confirmationModal');
    if (!confirmModal) {
      confirmModal = this.createConfirmationModal();
      document.body.appendChild(confirmModal);
    }

    confirmModal.querySelector('.modal-title').textContent = title;
    confirmModal.querySelector('.modal-body').textContent = message;

    const confirmButton = confirmModal.querySelector('.btn-danger');
    const cancelButton = confirmModal.querySelector('.btn-secondary');

    confirmButton.replaceWith(confirmButton.cloneNode(true));
    cancelButton.replaceWith(cancelButton.cloneNode(true));

    confirmModal.querySelector('.btn-danger').addEventListener('click', () => {
      this.hide('confirmationModal');
      if (onConfirm) onConfirm();
    });

    confirmModal.querySelector('.btn-secondary').addEventListener('click', () => {
      this.hide('confirmationModal');
      if (onCancel) onCancel();
    });

    this.show('confirmationModal');
  }

  /**
   * Create confirmation modal element
   * @returns {HTMLElement} - Modal element
   */
  static createConfirmationModal() {
    const modalHtml = `
            <div class="modal fade" id="confirmationModal" tabindex="-1">
                <div class="modal-dialog modal-dialog-centered">
                    <div class="modal-content">
                        <div class="modal-header">
                            <h5 class="modal-title">Confirm Action</h5>
                            <button type="button" class="btn-close" data-bs-dismiss="modal"></button>
                        </div>
                        <div class="modal-body">
                            Are you sure you want to proceed?
                        </div>
                        <div class="modal-footer">
                            <button type="button" class="btn btn-secondary" data-bs-dismiss="modal">Cancel</button>
                            <button type="button" class="btn btn-danger">Confirm</button>
                        </div>
                    </div>
                </div>
            </div>
        `;

    const template = document.createElement('template');
    template.innerHTML = modalHtml.trim();
    return template.content.firstChild;
  }
}
