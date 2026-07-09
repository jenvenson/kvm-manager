import json
import os
import asyncio
import threading
from datetime import datetime, timezone
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

WRITE_METHODS = {"POST", "PUT", "DELETE", "PATCH"}

_DATA_DIR = os.environ.get("DATA_DIR", "/app/data")
os.makedirs(_DATA_DIR, exist_ok=True)
_EVENTS_FILE = os.path.join(_DATA_DIR, "events.jsonl")
_lock = threading.Lock()


class EventLogMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        if request.method in WRITE_METHODS and request.url.path.startswith("/api/"):
            loop = asyncio.get_event_loop()
            await loop.run_in_executor(None, _append_event, request, response.status_code)
        return response


def _append_event(request: Request, status_code: int):
    path = request.url.path
    parts = [p for p in path.strip("/").split("/") if p]
    vm_name = parts[2] if len(parts) >= 3 and parts[1] == "vms" else ""
    action = "/".join(parts[3:]) if len(parts) >= 4 else (parts[-1] if parts else "")
    event = {
        "timestamp": datetime.now(timezone.utc).isoformat(),
        "method": request.method,
        "path": path,
        "vm_name": vm_name,
        "action": action,
        "status_code": status_code,
        "success": status_code < 400,
    }
    line = json.dumps(event, ensure_ascii=False) + "\n"
    with _lock:
        with open(_EVENTS_FILE, "a") as f:
            f.write(line)


def read_events(page: int = 1, page_size: int = 50, vm_name: str = "") -> dict:
    try:
        with open(_EVENTS_FILE) as f:
            lines = [l for l in f.readlines() if l.strip()]
    except FileNotFoundError:
        lines = []
    events = []
    for l in reversed(lines):
        try:
            events.append(json.loads(l))
        except json.JSONDecodeError:
            continue
    if vm_name:
        events = [e for e in events if e.get("vm_name") == vm_name]
    total = len(events)
    start = (page - 1) * page_size
    return {
        "total": total,
        "page": page,
        "page_size": page_size,
        "items": events[start : start + page_size],
    }
