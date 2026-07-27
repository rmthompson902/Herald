/**
 * Shared user-facing strings - toast bodies, confirmation prompts, and button
 * loading labels - so the same wording is reused across pages instead of being
 * retyped inline. Frozen so a page can't accidentally mutate a shared message.
 * Only MESSAGES is consumed; earlier config/status/event-name maps were unused
 * and removed.
 */
window.AppConstants = {
  MESSAGES: {
    // Schedule operations
    SCHEDULE_ADDED: 'Schedule added',
    SCHEDULE_REMOVED: 'Schedule deleted',
    SCHEDULE_TOGGLED: 'Schedule updated',
    SCHEDULE_PLAYED: 'Playing now',
    SCHEDULE_QUEUED: 'Zone busy - queued behind the current cue',
    SCHEDULES_ENABLED_ALL: 'All schedules enabled',
    SCHEDULES_DISABLED_ALL: 'All schedules disabled',
    CONFIRM_DISABLE_ALL_SCHEDULES:
      'Disable every schedule? None of them will fire until re-enabled.',

    // VOG operations
    VOG_ADDED: 'VOG message added',
    VOG_REMOVED: 'VOG message deleted',
    VOG_TRIGGERED: 'VOG message triggered',
    VOG_ENABLED_ALL: 'All VOG messages enabled',
    VOG_DISABLED_ALL: 'All VOG messages disabled',
    CONFIRM_DISABLE_ALL_VOG:
      'Disable every VOG message? None of them can be triggered until re-enabled.',

    // Cue cache
    CUE_REFRESHED: 'Cue data refreshed from QLab',

    // Zone operations
    ZONE_ADDED: 'Zone added - taking effect immediately, no restart needed',
    ZONE_UPDATED: 'Zone updated - taking effect immediately, no restart needed',
    ZONE_REMOVED: 'Zone deleted',
    CONFIRM_DELETE_ZONE:
      'Delete this zone? Messages routed to it will stop ducking/queueing until it (or a matching one) is re-added.',

    // Loading states
    LOADING: 'Loading...',
    SAVING: 'Saving...',
    TRIGGERING: 'Triggering...',
    REFRESHING: 'Refreshing...',

    // Confirmation messages
    CONFIRM_DELETE_SCHEDULE: 'Delete this schedule? It will stop firing immediately.',
    CONFIRM_DELETE_VOG: 'Delete this VOG message? It can no longer be triggered.'
  }
};

Object.freeze(window.AppConstants);
