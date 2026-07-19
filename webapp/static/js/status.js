/**
 * Connection status page - listens for the health_update push emitted by
 * app/main.py's background poller and swaps the status badges live,
 * without a page reload (see docs/claude-plan.md's real-time push section).
 */
document.addEventListener('DOMContentLoaded', () => {
    socket.on('health_update', (health) => {
        const badgesContainer = document.getElementById('statusBadges');
        const unreachableAlert = document.getElementById('nodeRedUnreachableAlert');

        if (health.status === 'error') {
            if (badgesContainer) badgesContainer.innerHTML = '';
            if (!unreachableAlert) {
                window.location.reload();
            }
            return;
        }

        if (unreachableAlert) {
            window.location.reload();
            return;
        }

        if (badgesContainer) {
            const connected = health.state === 'connected';
            badgesContainer.innerHTML = `
                <span class="badge ${connected ? 'bg-success' : 'bg-danger'}">
                    <i class="fas fa-${connected ? 'plug' : 'times-circle'} me-1"></i>
                    ${connected ? 'QLab Connected' : 'QLab Disconnected'}
                </span>
                <span class="badge ${health.armed ? 'bg-success' : 'bg-warning text-dark'}">
                    <i class="fas fa-${health.armed ? 'shield-alt' : 'exclamation-triangle'} me-1"></i>
                    ${health.armed ? 'Scheduler Armed' : 'Scheduler Disarmed'}
                </span>
            `;
        }
    });
});
