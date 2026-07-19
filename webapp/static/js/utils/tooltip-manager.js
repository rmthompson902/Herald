/**
 * Tooltip Manager Utility
 * Manages Bootstrap tooltips with consistent behavior
 */
class TooltipManager {
    /**
     * Initialize tooltips for specified elements
     * @param {string} selector - CSS selector for tooltip elements
     * @param {Object} options - Bootstrap tooltip options
     */
    static initialize(selector = '[data-bs-toggle="tooltip"]', options = {}) {
        this.cleanup();

        const defaultOptions = {
            trigger: 'hover focus',
            boundary: 'window',
            delay: { show: 50, hide: 100 },
            placement: 'top',
            ...options
        };

        const elements = document.querySelectorAll(selector);
        elements.forEach(element => {
            const existingTooltip = bootstrap.Tooltip.getInstance(element);
            if (existingTooltip) {
                existingTooltip.dispose();
            }

            new bootstrap.Tooltip(element, defaultOptions);
        });

        console.log(`Initialized ${elements.length} tooltips`);
    }

    /**
     * Clean up all existing tooltips
     */
    static cleanup() {
        document.querySelectorAll('.tooltip').forEach(tooltip => {
            tooltip.remove();
        });

        document.querySelectorAll('[data-bs-toggle="tooltip"]').forEach(element => {
            const tooltip = bootstrap.Tooltip.getInstance(element);
            if (tooltip) {
                tooltip.dispose();
            }
        });
    }

    /**
     * Refresh tooltips (cleanup and reinitialize)
     * @param {string} selector - CSS selector for tooltip elements
     * @param {Object} options - Bootstrap tooltip options
     */
    static refresh(selector = '[data-bs-toggle="tooltip"]', options = {}) {
        this.initialize(selector, options);
    }

    /**
     * Show tooltip for specific element
     * @param {string|HTMLElement} element - Element or selector
     */
    static show(element) {
        const targetElement = typeof element === 'string' ? document.querySelector(element) : element;
        if (!targetElement) return;

        const tooltip = bootstrap.Tooltip.getInstance(targetElement);
        if (tooltip) {
            tooltip.show();
        }
    }

    /**
     * Hide tooltip for specific element
     * @param {string|HTMLElement} element - Element or selector
     */
    static hide(element) {
        const targetElement = typeof element === 'string' ? document.querySelector(element) : element;
        if (!targetElement) return;

        const tooltip = bootstrap.Tooltip.getInstance(targetElement);
        if (tooltip) {
            tooltip.hide();
        }
    }

    /**
     * Update tooltip content
     * @param {string|HTMLElement} element - Element or selector
     * @param {string} newContent - New tooltip content
     */
    static updateContent(element, newContent) {
        const targetElement = typeof element === 'string' ? document.querySelector(element) : element;
        if (!targetElement) return;

        const tooltip = bootstrap.Tooltip.getInstance(targetElement);
        if (tooltip) {
            targetElement.setAttribute('data-bs-original-title', newContent);

            tooltip.dispose();
            new bootstrap.Tooltip(targetElement);
        }
    }

    /**
     * Enable tooltip for specific element
     * @param {string|HTMLElement} element - Element or selector
     */
    static enable(element) {
        const targetElement = typeof element === 'string' ? document.querySelector(element) : element;
        if (!targetElement) return;

        const tooltip = bootstrap.Tooltip.getInstance(targetElement);
        if (tooltip) {
            tooltip.enable();
        }
    }

    /**
     * Disable tooltip for specific element
     * @param {string|HTMLElement} element - Element or selector
     */
    static disable(element) {
        const targetElement = typeof element === 'string' ? document.querySelector(element) : element;
        if (!targetElement) return;

        const tooltip = bootstrap.Tooltip.getInstance(targetElement);
        if (tooltip) {
            tooltip.disable();
        }
    }

    /**
     * Initialize tooltips after dynamic content is added
     * @param {HTMLElement} container - Container element
     */
    static initializeForContainer(container) {
        if (!container) return;

        const tooltipElements = container.querySelectorAll('[data-bs-toggle="tooltip"]');
        tooltipElements.forEach(element => {
            const existingTooltip = bootstrap.Tooltip.getInstance(element);
            if (existingTooltip) {
                existingTooltip.dispose();
            }

            new bootstrap.Tooltip(element, {
                trigger: 'hover focus',
                boundary: 'window',
                delay: { show: 50, hide: 100 }
            });
        });
    }

    /**
     * Auto-initialize tooltips when DOM is ready
     */
    static autoInitialize() {
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', () => {
                this.initialize();
            });
        } else {
            this.initialize();
        }
    }
}

TooltipManager.autoInitialize();
