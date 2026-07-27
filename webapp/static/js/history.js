/**
 * Event Log accordion on the Settings page (formerly its own /history page) -
 * polls for new log lines periodically so it stays current without a manual
 * reload, plus a "Refresh Log Entries" button (in the page header, in place
 * of the global "Refresh Cue Data" button, which doesn't apply here) for an
 * immediate check. Reads the same events-YYYY-MM-DD.log file the page renders
 * server-side on first load (see app/log_reader.py) - GET /api/history/entries
 * is a plain re-read of that file, not a proxy to Node-RED.
 */
const HISTORY_AUTO_REFRESH_MS = 5000;

function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

function renderHistoryEntries(entries) {
  const container = document.getElementById('historyLogContainer');
  if (!container) return;

  if (!entries || entries.length === 0) {
    container.innerHTML = `
            <div class="empty-state">
                <div class="empty-state-icon"><i class="fas fa-list"></i></div>
                <h3>No events logged yet</h3>
                <p class="mb-4">Fired, queued, and VOG events will show up here once the scheduling engine is logging.</p>
            </div>
        `;
    return;
  }

  const rows = entries
    .map((line) => {
      const lower = line.toLowerCase();
      const cls = lower.includes('vog')
        ? ' text-vog'
        : lower.includes('error')
          ? ' text-danger'
          : '';
      return `<div class="log-entry${cls}">${escapeHtml(line)}</div>`;
    })
    .join('');

  container.innerHTML = `<div class="card"><div class="card-body">${rows}</div></div>`;
}

async function refreshHistoryEntries() {
  const result = await HistoryAPI.getRecentEntries();
  if (result && result.status === 'success') {
    renderHistoryEntries(result.entries);
  }
  return result;
}

document.addEventListener('DOMContentLoaded', () => {
  const button = document.getElementById('refreshLogBtn');
  if (button) {
    button.addEventListener('click', () => {
      ButtonStateManager.handleAsync(button, refreshHistoryEntries, {
        loadingText: 'Refreshing...',
        successText: 'Refreshed'
      });
    });
  }

  setInterval(() => {
    refreshHistoryEntries().catch((error) =>
      console.error('Failed to auto-refresh event history:', error)
    );
  }, HISTORY_AUTO_REFRESH_MS);
});
