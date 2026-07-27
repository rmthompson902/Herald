/**
 * API Client Module
 * ================
 *
 * Centralized API communication layer for the frontend. Every method here
 * hits this app's own /api/* routes (see webapp/app/routers) - never
 * Node-RED directly. Writes and anything needing live OSC get proxied to
 * Node-RED server-side by those routes; reads that only need SQLite are
 * served directly. See Frontend Architecture in docs/claude-plan.md.
 *
 * Features:
 * - Base APIClient class with common HTTP methods (GET, POST, PUT, DELETE)
 * - ScheduleAPI, VogAPI, CueAPI, StatusAPI - domain-specific method sets
 * - Automatic JSON handling and Content-Type headers
 * - Standardized error handling with user-friendly toast messages
 */
/* exported ScheduleAPI, VogAPI, CueAPI, StatusAPI, HistoryAPI, QueueAPI, ZoneAPI */
class APIClient {
  /**
   * Make an API request
   * @param {string} url - API endpoint URL
   * @param {Object} options - Request options
   * @returns {Promise} - API response
   */
  static async request(url, options = {}) {
    const defaultOptions = {
      headers: {
        'Content-Type': 'application/json',
        ...options.headers
      }
    };

    const requestOptions = { ...defaultOptions, ...options };

    try {
      const response = await fetch(url, requestOptions);

      if (!response.ok) {
        throw new Error(`HTTP error! status: ${response.status}`);
      }

      return await response.json();
    } catch (error) {
      console.error('API request failed:', error);
      throw error;
    }
  }

  /**
   * Handle API response and show appropriate toast messages
   * @param {Promise} apiCall - The API call promise
   * @param {string} successMessage - Success message for toast
   * @param {string} errorMessage - Error message for toast
   * @returns {Promise} - API response data or null
   */
  static async handleResponse(
    apiCall,
    successMessage = 'Operation successful',
    errorMessage = 'Operation failed'
  ) {
    try {
      const data = await apiCall;

      if (data && data.status === 'success') {
        if (window.showToast) {
          window.showToast('Success', data.message || successMessage, 'success');
        }
        return data;
      } else {
        if (window.showToast) {
          window.showToast('Error', data.message || errorMessage, 'error');
        }
        return null;
      }
    } catch (error) {
      console.error('API Error:', error);
      if (window.showToast) {
        window.showToast('Error', error.message || errorMessage, 'error');
      }
      return null;
    }
  }

  /**
   * GET request
   * @param {string} url - API endpoint URL
   * @param {Object} options - Request options
   * @returns {Promise} - API response
   */
  static async get(url, options = {}) {
    return this.request(url, { method: 'GET', ...options });
  }

  /**
   * POST request
   * @param {string} url - API endpoint URL
   * @param {Object} data - Request data
   * @param {Object} options - Request options
   * @returns {Promise} - API response
   */
  static async post(url, data = {}, options = {}) {
    return this.request(url, {
      method: 'POST',
      body: JSON.stringify(data),
      ...options
    });
  }

  /**
   * PUT request
   * @param {string} url - API endpoint URL
   * @param {Object} data - Request data
   * @param {Object} options - Request options
   * @returns {Promise} - API response
   */
  static async put(url, data = {}, options = {}) {
    return this.request(url, {
      method: 'PUT',
      body: JSON.stringify(data),
      ...options
    });
  }

  /**
   * DELETE request
   * @param {string} url - API endpoint URL
   * @param {Object} options - Request options
   * @returns {Promise} - API response
   */
  static async delete(url, options = {}) {
    return this.request(url, { method: 'DELETE', ...options });
  }
}

/**
 * Schedule API operations
 */
class ScheduleAPI extends APIClient {
  /** @returns {Promise} - Schedules data */
  static async getAllSchedules() {
    return this.get('/api/schedules');
  }

  /** @returns {Promise} - { nextOccurrences: { [scheduleId]: isoString|null } }, enabled schedules only */
  static async getNextOccurrences() {
    return this.get('/api/schedules/next-occurrences');
  }

  /**
   * @param {Object} scheduleData
   * @returns {Promise} - API response
   */
  static async createSchedule(scheduleData) {
    return this.post('/api/schedules', scheduleData);
  }

  /**
   * @param {string|number} scheduleId
   * @param {Object} scheduleData
   * @returns {Promise} - API response
   */
  static async updateSchedule(scheduleId, scheduleData) {
    return this.put(`/api/schedules/${scheduleId}`, scheduleData);
  }

  /**
   * @param {string|number} scheduleId
   * @returns {Promise} - API response
   */
  static async removeSchedule(scheduleId) {
    return this.delete(`/api/schedules/${scheduleId}`);
  }

  /**
   * @param {string|number} scheduleId
   * @returns {Promise} - API response
   */
  static async toggleSchedule(scheduleId) {
    return this.post(`/api/schedules/${scheduleId}/toggle`);
  }

  /**
   * Sets every schedule's enabled flag to the same value in one call.
   * @param {boolean} enabled
   * @returns {Promise} - API response
   */
  static async bulkSetEnabled(enabled) {
    return this.post('/api/schedules/bulk-set-enabled', { enabled });
  }

  /**
   * @param {string|number} scheduleId
   * @returns {Promise} - API response
   */
  static async playNow(scheduleId) {
    return this.post(`/api/schedules/${scheduleId}/play-now`);
  }
}

/**
 * VOG (Voice of God / emergency messaging) API operations
 */
class VogAPI extends APIClient {
  /** @returns {Promise} - VOG messages data */
  static async getAllVogMessages() {
    return this.get('/api/vog-messages');
  }

  /**
   * @param {Object} vogData
   * @returns {Promise} - API response
   */
  static async createVogMessage(vogData) {
    return this.post('/api/vog-messages', vogData);
  }

  /**
   * @param {string|number} vogId
   * @param {Object} vogData
   * @returns {Promise} - API response
   */
  static async updateVogMessage(vogId, vogData) {
    return this.put(`/api/vog-messages/${vogId}`, vogData);
  }

  /**
   * @param {string|number} vogId
   * @returns {Promise} - API response
   */
  static async removeVogMessage(vogId) {
    return this.delete(`/api/vog-messages/${vogId}`);
  }

  /**
   * @param {string|number} vogId
   * @returns {Promise} - API response
   */
  static async toggleVogMessage(vogId) {
    return this.post(`/api/vog-messages/${vogId}/toggle`);
  }

  /**
   * Sets every VOG message's enabled flag to the same value in one call.
   * @param {boolean} enabled
   * @returns {Promise} - API response
   */
  static async bulkSetEnabled(enabled) {
    return this.post('/api/vog-messages/bulk-set-enabled', { enabled });
  }

  /**
   * @param {string|number} vogId
   * @returns {Promise} - API response
   */
  static async triggerVogMessage(vogId) {
    return this.post(`/api/vog-messages/${vogId}/trigger`);
  }
}

/**
 * QLab cue browsing API operations
 */
class CueAPI extends APIClient {
  /** @returns {Promise} - Live cue list from QLab */
  static async getAllCues() {
    return this.get('/api/cues');
  }

  /**
   * Re-reads every referenced cue's duration/zones live from QLab into cue_cache.
   * @returns {Promise} - API response with { refreshedCount, failed }
   */
  static async refreshAllCues() {
    return this.post('/api/cues/refresh-all');
  }
}

/**
 * Connection/scheduler status API operations
 */
class StatusAPI extends APIClient {
  /** @returns {Promise} - QLab connection + scheduler-armed state */
  static async getStatus() {
    return this.get('/api/status');
  }
}

/**
 * Event history API operations
 */
class HistoryAPI extends APIClient {
  /** @returns {Promise} - { entries: string[] }, most recent 200 lines, newest first */
  static async getRecentEntries() {
    return this.get('/api/history/entries');
  }
}

/**
 * Zone queue visualizer API operations (/queues) - live occupancy/queued snapshot plus
 * paginated future occurrences per zone. The page's live updates arrive over SocketIO
 * (queue_state_update/queue_event, see queue_visualizer.js) - these two calls only serve
 * the initial page load and each zone's infinite-scroll "load next batch" requests.
 */
class QueueAPI extends APIClient {
  /** @returns {Promise} - { status, occupancy: {[zone]: {...}}, queued: {[zone]: [...]} } */
  static async getState() {
    return this.get('/api/queue/state');
  }

  /**
   * @param {string} zone
   * @param {number} [offset]
   * @param {number} [count]
   * @returns {Promise} - { status, zone, occurrences: [...], hasMore }
   */
  static async getUpcoming(zone, offset = 0, count = 25) {
    return this.get(
      `/api/queue/upcoming?zone=${encodeURIComponent(zone)}&offset=${offset}&count=${count}`
    );
  }
}

/**
 * Zones admin API operations - config/audio-patch-map.json, the one manual zone config in
 * the system (see lib/zones/audioPatchMap.js). Every write here takes effect immediately in
 * Node-RED (hot-reload) - no restart needed.
 */
class ZoneAPI extends APIClient {
  /** @returns {Promise} - { zones: [{ zoneName, messagingPatchId, duckCueNumber, unduckCueNumber }] } */
  static async getAllZones() {
    return this.get('/api/zones');
  }

  /** @returns {Promise} - { patches: [{ patchId, name }] }, live from QLab's own patch list */
  static async getPatches() {
    return this.get('/api/zones/patches');
  }

  /**
   * Live patch lookup for a reference cue number, plus a naming-convention-based
   * suggestion (zoneName/duckCueNumber/unduckCueNumber) when the cue number matches the
   * venue's "{zone}1{id}" convention - fields are simply omitted when it doesn't match, not
   * an error.
   * @param {string} cueNumber
   * @returns {Promise} - { patchId, zoneName?, duckCueNumber?, unduckCueNumber? }
   */
  static async discover(cueNumber) {
    return this.get(`/api/zones/discover?cueNumber=${encodeURIComponent(cueNumber)}`);
  }

  /**
   * @param {Object} zoneData - { zone_name, messaging_patch_id, duck_cue_number, unduck_cue_number }
   * @returns {Promise} - API response
   */
  static async createZone(zoneData) {
    return this.post('/api/zones', zoneData);
  }

  /**
   * @param {string} zoneName
   * @param {Object} zoneData - { messaging_patch_id, duck_cue_number, unduck_cue_number }
   * @returns {Promise} - API response
   */
  static async updateZone(zoneName, zoneData) {
    return this.put(`/api/zones/${encodeURIComponent(zoneName)}`, zoneData);
  }

  /**
   * @param {string} zoneName
   * @returns {Promise} - API response
   */
  static async removeZone(zoneName) {
    return this.delete(`/api/zones/${encodeURIComponent(zoneName)}`);
  }
}
