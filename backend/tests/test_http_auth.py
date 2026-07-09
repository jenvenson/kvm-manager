"""HTTP-level tests: login endpoint and that /api/* is gated by a bearer token."""
import pytest
from fastapi.testclient import TestClient

from app.main import app


@pytest.fixture()
def client():
    return TestClient(app)


def _login(client) -> str:
    resp = client.post(
        "/api/login", json={"username": "admin", "password": "test-password"}
    )
    assert resp.status_code == 200
    return resp.json()["token"]


def test_login_success(client):
    resp = client.post(
        "/api/login", json={"username": "admin", "password": "test-password"}
    )
    assert resp.status_code == 200
    body = resp.json()
    assert body["token"]
    assert body["expires_at"] > 0


def test_login_bad_credentials(client):
    resp = client.post(
        "/api/login", json={"username": "admin", "password": "wrong"}
    )
    assert resp.status_code == 401


def test_protected_endpoint_requires_token(client):
    resp = client.get("/api/vms")
    assert resp.status_code == 401


def test_protected_endpoint_rejects_bad_token(client):
    resp = client.get("/api/vms", headers={"Authorization": "Bearer garbage"})
    assert resp.status_code == 401


def test_protected_endpoint_accepts_valid_token(client):
    token = _login(client)
    resp = client.get("/api/vms", headers={"Authorization": f"Bearer {token}"})
    # Fake libvirt returns no domains -> auth passed, handler ran.
    assert resp.status_code == 200
    assert resp.json() == []
