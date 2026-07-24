/**
 * Frontend Constants - consolidates magic numbers and configuration values
 */
window.AppConstants = {
    // Timing constants
    TOOLTIP_DELAY: 100, // 0.1 seconds

    // API timeouts
    DEFAULT_API_TIMEOUT: 30000, // 30 seconds

    // UI constants
    MAX_HISTORY_ENTRIES: 100,
    TOAST_AUTO_HIDE_DELAY: 5000, // 5 seconds

    // Button state durations
    BUTTON_SUCCESS_DURATION: 2000, // 2 seconds
    BUTTON_ERROR_DURATION: 3000, // 3 seconds

    // Form validation
    MIN_NAME_LENGTH: 1,
    MAX_NAME_LENGTH: 80,
    TIME_REGEX: /^([01]\d|2[0-3]):([0-5]\d)$/, // HH:MM, 24-hour

    // Schedule/VOG status constants
    SCHEDULE_STATUS: {
        ENABLED: 'enabled',
        DISABLED: 'disabled'
    },

    // QLab connection status
    CONNECTION_STATUS: {
        CONNECTED: 'connected',
        DISCONNECTED: 'disconnected'
    },

    // Alert types
    ALERT_TYPES: {
        SUCCESS: 'success',
        WARNING: 'warning',
        ERROR: 'error',
        INFO: 'info'
    },

    // CSS classes for status indicators
    STATUS_CLASSES: {
        ONLINE: 'text-success',
        OFFLINE: 'text-danger',
        WARNING: 'text-warning',
        INFO: 'text-info'
    },

    // URL patterns
    API_ENDPOINTS: {
        SCHEDULES: '/api/schedules',
        VOG_MESSAGES: '/api/vog-messages',
        CUES: '/api/cues',
        STATUS: '/api/status'
    },

    // Event names for custom events
    EVENTS: {
        SCHEDULE_ADDED: 'scheduleAdded',
        SCHEDULE_UPDATED: 'scheduleUpdated',
        SCHEDULE_REMOVED: 'scheduleRemoved',
        VOG_TRIGGERED: 'vogTriggered',
        STATUS_UPDATED: 'statusUpdated'
    },

    // Modal IDs
    MODALS: {
        CONFIRM_DELETE_SCHEDULE: 'confirmDeleteScheduleModal',
        CONFIRM_DELETE_VOG: 'confirmDeleteVogModal',
        CONFIRM_TRIGGER_VOG: 'confirmTriggerVogModal'
    },

    // Common user messages
    MESSAGES: {
        // Schedule operations
        SCHEDULE_ADDED: 'Schedule added',
        SCHEDULE_UPDATED: 'Schedule updated',
        SCHEDULE_REMOVED: 'Schedule deleted',
        SCHEDULE_TOGGLED: 'Schedule updated',
        SCHEDULE_PLAYED: 'Playing now',
        SCHEDULE_QUEUED: 'Zone busy - queued behind the current cue',
        SCHEDULES_ENABLED_ALL: 'All schedules enabled',
        SCHEDULES_DISABLED_ALL: 'All schedules disabled',
        CONFIRM_DISABLE_ALL_SCHEDULES: 'Disable every schedule? None of them will fire until re-enabled.',

        // VOG operations
        VOG_ADDED: 'VOG message added',
        VOG_UPDATED: 'VOG message updated',
        VOG_REMOVED: 'VOG message deleted',
        VOG_TRIGGERED: 'VOG message triggered',
        VOG_DISABLED_TOOLTIP: 'Enable this message before it can be triggered',
        VOG_ENABLED_TOOLTIP: 'Trigger this VOG message now',
        VOG_ENABLED_ALL: 'All VOG messages enabled',
        VOG_DISABLED_ALL: 'All VOG messages disabled',
        CONFIRM_DISABLE_ALL_VOG: 'Disable every VOG message? None of them can be triggered until re-enabled.',

        // Cue cache
        CUE_REFRESHED: 'Cue data refreshed from QLab',

        // Zone operations
        ZONE_ADDED: 'Zone added - taking effect immediately, no restart needed',
        ZONE_UPDATED: 'Zone updated - taking effect immediately, no restart needed',
        ZONE_REMOVED: 'Zone deleted',
        CONFIRM_DELETE_ZONE: 'Delete this zone? Messages routed to it will stop ducking/queueing until it (or a matching one) is re-added.',

        // Validation messages
        REQUIRED_FIELD: 'This field is required',
        INVALID_TIME_FORMAT: 'Enter a time as HH:MM (24-hour)',

        // Loading states
        LOADING: 'Loading...',
        SAVING: 'Saving...',
        DELETING: 'Deleting...',
        TRIGGERING: 'Triggering...',
        REFRESHING: 'Refreshing...',

        // Confirmation messages
        CONFIRM_DELETE_SCHEDULE: 'Delete this schedule? It will stop firing immediately.',
        CONFIRM_DELETE_VOG: 'Delete this VOG message? It can no longer be triggered.'
    }
};

// Freeze the constants object to prevent modification
Object.freeze(window.AppConstants);

// Export individual constant groups for easier access
window.SCHEDULE_STATUS = window.AppConstants.SCHEDULE_STATUS;
window.CONNECTION_STATUS = window.AppConstants.CONNECTION_STATUS;
window.ALERT_TYPES = window.AppConstants.ALERT_TYPES;
