"""Backend authentication: password login + stdlib HMAC-signed tokens.

No external deps — uses hmac/hashlib/base64/json only. Credentials and the
signing secret come from environment variables (never hardcoded).
"""
import base64
import hashlib
import hmac
import json
import logging
import os
import secrets
import time

from fastapi import Depends, HTTPException
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

logger = logging.getLogger("kvm.auth")

ADMIN_USER = os.environ.get("KVM_ADMIN_USER", "admin")
ADMIN_PASSWORD = os.environ.get("KVM_ADMIN_PASSWORD")
TOKEN_TTL_SECONDS = int(os.environ.get("KVM_TOKEN_TTL_HOURS", "168")) * 3600

_secret_env = os.environ.get("KVM_AUTH_SECRET")
if _secret_env:
    _SECRET = _secret_env.encode()
else:
    _SECRET = secrets.token_bytes(32)
    logger.warning(
        "KVM_AUTH_SECRET not set — generated a random secret. "
        "Tokens will be invalidated on restart; set KVM_AUTH_SECRET to persist sessions."
    )


def ensure_configured() -> None:
    """Fail fast at startup if the admin password is not provided."""
    if not ADMIN_PASSWORD:
        raise RuntimeError(
            "KVM_ADMIN_PASSWORD is not set. Refusing to start without an admin "
            "password — set it via environment variable."
        )


def _b64url_encode(raw: bytes) -> str:
    return base64.urlsafe_b64encode(raw).rstrip(b"=").decode("ascii")


def _b64url_decode(data: str) -> bytes:
    pad = "=" * (-len(data) % 4)
    return base64.urlsafe_b64decode(data + pad)


def _sign(payload_b64: str) -> str:
    sig = hmac.new(_SECRET, payload_b64.encode("ascii"), hashlib.sha256).digest()
    return _b64url_encode(sig)


def check_credentials(username: str, password: str) -> bool:
    if not ADMIN_PASSWORD:
        return False
    user_ok = hmac.compare_digest(username, ADMIN_USER)
    pass_ok = hmac.compare_digest(password, ADMIN_PASSWORD)
    return user_ok and pass_ok


def issue_token(user: str) -> tuple[str, int]:
    """Return (token, expires_at_unix)."""
    exp = int(time.time()) + TOKEN_TTL_SECONDS
    payload = json.dumps({"user": user, "exp": exp}, separators=(",", ":"))
    payload_b64 = _b64url_encode(payload.encode("utf-8"))
    token = f"{payload_b64}.{_sign(payload_b64)}"
    return token, exp


def verify_token(token: str) -> dict:
    """Validate signature and expiry. Raises ValueError on any failure."""
    try:
        payload_b64, sig = token.split(".", 1)
    except ValueError:
        raise ValueError("malformed token")
    if not hmac.compare_digest(sig, _sign(payload_b64)):
        raise ValueError("bad signature")
    try:
        payload = json.loads(_b64url_decode(payload_b64))
    except (ValueError, json.JSONDecodeError):
        raise ValueError("malformed payload")
    if int(payload.get("exp", 0)) < int(time.time()):
        raise ValueError("token expired")
    return payload


_bearer = HTTPBearer(auto_error=False)


def require_auth(
    creds: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> dict:
    if creds is None or creds.scheme.lower() != "bearer":
        raise HTTPException(status_code=401, detail="missing bearer token")
    try:
        return verify_token(creds.credentials)
    except ValueError:
        raise HTTPException(status_code=401, detail="invalid or expired token")
