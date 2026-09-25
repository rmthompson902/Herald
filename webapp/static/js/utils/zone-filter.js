/**
 * Single-select zone filter pills - shared by the schedules and VOG pages (see
 * partials/components/zone_filter_pills.html and schedules_table.html /
 * templates/vog/list.html), so filtering behaves identically everywhere.
 *
 * Markup contract:
 * - a group of <button data-zone-pill="all|<zone name>|unassigned"> siblings
 * - a `table.sortable-table` somewhere after it on the page, whose real data rows are
 *   <tr class="sortable-row" data-zones="Zone 1,Zone 2"> (empty string for unassigned)
 * - a <tr class="zone-empty-row d-none"> in the same tbody, shown when a filter leaves
 *   zero rows visible
 *
 * Filter state lives only in the pills' own `active` class, never persisted (no
 * localStorage/query param) - a page refresh always resets to "All", matching
 * sortable-tables.js's own no-persistence convention. This only ever hides/shows rows,
 * never reorders them, so it doesn't interact with sortable-tables.js's own sort.
 */
function applyZoneFilter(table, zone) {
  const rows = table.querySelectorAll('tbody tr.sortable-row');
  let visibleCount = 0;

  rows.forEach((row) => {
    const rowZones = row.dataset.zones ? row.dataset.zones.split(',') : [];
    const matches =
      zone === 'all' || (zone === 'unassigned' ? rowZones.length === 0 : rowZones.includes(zone));
    row.classList.toggle('d-none', !matches);
    if (matches) visibleCount += 1;
  });

  const emptyRow = table.querySelector('tbody tr.zone-empty-row');
  if (emptyRow) emptyRow.classList.toggle('d-none', visibleCount !== 0);
}

function initZoneFilterPills() {
  document.querySelectorAll('.zone-filter-pills').forEach((pillGroup) => {
    const table = pillGroup.parentElement.querySelector('table.sortable-table');
    if (!table) return;

    pillGroup.querySelectorAll('[data-zone-pill]').forEach((pill) => {
      pill.addEventListener('click', () => {
        pillGroup
          .querySelectorAll('[data-zone-pill]')
          .forEach((p) => p.classList.toggle('active', p === pill));
        applyZoneFilter(table, pill.dataset.zonePill);
      });
    });
  });
}

document.addEventListener('DOMContentLoaded', initZoneFilterPills);
