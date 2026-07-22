/**
 * Click-to-sort table columns - shared by every page with a sortable table
 * (schedules' per-zone tables, the VOG messages table), so sorting behaves
 * identically everywhere rather than each page re-implementing its own copy.
 *
 * Markup contract (see partials/components/schedules_table.html and
 * templates/vog/list.html):
 * - <table class="sortable-table" data-default-sort-key="..." data-default-sort-type="...">
 * - <th class="sortable-column" data-sort-key="..." data-sort-type="text|number">
 * - <tr class="sortable-row"> for every real data row (never the empty-state row)
 * - optionally <td data-sort-value="..."> when the cell's own text isn't the
 *   right sort value directly (e.g. "9.3s" instead of 9.3) - falls back to
 *   the cell's own text content otherwise.
 *
 * Sort state lives only in each table's own `data-sort-key`/`data-sort-dir`
 * attributes, never persisted (no localStorage/query param) - a page refresh
 * always starts over from that table's own `data-default-sort-key`, applied
 * here the same way a real header click would be, not as a separate path.
 * No sort-direction indicator is rendered by design (see style.css's
 * .sortable-column) - clicking a header toggles asc/desc silently.
 */
function sortTableRows(table, key, type, direction) {
    const headerIndex = Array.from(table.querySelectorAll('thead th')).findIndex(
        (th) => th.dataset.sortKey === key
    );
    if (headerIndex === -1) return;

    const tbody = table.querySelector('tbody');
    const rows = Array.from(tbody.querySelectorAll('tr.sortable-row'));
    if (rows.length === 0) return;

    const factor = direction === 'desc' ? -1 : 1;

    const valueOf = (row) => {
        const cell = row.children[headerIndex];
        const raw = cell.dataset.sortValue ?? cell.textContent.trim();
        if (type === 'number') {
            const num = parseFloat(raw);
            return Number.isNaN(num) ? null : num;
        }
        return raw.toLowerCase();
    };

    rows.sort((rowA, rowB) => {
        const a = valueOf(rowA);
        const b = valueOf(rowB);
        // Missing values (e.g. duration not yet cached) always sort last,
        // regardless of direction - flipping them with the direction would
        // make "descending" look like it randomly hides/shows blanks.
        if (a === null && b === null) return 0;
        if (a === null) return 1;
        if (b === null) return -1;
        if (a < b) return -1 * factor;
        if (a > b) return 1 * factor;
        return 0;
    });

    rows.forEach((row) => tbody.appendChild(row));
}

function initSortableTables() {
    document.querySelectorAll('table.sortable-table').forEach((table) => {
        table.querySelectorAll('thead th.sortable-column').forEach((th) => {
            th.addEventListener('click', () => {
                const key = th.dataset.sortKey;
                const type = th.dataset.sortType;
                const direction = table.dataset.sortKey === key && table.dataset.sortDir === 'asc' ? 'desc' : 'asc';
                table.dataset.sortKey = key;
                table.dataset.sortDir = direction;
                sortTableRows(table, key, type, direction);
            });
        });

        sortTableRows(table, table.dataset.defaultSortKey, table.dataset.defaultSortType, 'asc');
    });
}

document.addEventListener('DOMContentLoaded', initSortableTables);
