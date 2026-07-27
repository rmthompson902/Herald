/**
 * Shared live-countdown formatting, loaded globally in base.html (see the utils script
 * list) so any page can render a countdown without hitting the API every second. Factored
 * out of schedules_list.js once queue_visualizer.js became a second consumer of
 * formatNextFire - both pages already follow the same "cache server data, tick locally"
 * pattern (see schedules_list.js's own module docstring).
 */
const TimeFormat = {
    /**
     * @param {string|null} iso - occurrence timestamp, or null if there's nothing upcoming
     * @returns {string} - e.g. "in 12s (2:34:07 PM)", or a muted dash if there's nothing next
     */
    formatNextFire(iso) {
        if (!iso) {
            return '<span class="text-muted">no more occurrences</span>';
        }

        const when = new Date(iso);
        const secondsAway = Math.round((when.getTime() - Date.now()) / 1000);
        const clockTime = when.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', second: '2-digit' });

        if (secondsAway < 60) {
            return `in ${secondsAway}s <span class="text-muted">(${clockTime})</span>`;
        }
        if (secondsAway < 3600) {
            return `in ${Math.round(secondsAway / 60)}m <span class="text-muted">(${clockTime})</span>`;
        }
        return clockTime;
    },

    /**
     * @param {number} ms - non-negative duration in milliseconds
     * @returns {string} - "M:SS", e.g. 4000 -> "0:04", 125000 -> "2:05"
     */
    formatClockTime(ms) {
        const totalSeconds = Math.max(0, Math.round(ms / 1000));
        const minutes = Math.floor(totalSeconds / 60);
        const seconds = totalSeconds % 60;
        return `${minutes}:${String(seconds).padStart(2, '0')}`;
    }
};

window.TimeFormat = TimeFormat;
