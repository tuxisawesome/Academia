from __future__ import annotations

from pathlib import Path

from conftest import ORIGIN, PASSWORD, add_user, login, new_notebook


def test_health(anon):
    r = anon.get("/api/health")
    assert r.status_code == 200
    assert r.json()["db"] is True
    assert r.headers["X-App-Version"] == "dev"


def test_login_logout(anon):
    add_user("carol")
    r = anon.post("/api/auth/login", json={"username": "CAROL", "password": PASSWORD})
    assert r.status_code == 200
    assert r.json()["username"] == "carol"
    assert anon.get("/api/auth/me").status_code == 200
    assert anon.post("/api/auth/logout").status_code == 200
    assert anon.get("/api/auth/me").status_code == 401


def test_wrong_password_and_rate_limit(anon):
    add_user("dave")
    for _ in range(8):
        r = anon.post("/api/auth/login", json={"username": "dave", "password": "nope-nope-nope"})
        assert r.status_code == 401
        assert r.json()["error"]["code"] == "invalid_credentials"
    r = anon.post("/api/auth/login", json={"username": "dave", "password": PASSWORD})
    assert r.status_code == 429


def test_unknown_user(anon):
    r = anon.post("/api/auth/login", json={"username": "nobody", "password": "whatever-123"})
    assert r.status_code == 401


def test_requires_login(anon):
    assert anon.get("/api/nodes").status_code == 401
    assert anon.get("/api/tree").status_code == 401


def test_origin_check(client):
    r = client.post("/api/folders", json={"name": "x"}, headers={"Origin": "https://evil.example"})
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "bad_origin"
    r = client.post("/api/folders", json={"name": "x"}, headers={"Origin": ORIGIN})
    assert r.status_code == 200


def test_must_change_password(anon):
    add_user("erin", must_change=True)
    me = login(anon, "erin")
    assert me["must_change_password"] is True
    r = anon.get("/api/nodes")
    assert r.status_code == 403
    assert r.json()["error"]["code"] == "password_change_required"
    r = anon.post("/api/auth/password", json={"current_password": PASSWORD, "new_password": "short"})
    assert r.status_code == 400
    r = anon.post("/api/auth/password", json={"current_password": PASSWORD, "new_password": "a much better password"})
    assert r.status_code == 200
    assert r.json()["must_change_password"] is False
    assert anon.get("/api/nodes").status_code == 200


def test_prefs(client):
    r = client.patch("/api/me/prefs", json={"theme": "dark", "reader": {"cover_alone": True}})
    assert r.status_code == 200
    prefs = r.json()["prefs"]
    assert prefs["theme"] == "dark"
    assert prefs["reader"] == {"layout": "auto", "cover_alone": True}
    assert prefs["view"] == "grid"


def test_admin_user_management(client, anon):
    r = client.post("/api/admin/users", json={"username": "frank", "display_name": "Frank"})
    assert r.status_code == 200, r.text
    temp = r.json()["temporary_password"]
    uid = r.json()["user"]["id"]
    assert temp
    me = login(anon, "frank", temp)
    assert me["must_change_password"] is True

    r = client.post("/api/admin/users", json={"username": "FRANK"})
    assert r.status_code == 409

    r = client.patch(f"/api/admin/users/{uid}", json={"disabled": True})
    assert r.status_code == 200
    assert anon.get("/api/auth/me").status_code == 401  # sessions revoked

    r = client.patch(f"/api/admin/users/{uid}", json={"disabled": False, "reset_password": True})
    new_temp = r.json()["temporary_password"]
    assert new_temp and new_temp != temp
    login(anon, "frank", new_temp)

    users = client.get("/api/admin/users").json()
    assert {u["username"] for u in users} == {"alice", "frank"}

    assert client.delete(f"/api/admin/users/{uid}").status_code == 200
    assert anon.get("/api/auth/me").status_code == 401


def test_admin_guards(client):
    me = client.get("/api/auth/me").json()
    r = client.patch(f"/api/admin/users/{me['id']}", json={"disabled": True})
    assert r.status_code == 400
    assert client.delete(f"/api/admin/users/{me['id']}").status_code == 400


def test_non_admin_forbidden(other_client):
    assert other_client.get("/api/admin/users").status_code == 403


def test_isolation_between_users(client, other_client, tmp_path: Path):
    folder = client.post("/api/folders", json={"name": "Private"}).json()
    nb = new_notebook(client, tmp_path, pages=3)
    bm = client.post(
        "/api/bookmarks", json={"name": "B", "notebook_id": nb["id"], "page_ids": [nb["pages"][0]["id"]]}
    ).json()
    page = nb["pages"][0]
    for url in (
        f"/api/nodes?parent={folder['id']}",
        f"/api/nodes/{nb['id']}",
        f"/api/notebooks/{nb['id']}",
        f"/api/notebooks/{nb['id']}/pdf",
        f"/api/bookmarks/{bm['id']}",
        f"/api/bookmarks/{bm['id']}/pdf",
        f"/api/thumbs/{page['source_id']}/0",
        f"/api/progress/{nb['id']}",
    ):
        assert other_client.get(url).status_code == 404, url
    for method, url, body in (
        ("patch", f"/api/nodes/{folder['id']}", {"name": "mine"}),
        ("post", "/api/nodes/move", {"ids": [nb["id"]], "target_id": None}),
        ("post", "/api/nodes/trash", {"ids": [folder["id"]]}),
        ("post", "/api/nodes/copy", {"ids": [nb["id"]]}),
        ("post", f"/api/notebooks/{nb['id']}/pages/delete", {"page_ids": [page["id"]]}),
        ("put", f"/api/bookmarks/{bm['id']}/pages", {"page_ids": []}),
        ("post", "/api/notebooks", {"name": "x", "source_id": page["source_id"]}),
        ("post", "/api/folders", {"name": "x", "parent_id": folder["id"]}),
    ):
        r = getattr(other_client, method)(url, json=body)
        assert r.status_code == 404, (url, r.status_code, r.text)
    assert other_client.get("/api/nodes").json()["items"] == []
