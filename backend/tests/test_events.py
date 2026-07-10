"""Tests for events.py: rotation, read lock, and pagination correctness."""
import threading
from unittest.mock import patch, MagicMock

import pytest

from app.middleware import events


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------

class _FakeRequest:
    def __init__(self, path="/api/vms/myvm/start", method="POST"):
        self.url = MagicMock()
        self.url.path = path
        self.method = method


def _write_event(events_file: str, count: int = 1, path="/api/vms/vm1/start"):
    req = _FakeRequest(path=path)
    for _ in range(count):
        with patch.object(events, "_EVENTS_FILE", events_file):
            events._append_event(req, 200)


# ---------------------------------------------------------------------------
# Baseline: read_events returns correct data
# ---------------------------------------------------------------------------

def test_read_events_returns_empty_when_no_file(tmp_path):
    missing = str(tmp_path / "none.jsonl")
    with patch.object(events, "_EVENTS_FILE", missing):
        result = events.read_events()
    assert result["total"] == 0
    assert result["items"] == []


def test_read_events_returns_newest_first(tmp_path):
    f = str(tmp_path / "ev.jsonl")
    _write_event(f, 3, path="/api/vms/a/start")
    with patch.object(events, "_EVENTS_FILE", f):
        result = events.read_events(page=1, page_size=10)
    assert result["total"] == 3
    # newest is first
    ts = [e["timestamp"] for e in result["items"]]
    assert ts == sorted(ts, reverse=True)


# ---------------------------------------------------------------------------
# Rotation: file must not grow unbounded
# ---------------------------------------------------------------------------

def test_events_file_rotates_when_exceeding_max_size(tmp_path):
    f = str(tmp_path / "ev.jsonl")
    # Each event line is ~200 bytes; set limit to 1 000 bytes → ~5 lines trigger rotation
    with patch.object(events, "_MAX_BYTES", 1_000), \
         patch.object(events, "_KEEP_LINES", 3), \
         patch.object(events, "_EVENTS_FILE", f):
        req = _FakeRequest()
        for _ in range(20):
            events._append_event(req, 200)
    with open(f) as fh:
        lines = [l for l in fh.readlines() if l.strip()]
    assert len(lines) <= 10, f"expected rotation to cap lines, got {len(lines)}"


def test_events_rotation_keeps_newest_lines(tmp_path):
    f = str(tmp_path / "ev.jsonl")
    import json
    with patch.object(events, "_MAX_BYTES", 500), \
         patch.object(events, "_KEEP_LINES", 2), \
         patch.object(events, "_EVENTS_FILE", f):
        for i in range(10):
            req = _FakeRequest(path=f"/api/vms/vm{i}/start")
            events._append_event(req, 200)
    with open(f) as fh:
        lines = [l for l in fh.readlines() if l.strip()]
    paths = [json.loads(l)["path"] for l in lines]
    # After rotation the newest vm paths should survive (vm8 or vm9 present)
    assert any("vm8" in p or "vm9" in p for p in paths)


# ---------------------------------------------------------------------------
# Read lock: read_events must hold _lock while reading
# ---------------------------------------------------------------------------

def test_read_events_acquires_lock(tmp_path):
    f = str(tmp_path / "ev.jsonl")
    lock_entered = []
    real_lock = events._lock

    class _TrackedLock:
        def __enter__(self):
            lock_entered.append(True)
            return real_lock.__enter__()

        def __exit__(self, *a):
            return real_lock.__exit__(*a)

    with patch.object(events, "_EVENTS_FILE", f), \
         patch.object(events, "_lock", _TrackedLock()):
        events.read_events()

    assert lock_entered, "read_events must acquire _lock before reading"
