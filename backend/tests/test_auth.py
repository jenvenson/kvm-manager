"""Unit tests for the stdlib HMAC token auth in app.auth."""
import json
import time

import pytest

from app import auth


def test_check_credentials_valid():
    assert auth.check_credentials("admin", "test-password") is True


def test_check_credentials_wrong_password():
    assert auth.check_credentials("admin", "nope") is False


def test_check_credentials_wrong_user():
    assert auth.check_credentials("root", "test-password") is False


def test_issue_verify_roundtrip():
    token, exp = auth.issue_token("admin")
    payload = auth.verify_token(token)
    assert payload["user"] == "admin"
    assert payload["exp"] == exp
    assert exp > int(time.time())


def test_verify_rejects_tampered_signature():
    token, _ = auth.issue_token("admin")
    payload_b64, _sig = token.split(".", 1)
    forged = f"{payload_b64}.{'A' * 43}"
    with pytest.raises(ValueError):
        auth.verify_token(forged)


def test_verify_rejects_tampered_payload():
    # Re-sign a different payload with a wrong secret guess: swapping the
    # payload without the real secret must fail the signature check.
    token, _ = auth.issue_token("admin")
    _payload_b64, sig = token.split(".", 1)
    evil_payload = auth._b64url_encode(
        json.dumps({"user": "root", "exp": int(time.time()) + 3600}).encode()
    )
    with pytest.raises(ValueError):
        auth.verify_token(f"{evil_payload}.{sig}")


def test_verify_rejects_malformed_token():
    with pytest.raises(ValueError):
        auth.verify_token("not-a-token")


def test_verify_rejects_expired_token():
    exp = int(time.time()) - 10
    payload_b64 = auth._b64url_encode(
        json.dumps({"user": "admin", "exp": exp}, separators=(",", ":")).encode()
    )
    token = f"{payload_b64}.{auth._sign(payload_b64)}"
    with pytest.raises(ValueError):
        auth.verify_token(token)


def test_ensure_configured_raises_without_password(monkeypatch):
    monkeypatch.setattr(auth, "ADMIN_PASSWORD", None)
    with pytest.raises(RuntimeError):
        auth.ensure_configured()


def test_ensure_configured_ok_with_password():
    # Fixture env sets a password, so this must not raise.
    auth.ensure_configured()
