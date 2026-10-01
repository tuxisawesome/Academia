from __future__ import annotations

from conftest import PASSWORD, login


def test_admin_cannot_reset_own_password(client, anon):
    """A self-reset would revoke the admin's own session before the temporary password is shown."""
    me = client.get("/api/auth/me").json()
    r = client.patch(f"/api/admin/users/{me['id']}", json={"reset_password": True})
    assert r.status_code == 400
    assert r.json()["error"]["code"] == "self_change"
    assert client.get("/api/admin/users").status_code == 200  # still signed in
    login(anon, me["username"], PASSWORD)  # old password still works
    assert client.get("/api/auth/me").json()["must_change_password"] is False
