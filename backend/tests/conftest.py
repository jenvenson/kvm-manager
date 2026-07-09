"""Shared test setup.

Two things must happen before any `app.*` module is imported:

1. The auth-related environment variables must be present, because `app.auth`
   reads them at import time and `app.main` calls `ensure_configured()` at
   import time.
2. A fake `libvirt` module must be registered in `sys.modules`, because
   `app.services.libvirt_svc` does `import libvirt` at module top level and the
   real bindings are a host-only system dependency that isn't installed in CI.

pytest imports this conftest before collecting the test modules, so doing the
setup at module scope here guarantees it runs first.
"""
import os
import sys
import tempfile
import types

# Keep the event-log middleware's data dir writable and out of the repo.
os.environ.setdefault("DATA_DIR", tempfile.mkdtemp(prefix="kvm-test-data-"))

os.environ.setdefault("KVM_ADMIN_USER", "admin")
os.environ.setdefault("KVM_ADMIN_PASSWORD", "test-password")
os.environ.setdefault("KVM_AUTH_SECRET", "fixed-secret-for-tests")
os.environ.setdefault("KVM_TOKEN_TTL_HOURS", "168")


class _FakeConn:
    """Minimal libvirt connection used by the happy-path tests."""

    def listAllDomains(self):
        return []

    def defineXML(self, xml):
        return None

    def close(self):
        return None


class _FakeLibvirt(types.ModuleType):
    """Stand-in for the `libvirt` C bindings.

    Provides `libvirtError`, a no-op `open()` returning `_FakeConn`, and treats
    every `VIR_*` constant as 0 so runtime flag arithmetic doesn't blow up.
    """

    libvirtError = type("libvirtError", (Exception,), {})

    def open(self, uri=None):
        return _FakeConn()

    def __getattr__(self, name):
        if name.startswith("VIR_"):
            return 0
        raise AttributeError(name)


if "libvirt" not in sys.modules:
    sys.modules["libvirt"] = _FakeLibvirt("libvirt")
