from __future__ import annotations


def test_partial_sort_prefs_keep_the_other_field(client):
    # The client sends only the field that changed, so a stale tab can't undo another tab's choice.
    r = client.patch("/api/me/prefs", json={"sort": {"key": "modified"}})
    assert r.status_code == 200, r.text
    assert r.json()["prefs"]["sort"] == {"key": "modified", "dir": "asc"}

    r = client.patch("/api/me/prefs", json={"sort": {"dir": "desc"}})
    assert r.status_code == 200, r.text
    assert r.json()["prefs"]["sort"] == {"key": "modified", "dir": "desc"}

    r = client.patch("/api/me/prefs", json={"reader": {"layout": "double"}})
    assert r.json()["prefs"]["reader"] == {"layout": "double", "cover_alone": False}
    r = client.patch("/api/me/prefs", json={"reader": {"cover_alone": True}})
    assert r.json()["prefs"]["reader"] == {"layout": "double", "cover_alone": True}


def test_invalid_sort_prefs_are_rejected(client):
    assert client.patch("/api/me/prefs", json={"sort": {"key": "size"}}).status_code in (400, 422)
