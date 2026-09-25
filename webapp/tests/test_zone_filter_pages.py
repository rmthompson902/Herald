"""Schedules/VOG pages render as a single flat, zone-pill-filterable table (see
pages.py's _render_schedules_list/_render_vog_list) rather than one table per zone."""

from fastapi.testclient import TestClient

from app.main import app

client = TestClient(app)


def test_schedules_page_renders_flat_table(seeded_db):
    resp = client.get("/schedules")
    assert resp.status_code == 200
    html = resp.text
    assert html.count('class="table table-hover align-middle mb-0 sortable-table"') == 1
    assert 'data-zone-pill="all"' in html
    assert 'data-zone-pill="Zone 1 Boardwalk"' in html
    assert 'data-default-sort-key="timing"' in html
    # seeded cue_cache zone "Zone 1" doesn't match any real configured zone name
    # ("Zone 1 Boardwalk" etc, from config/audio-patch-map.json) - unassigned pathway
    assert 'data-zones=""' in html
    assert 'data-zone-pill="unassigned"' in html
    assert "Unassigned" in html


def test_vog_page_renders_flat_table_with_zones(seeded_db):
    resp = client.get("/vog")
    assert resp.status_code == 200
    html = resp.text
    assert 'data-zone-pill="all"' in html
    assert "sortable-row" in html
