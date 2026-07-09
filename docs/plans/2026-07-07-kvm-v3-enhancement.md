# KVM Platform v3 Enhancement Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Redesign the KVM management platform with a dark cyberpunk visual theme and add monitoring, network management, templates, backups, event logging, and VM protection features.

**Architecture:** Backend gains 6 new route modules (stats, networks, templates, backups, events, config) and a logging middleware; all persistent data lives in `/app/data/` volume. Frontend switches to Ant Design dark algorithm with full custom CSS cyberpunk theming, adds a sidebar navigation, and gains 5 new pages/panels built with recharts.

**Tech Stack:** FastAPI + libvirt-python (backend), React 18 + TypeScript + Ant Design 5 dark + recharts (frontend), Docker Compose with new `/app/data` volume.

**Key constraints:**
- No git in this repo — skip all git steps
- `libvirt-sock` (not `libvirt.sock`) is the correct socket path on this host
- Frontend base path is `/kvm/`, axios baseURL is `/kvm/api`
- All new backend data persists to `/app/data/` (mounted as Docker volume)
- No tests required — verify by running the service and checking responses

---

## Task 1: Backend — Event logging middleware + API

**Files:**
- Create: `backend/app/middleware/__init__.py`
- Create: `backend/app/middleware/events.py`
- Create: `backend/app/api/events.py`

**Step 1: Create middleware package**

```bash
mkdir -p backend/app/middleware
touch backend/app/middleware/__init__.py
```

**Step 2: Create `backend/app/middleware/events.py`**

```python
import json
import os
from datetime import datetime
from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request

WRITE_METHODS = {"POST", "PUT", "DELETE", "PATCH"}


class EventLogMiddleware(BaseHTTPMiddleware):
    async def dispatch(self, request: Request, call_next):
        response = await call_next(request)
        if request.method in WRITE_METHODS and request.url.path.startswith("/api/"):
            _append_event(request, response.status_code)
        return response


def _append_event(request: Request, status_code: int):
    path = request.url.path
    parts = [p for p in path.strip("/").split("/") if p]
    vm_name = parts[2] if len(parts) >= 3 and parts[1] == "vms" else ""
    action = "/".join(parts[3:]) if len(parts) >= 4 else (parts[-1] if parts else "")
    data_dir = os.environ.get("DATA_DIR", "/app/data")
    os.makedirs(data_dir, exist_ok=True)
    event = {
        "timestamp": datetime.now().isoformat(),
        "method": request.method,
        "path": path,
        "vm_name": vm_name,
        "action": action,
        "status_code": status_code,
        "success": status_code < 400,
    }
    with open(os.path.join(data_dir, "events.jsonl"), "a") as f:
        f.write(json.dumps(event, ensure_ascii=False) + "\n")


def read_events(page: int = 1, page_size: int = 50, vm_name: str = "") -> dict:
    data_dir = os.environ.get("DATA_DIR", "/app/data")
    events_file = os.path.join(data_dir, "events.jsonl")
    try:
        with open(events_file) as f:
            lines = [l for l in f.readlines() if l.strip()]
    except FileNotFoundError:
        lines = []
    events = [json.loads(l) for l in reversed(lines)]
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
```

**Step 3: Create `backend/app/api/events.py`**

```python
from fastapi import APIRouter
from app.middleware.events import read_events

router = APIRouter(tags=["events"])


@router.get("/events")
def get_events(page: int = 1, page_size: int = 50, vm_name: str = ""):
    return read_events(page=page, page_size=page_size, vm_name=vm_name)
```

**Step 4: Verify**

After wiring into main.py (Task 7), test with:
```bash
curl http://localhost:18000/api/events
# Should return: {"total": 0, "page": 1, "page_size": 50, "items": []}
```

---

## Task 2: Backend — VM stats API

**Files:**
- Create: `backend/app/api/stats.py`
- Modify: `backend/app/services/libvirt_svc.py` (append new function)

**Step 1: Add `get_vm_stats` to `backend/app/services/libvirt_svc.py`**

Add these imports at the top of the file (after existing imports):
```python
import time
import json as _json_mod
```

Append to the end of `libvirt_svc.py`:

```python
# In-memory cache for CPU delta calculation: name -> (cpu_time_ns, wall_time)
_cpu_cache: dict = {}


def get_vm_stats(name: str) -> dict:
    with _conn() as conn:
        d = conn.lookupByName(name)
        state, _ = d.state()
        if state != libvirt.VIR_DOMAIN_RUNNING:
            _cpu_cache.pop(name, None)
            return {
                "cpu_percent": 0.0,
                "mem_percent": 0.0,
                "mem_used_mb": 0,
                "mem_total_mb": 0,
                "net_rx_bytes": 0,
                "net_tx_bytes": 0,
                "interfaces": [],
            }

        # CPU %
        cpu_pct = 0.0
        try:
            cpu_stats = d.getCPUStats(True)  # aggregate across all vCPUs
            cpu_time = cpu_stats[0].get("cpu_time", 0)
            now = time.time()
            if name in _cpu_cache:
                prev_cpu, prev_wall = _cpu_cache[name]
                wall_ns = (now - prev_wall) * 1e9
                vcpus = int(etree.fromstring(d.XMLDesc()).findtext("vcpu") or 1)
                if wall_ns > 0:
                    cpu_pct = min(100.0, (cpu_time - prev_cpu) / (wall_ns * vcpus) * 100)
            _cpu_cache[name] = (cpu_time, now)
        except libvirt.libvirtError:
            pass

        # Memory %
        mem_used_mb = 0
        mem_total_mb = 0
        mem_pct = 0.0
        try:
            mem = d.memoryStats()
            actual_kb = mem.get("actual", 0)
            unused_kb = mem.get("unused", actual_kb)
            used_kb = actual_kb - unused_kb
            mem_total_mb = actual_kb // 1024
            mem_used_mb = used_kb // 1024
            mem_pct = (used_kb / actual_kb * 100) if actual_kb > 0 else 0.0
        except libvirt.libvirtError:
            pass

        # Network I/O per interface
        xml = etree.fromstring(d.XMLDesc())
        interfaces = []
        net_rx_total = 0
        net_tx_total = 0
        for iface in xml.findall("devices/interface"):
            tgt = iface.find("target")
            mac_el = iface.find("mac")
            if tgt is None:
                continue
            dev = tgt.get("dev", "")
            mac = mac_el.get("address", "") if mac_el is not None else ""
            try:
                stats = d.interfaceStats(dev)
                rx = stats[0]
                tx = stats[4]
                net_rx_total += rx
                net_tx_total += tx
                interfaces.append({"dev": dev, "mac": mac, "rx_bytes": rx, "tx_bytes": tx})
            except libvirt.libvirtError:
                pass

        return {
            "cpu_percent": round(cpu_pct, 1),
            "mem_percent": round(mem_pct, 1),
            "mem_used_mb": mem_used_mb,
            "mem_total_mb": mem_total_mb,
            "net_rx_bytes": net_rx_total,
            "net_tx_bytes": net_tx_total,
            "interfaces": interfaces,
        }
```

**Step 2: Create `backend/app/api/stats.py`**

```python
from fastapi import APIRouter, HTTPException
from app.services import libvirt_svc as svc

router = APIRouter(tags=["stats"])


@router.get("/vms/{name}/stats")
def get_stats(name: str):
    try:
        return svc.get_vm_stats(name)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
```

**Step 3: Verify (after wiring in main.py)**
```bash
curl http://localhost:18000/api/vms/<running-vm-name>/stats
# Returns JSON with cpu_percent, mem_percent, etc.
```

---

## Task 3: Backend — Network management API

**Files:**
- Create: `backend/app/api/networks.py`
- Modify: `backend/app/services/libvirt_svc.py` (append)

**Step 1: Append network functions to `backend/app/services/libvirt_svc.py`**

```python
def _random_mac() -> str:
    b = os.urandom(3)
    return f"52:54:00:{b[0]:02x}:{b[1]:02x}:{b[2]:02x}"


def get_host_networks() -> List[dict]:
    with _conn() as conn:
        result = []
        for net in conn.listAllNetworks():
            xml = etree.fromstring(net.XMLDesc())
            fwd = xml.find("forward")
            mode = fwd.get("mode", "nat") if fwd is not None else "isolated"
            bridge = ""
            try:
                bridge = net.bridgeName()
            except libvirt.libvirtError:
                pass
            result.append({
                "name": net.name(),
                "active": bool(net.isActive()),
                "bridge": bridge,
                "forward_mode": mode,
            })
        return result


def get_vm_networks(name: str) -> List[dict]:
    with _conn() as conn:
        d = conn.lookupByName(name)
        xml = etree.fromstring(d.XMLDesc())
        result = []
        for iface in xml.findall("devices/interface"):
            mac_el = iface.find("mac")
            src_el = iface.find("source")
            model_el = iface.find("model")
            tgt_el = iface.find("target")
            mac = mac_el.get("address", "") if mac_el is not None else ""
            iface_type = iface.get("type", "")
            if src_el is not None:
                source = src_el.get("network", "") or src_el.get("bridge", "")
            else:
                source = ""
            result.append({
                "mac": mac,
                "type": iface_type,
                "source": source,
                "model": model_el.get("type", "virtio") if model_el is not None else "virtio",
                "target": tgt_el.get("dev", "") if tgt_el is not None else "",
            })
        return result


def attach_network(name: str, source: str, source_type: str = "network", model: str = "virtio"):
    mac = _random_mac()
    src_attr = "network" if source_type == "network" else "bridge"
    iface_xml = (
        f"<interface type='{source_type}'>"
        f"<mac address='{mac}'/>"
        f"<source {src_attr}='{source}'/>"
        f"<model type='{model}'/>"
        f"</interface>"
    )
    with _conn() as conn:
        d = conn.lookupByName(name)
        state, _ = d.state()
        flags = libvirt.VIR_DOMAIN_AFFECT_CONFIG
        if state == libvirt.VIR_DOMAIN_RUNNING:
            flags |= libvirt.VIR_DOMAIN_AFFECT_LIVE
        d.attachDeviceFlags(iface_xml, flags)


def detach_network(name: str, mac_addr: str):
    with _conn() as conn:
        d = conn.lookupByName(name)
        xml = etree.fromstring(d.XMLDesc())
        for iface in xml.findall("devices/interface"):
            mac_el = iface.find("mac")
            if mac_el is not None and mac_el.get("address", "").lower() == mac_addr.lower():
                state, _ = d.state()
                flags = libvirt.VIR_DOMAIN_AFFECT_CONFIG
                if state == libvirt.VIR_DOMAIN_RUNNING:
                    flags |= libvirt.VIR_DOMAIN_AFFECT_LIVE
                d.detachDeviceFlags(etree.tostring(iface, encoding="unicode"), flags)
                return
        raise ValueError(f"Network interface {mac_addr} not found")
```

**Step 2: Create `backend/app/api/networks.py`**

```python
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from app.services import libvirt_svc as svc

router = APIRouter(tags=["networks"])


class NetworkAttach(BaseModel):
    source: str
    source_type: str = "network"
    model: str = "virtio"


@router.get("/host/networks")
def list_host_networks():
    try:
        return svc.get_host_networks()
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/vms/{name}/networks")
def list_vm_networks(name: str):
    try:
        return svc.get_vm_networks(name)
    except Exception as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.post("/vms/{name}/networks")
def attach_network(name: str, body: NetworkAttach):
    try:
        svc.attach_network(name, body.source, body.source_type, body.model)
        return {"ok": True}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/vms/{name}/networks/{mac}")
def detach_network(name: str, mac: str):
    try:
        svc.detach_network(name, mac)
        return {"ok": True}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
```

---

## Task 4: Backend — VM protection config API

**Files:**
- Create: `backend/app/api/config.py`
- Modify: `backend/app/services/libvirt_svc.py` (append helpers + protection funcs)

**Step 1: Append data helpers and protection functions to `libvirt_svc.py`**

Add `import shutil` to the top-level imports. Then append:

```python
def _data_dir() -> str:
    d = os.environ.get("DATA_DIR", "/app/data")
    os.makedirs(d, exist_ok=True)
    return d


def _load_json(name: str) -> dict:
    path = os.path.join(_data_dir(), f"{name}.json")
    try:
        import json
        with open(path) as f:
            return json.load(f)
    except (FileNotFoundError, ValueError):
        return {}


def _save_json(name: str, data: dict):
    import json
    path = os.path.join(_data_dir(), f"{name}.json")
    with open(path, "w") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)


def get_protection_config() -> dict:
    return _load_json("protection")


def set_vm_protection(vm_name: str, level: str | None, note: str = ""):
    config = _load_json("protection")
    if level is None:
        config.pop(vm_name, None)
    else:
        config[vm_name] = {"level": level, "note": note}
    _save_json("protection", config)
```

**Step 2: Create `backend/app/api/config.py`**

```python
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from typing import Optional
from app.services import libvirt_svc as svc

router = APIRouter(tags=["config"])


class ProtectionUpdate(BaseModel):
    level: Optional[str] = None  # "critical" or None to remove
    note: str = ""


@router.get("/config/protection")
def get_protection():
    return svc.get_protection_config()


@router.put("/config/protection/{vm_name}")
def set_protection(vm_name: str, body: ProtectionUpdate):
    try:
        svc.set_vm_protection(vm_name, body.level, body.note)
        return {"ok": True}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/config/protection/{vm_name}")
def remove_protection(vm_name: str):
    try:
        svc.set_vm_protection(vm_name, None)
        return {"ok": True}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
```

---

## Task 5: Backend — Templates API

**Files:**
- Create: `backend/app/api/templates.py`
- Modify: `backend/app/services/libvirt_svc.py` (append)

**Step 1: Append template functions to `libvirt_svc.py`**

Make sure `import shutil` is at the top (add if not present).

```python
def list_templates() -> List[dict]:
    manifest = _load_json("templates")
    return [
        {k: v for k, v in t.items() if k != "xml"}
        for t in manifest.values()
    ]


def create_template(vm_name: str, template_name: str, description: str = ""):
    import shutil, json
    with _conn() as conn:
        d = conn.lookupByName(vm_name)
        state, _ = d.state()
        if state == libvirt.VIR_DOMAIN_RUNNING:
            raise ValueError("VM must be shut off to create a template")
        xml_str = d.XMLDesc(libvirt.VIR_DOMAIN_XML_INACTIVE)
        xml_tree = etree.fromstring(xml_str)

    tpl_dir = os.path.join(_data_dir(), "templates", template_name)
    os.makedirs(tpl_dir, exist_ok=True)

    disk_paths = []
    for disk in xml_tree.findall("devices/disk[@device='disk']"):
        src = disk.find("source")
        if src is None:
            continue
        orig = src.get("file", "")
        if not orig or not os.path.exists(orig):
            continue
        dest = os.path.join(tpl_dir, os.path.basename(orig))
        shutil.copy2(orig, dest)
        disk_paths.append({"original": orig, "copy": dest})

    manifest = _load_json("templates")
    manifest[template_name] = {
        "name": template_name,
        "description": description,
        "source_vm": vm_name,
        "created_at": datetime.now().isoformat(),
        "xml": xml_str,
        "disks": disk_paths,
        "size_gb": round(
            sum(os.path.getsize(d["copy"]) for d in disk_paths) / (1024 ** 3), 2
        ),
    }
    _save_json("templates", manifest)


def clone_template(template_name: str, new_vm_name: str):
    import shutil
    manifest = _load_json("templates")
    if template_name not in manifest:
        raise ValueError(f"Template {template_name!r} not found")
    tmpl = manifest[template_name]
    xml_tree = etree.fromstring(tmpl["xml"])

    # Update identity fields
    name_el = xml_tree.find("name")
    if name_el is not None:
        name_el.text = new_vm_name
    uuid_el = xml_tree.find("uuid")
    if uuid_el is not None:
        uuid_el.text = str(uuid.uuid4())
    for mac_el in xml_tree.findall("devices/interface/mac"):
        b = os.urandom(3)
        mac_el.set("address", f"52:54:00:{b[0]:02x}:{b[1]:02x}:{b[2]:02x}")

    # Copy disk images
    images_dir = "/var/lib/libvirt/images"
    for disk_info in tmpl["disks"]:
        src = disk_info["copy"]
        basename = os.path.basename(disk_info["original"])
        dest = os.path.join(images_dir, f"{new_vm_name}-{basename}")
        shutil.copy2(src, dest)
        # Patch XML source path
        for disk in xml_tree.findall("devices/disk[@device='disk']"):
            src_el = disk.find("source")
            if src_el is not None and src_el.get("file", "") == disk_info["original"]:
                src_el.set("file", dest)

    with _conn() as conn:
        conn.defineXML(etree.tostring(xml_tree, encoding="unicode"))


def delete_template(template_name: str):
    import shutil
    manifest = _load_json("templates")
    if template_name not in manifest:
        raise ValueError(f"Template {template_name!r} not found")
    tpl_dir = os.path.join(_data_dir(), "templates", template_name)
    if os.path.exists(tpl_dir):
        shutil.rmtree(tpl_dir)
    del manifest[template_name]
    _save_json("templates", manifest)
```

**Step 2: Create `backend/app/api/templates.py`**

```python
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from app.services import libvirt_svc as svc

router = APIRouter(tags=["templates"])


class TemplateCreate(BaseModel):
    vm_name: str
    template_name: str
    description: str = ""


class TemplateClone(BaseModel):
    new_vm_name: str


@router.get("/templates")
def list_templates():
    try:
        return svc.list_templates()
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/templates")
def create_template(body: TemplateCreate):
    try:
        svc.create_template(body.vm_name, body.template_name, body.description)
        return {"ok": True}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/templates/{template_name}/clone")
def clone_template(template_name: str, body: TemplateClone):
    try:
        svc.clone_template(template_name, body.new_vm_name)
        return {"ok": True}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/templates/{template_name}")
def delete_template(template_name: str):
    try:
        svc.delete_template(template_name)
        return {"ok": True}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
```

---

## Task 6: Backend — Backups API

**Files:**
- Create: `backend/app/api/backups.py`
- Modify: `backend/app/services/libvirt_svc.py` (append)

**Step 1: Append backup functions to `libvirt_svc.py`**

```python
def list_backups() -> List[dict]:
    manifest = _load_json("backups")
    return sorted(manifest.values(), key=lambda x: x.get("created_at", ""), reverse=True)


def create_backup(vm_name: str) -> dict:
    import shutil
    backup_id = uuid.uuid4().hex[:8]
    backup_dir = os.path.join(_data_dir(), "backups", backup_id)
    os.makedirs(backup_dir, exist_ok=True)

    with _conn() as conn:
        d = conn.lookupByName(vm_name)
        xml_str = d.XMLDesc(libvirt.VIR_DOMAIN_XML_INACTIVE)
        xml_tree = etree.fromstring(xml_str)

    with open(os.path.join(backup_dir, "domain.xml"), "w") as f:
        f.write(xml_str)

    disk_paths = []
    total_bytes = 0
    for disk in xml_tree.findall("devices/disk[@device='disk']"):
        src = disk.find("source")
        if src is None:
            continue
        orig = src.get("file", "")
        if not orig or not os.path.exists(orig):
            continue
        dest = os.path.join(backup_dir, os.path.basename(orig))
        shutil.copy2(orig, dest)
        sz = os.path.getsize(dest)
        total_bytes += sz
        disk_paths.append({"original": orig, "backup": dest})

    manifest = _load_json("backups")
    entry = {
        "id": backup_id,
        "vm_name": vm_name,
        "created_at": datetime.now().isoformat(),
        "size_gb": round(total_bytes / (1024 ** 3), 2),
        "disks": disk_paths,
    }
    manifest[backup_id] = entry
    _save_json("backups", manifest)
    return {k: v for k, v in entry.items() if k != "disks"}


def restore_backup(backup_id: str):
    import shutil
    manifest = _load_json("backups")
    if backup_id not in manifest:
        raise ValueError(f"Backup {backup_id!r} not found")
    backup = manifest[backup_id]
    backup_dir = os.path.join(_data_dir(), "backups", backup_id)
    xml_path = os.path.join(backup_dir, "domain.xml")
    with open(xml_path) as f:
        xml_str = f.read()
    xml_tree = etree.fromstring(xml_str)
    vm_name = xml_tree.findtext("name") or ""

    with _conn() as conn:
        try:
            d = conn.lookupByName(vm_name)
            state, _ = d.state()
            if state == libvirt.VIR_DOMAIN_RUNNING:
                d.destroy()
            d.undefineFlags(libvirt.VIR_DOMAIN_UNDEFINE_SNAPSHOTS_METADATA)
        except libvirt.libvirtError:
            pass

        for disk_info in backup["disks"]:
            shutil.copy2(disk_info["backup"], disk_info["original"])

        conn.defineXML(xml_str)


def delete_backup(backup_id: str):
    import shutil
    manifest = _load_json("backups")
    if backup_id not in manifest:
        raise ValueError(f"Backup {backup_id!r} not found")
    backup_dir = os.path.join(_data_dir(), "backups", backup_id)
    if os.path.exists(backup_dir):
        shutil.rmtree(backup_dir)
    del manifest[backup_id]
    _save_json("backups", manifest)
```

**Step 2: Create `backend/app/api/backups.py`**

```python
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from app.services import libvirt_svc as svc

router = APIRouter(tags=["backups"])


class BackupCreate(BaseModel):
    vm_name: str


@router.get("/backups")
def list_backups():
    try:
        return svc.list_backups()
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/backups")
def create_backup(body: BackupCreate):
    try:
        return svc.create_backup(body.vm_name)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/backups/{backup_id}/restore")
def restore_backup(backup_id: str):
    try:
        svc.restore_backup(backup_id)
        return {"ok": True}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/backups/{backup_id}")
def delete_backup(backup_id: str):
    try:
        svc.delete_backup(backup_id)
        return {"ok": True}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
```

---

## Task 7: Backend — Wire everything into main.py + update docker-compose.yml

**Files:**
- Modify: `backend/app/main.py`
- Modify: `docker-compose.yml`

**Step 1: Replace `backend/app/main.py` completely**

```python
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.api import vms, cpu, memory, disk, usb, snapshots, console
from app.api import stats, networks, config, templates, backups, events
from app.middleware.events import EventLogMiddleware

app = FastAPI(title="KVM Manager API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)
app.add_middleware(EventLogMiddleware)

for router in [vms, cpu, memory, disk, usb, snapshots, console,
               stats, networks, config, templates, backups, events]:
    app.include_router(router.router, prefix="/api")
```

**Step 2: Update `docker-compose.yml` — add `kvm_data` volume and `DATA_DIR` env**

In the `kvm-api` service, add to `volumes`:
```yaml
      - kvm_data:/app/data
```
Add to `environment`:
```yaml
      - DATA_DIR=/app/data
```

At the bottom `volumes:` section, add:
```yaml
  kvm_data:
```

Final `docker-compose.yml` should look like:

```yaml
version: "3.9"

services:
  kvm-api:
    build: ./backend
    ports:
      - "18000:8000"
    volumes:
      - /var/run/libvirt/libvirt-sock:/var/run/libvirt/libvirt-sock
      - /var/lib/libvirt/images:/var/lib/libvirt/images
      - vnc_tokens:/vnc-tokens
      - kvm_data:/app/data
    group_add:
      - "121"
    environment:
      - VNC_TOKEN_DIR=/vnc-tokens
      - VNC_HOST=host.docker.internal
      - NOVNC_HOST=${NOVNC_HOST:-10.70.70.172}
      - NOVNC_PORT=${NOVNC_PORT:-80}
      - NOVNC_PATH=${NOVNC_PATH:-kvm/novnc}
      - DATA_DIR=/app/data
    extra_hosts:
      - "host.docker.internal:host-gateway"
    restart: unless-stopped

  kvm-web:
    build: ./frontend
    ports:
      - "18080:80"
    depends_on:
      - kvm-api
    restart: unless-stopped

  kvm-novnc:
    build: ./novnc
    ports:
      - "16080:6080"
    volumes:
      - vnc_tokens:/vnc-tokens
    extra_hosts:
      - "host.docker.internal:host-gateway"
    restart: unless-stopped

volumes:
  vnc_tokens:
  kvm_data:
```

**Step 3: Verify backend starts without errors**
```bash
docker compose build kvm-api
# Should succeed with no import errors
```

---

## Task 8: Frontend — Install recharts, update types.ts and client.ts

**Files:**
- Modify: `frontend/package.json`
- Modify: `frontend/src/types.ts`
- Modify: `frontend/src/api/client.ts`

**Step 1: Add recharts to `frontend/package.json` dependencies**

Add to the `"dependencies"` object:
```json
"recharts": "^2.12.7"
```

**Step 2: Replace `frontend/src/types.ts` completely**

```typescript
export interface VMSummary {
  name: string; state: string; vcpus: number; memory_mb: number
}
export interface VMDetail extends VMSummary {
  uuid: string; autostart: boolean
}
export interface CPUConfig {
  vcpus: number; sockets: number; cores: number; threads: number
}
export interface MemoryConfig { current_mb: number; max_mb: number }
export interface DiskInfo { dev: string; path: string; size_gb: number; format: string }
export interface USBDevice { id: string; vendor_id: string; product_id: string; name: string }
export interface SnapshotInfo { name: string; description: string; created_at: string; state: string }
export interface ConsoleInfo { url: string; token: string }

export interface VMStats {
  cpu_percent: number
  mem_percent: number
  mem_used_mb: number
  mem_total_mb: number
  net_rx_bytes: number
  net_tx_bytes: number
  interfaces: { dev: string; mac: string; rx_bytes: number; tx_bytes: number }[]
}
export interface NetworkInterface {
  mac: string; type: string; source: string; model: string; target: string
}
export interface HostNetwork {
  name: string; active: boolean; bridge: string; forward_mode: string
}
export interface ProtectionConfig {
  [vmName: string]: { level: string; note: string }
}
export interface Template {
  name: string; description: string; source_vm: string; created_at: string; size_gb: number
}
export interface Backup {
  id: string; vm_name: string; created_at: string; size_gb: number
}
export interface EventLog {
  timestamp: string; method: string; path: string; vm_name: string
  action: string; status_code: number; success: boolean
}
export interface EventsResponse {
  total: number; page: number; page_size: number; items: EventLog[]
}
```

**Step 3: Replace `frontend/src/api/client.ts` completely**

```typescript
import axios from 'axios'
import type {
  VMSummary, VMDetail, CPUConfig, MemoryConfig, DiskInfo, USBDevice,
  SnapshotInfo, ConsoleInfo, VMStats, NetworkInterface, HostNetwork,
  ProtectionConfig, Template, Backup, EventsResponse,
} from '../types'

const api = axios.create({ baseURL: '/kvm/api', timeout: 10000 })

export const vmApi = {
  list: () => api.get<VMSummary[]>('/vms').then(r => r.data),
  get: (name: string) => api.get<VMDetail>(`/vms/${name}`).then(r => r.data),
  start: (name: string) => api.post(`/vms/${name}/start`),
  shutdown: (name: string) => api.post(`/vms/${name}/shutdown`),
  forceOff: (name: string) => api.post(`/vms/${name}/force-off`),
  getStats: (name: string) => api.get<VMStats>(`/vms/${name}/stats`).then(r => r.data),
}
export const cpuApi = {
  get: (name: string) => api.get<CPUConfig>(`/vms/${name}/cpu`).then(r => r.data),
  update: (name: string, data: CPUConfig) => api.put(`/vms/${name}/cpu`, data),
}
export const memoryApi = {
  get: (name: string) => api.get<MemoryConfig>(`/vms/${name}/memory`).then(r => r.data),
  update: (name: string, data: Partial<MemoryConfig>) => api.put(`/vms/${name}/memory`, data),
}
export const diskApi = {
  list: (name: string) => api.get<DiskInfo[]>(`/vms/${name}/disks`).then(r => r.data),
  attach: (name: string, data: { path?: string; size_gb?: number }) => api.post(`/vms/${name}/disks`, data),
  detach: (name: string, dev: string) => api.delete(`/vms/${name}/disks/${dev}`),
}
export const usbApi = {
  listHost: () => api.get<USBDevice[]>('/host/usb').then(r => r.data),
  listVm: (name: string) => api.get<USBDevice[]>(`/vms/${name}/usb`).then(r => r.data),
  attach: (name: string, data: { vendor_id: string; product_id: string }) => api.post(`/vms/${name}/usb`, data),
  detach: (name: string, id: string) => api.delete(`/vms/${name}/usb/${id}`),
}
export const snapshotApi = {
  list: (name: string) => api.get<SnapshotInfo[]>(`/vms/${name}/snapshots`).then(r => r.data),
  create: (name: string, data: { name: string; description?: string }) => api.post(`/vms/${name}/snapshots`, data),
  revert: (name: string, snap: string) => api.post(`/vms/${name}/snapshots/${snap}/revert`),
  delete: (name: string, snap: string) => api.delete(`/vms/${name}/snapshots/${snap}`),
}
export const consoleApi = {
  getUrl: (name: string) => api.get<ConsoleInfo>(`/vms/${name}/console`).then(r => r.data),
}
export const networkApi = {
  listHost: () => api.get<HostNetwork[]>('/host/networks').then(r => r.data),
  listVm: (name: string) => api.get<NetworkInterface[]>(`/vms/${name}/networks`).then(r => r.data),
  attach: (name: string, data: { source: string; source_type?: string; model?: string }) =>
    api.post(`/vms/${name}/networks`, data),
  detach: (name: string, mac: string) => api.delete(`/vms/${name}/networks/${mac}`),
}
export const protectionApi = {
  get: () => api.get<ProtectionConfig>('/config/protection').then(r => r.data),
  set: (vmName: string, level: string, note?: string) =>
    api.put(`/config/protection/${vmName}`, { level, note: note ?? '' }),
  remove: (vmName: string) => api.delete(`/config/protection/${vmName}`),
}
export const templateApi = {
  list: () => api.get<Template[]>('/templates').then(r => r.data),
  create: (data: { vm_name: string; template_name: string; description?: string }) =>
    api.post('/templates', data),
  clone: (templateName: string, newVmName: string) =>
    api.post(`/templates/${templateName}/clone`, { new_vm_name: newVmName }),
  delete: (templateName: string) => api.delete(`/templates/${templateName}`),
}
export const backupApi = {
  list: () => api.get<Backup[]>('/backups').then(r => r.data),
  create: (vmName: string) => api.post('/backups', { vm_name: vmName }),
  restore: (id: string) => api.post(`/backups/${id}/restore`),
  delete: (id: string) => api.delete(`/backups/${id}`),
}
export const eventsApi = {
  list: (page = 1, vmName = '') =>
    api.get<EventsResponse>('/events', { params: { page, vm_name: vmName } }).then(r => r.data),
}
```

**Step 4: Install recharts**
```bash
cd frontend && npm install recharts
```

---

## Task 9: Frontend — Cyberpunk CSS theme + Ant Design dark config

**Files:**
- Create: `frontend/src/theme.css`
- Modify: `frontend/src/main.tsx`

**Step 1: Create `frontend/src/theme.css`**

```css
:root {
  --bg-primary: #080c14;
  --bg-secondary: #0d1526;
  --bg-card: rgba(13, 21, 38, 0.95);
  --color-cyan: #00d4ff;
  --color-purple: #7b2fff;
  --color-green: #00ff88;
  --color-red: #ff4d6d;
  --color-yellow: #ffcc00;
  --color-text: #c8d8f0;
  --color-text-dim: #4a6080;
  --glow-cyan: 0 0 12px rgba(0, 212, 255, 0.25);
  --glow-cyan-strong: 0 0 20px rgba(0, 212, 255, 0.5);
  --glow-green: 0 0 10px rgba(0, 255, 136, 0.4);
  --glow-red: 0 0 10px rgba(255, 77, 109, 0.4);
  --font-mono: 'JetBrains Mono', 'Fira Code', 'Courier New', monospace;
}

* { box-sizing: border-box; }

body {
  margin: 0;
  background-color: var(--bg-primary) !important;
  background-image:
    linear-gradient(rgba(0, 212, 255, 0.025) 1px, transparent 1px),
    linear-gradient(90deg, rgba(0, 212, 255, 0.025) 1px, transparent 1px);
  background-size: 40px 40px;
  color: var(--color-text) !important;
}

/* ── Scrollbar ── */
::-webkit-scrollbar { width: 6px; height: 6px; }
::-webkit-scrollbar-track { background: var(--bg-primary); }
::-webkit-scrollbar-thumb { background: rgba(0, 212, 255, 0.3); border-radius: 3px; }

/* ── Cyberpunk card ── */
.cyber-card .ant-card {
  background: var(--bg-card) !important;
  border: 1px solid rgba(0, 212, 255, 0.2) !important;
  box-shadow: var(--glow-cyan) !important;
  transition: border-color 0.3s, box-shadow 0.3s;
}
.cyber-card .ant-card:hover {
  border-color: rgba(0, 212, 255, 0.5) !important;
  box-shadow: var(--glow-cyan-strong) !important;
}
.cyber-card .ant-card-head {
  border-bottom: 1px solid rgba(0, 212, 255, 0.15) !important;
  background: transparent !important;
}

/* ── Status pulse animations ── */
@keyframes pulse-green {
  0%, 100% { box-shadow: 0 0 6px rgba(0, 255, 136, 0.5); }
  50%       { box-shadow: 0 0 16px rgba(0, 255, 136, 0.9); }
}
@keyframes pulse-red {
  0%, 100% { opacity: 1; }
  50%       { opacity: 0.6; }
}

.vm-running-glow { animation: pulse-green 2.5s ease-in-out infinite; }
.vm-critical-border { border-left: 3px solid var(--color-red) !important; }

/* ── Monospace for tech data ── */
.mono { font-family: var(--font-mono) !important; font-size: 12px; }

/* ── Sidebar ── */
.cyber-sider {
  background: linear-gradient(180deg, #060910 0%, #080c14 100%) !important;
  border-right: 1px solid rgba(0, 212, 255, 0.12) !important;
}
.cyber-sider .ant-menu { background: transparent !important; }
.cyber-sider .ant-menu-item-selected {
  background: rgba(0, 212, 255, 0.08) !important;
  border-left: 3px solid var(--color-cyan) !important;
}
.cyber-sider .ant-menu-item-selected .ant-menu-title-content { color: var(--color-cyan) !important; }

/* ── Logo area with scan line ── */
.logo-area {
  height: 64px;
  display: flex;
  align-items: center;
  justify-content: center;
  border-bottom: 1px solid rgba(0, 212, 255, 0.12);
  position: relative;
  overflow: hidden;
}
@keyframes scanline {
  0%   { transform: translateY(-100%); opacity: 0.8; }
  100% { transform: translateY(300%); opacity: 0; }
}
.logo-area::after {
  content: '';
  position: absolute;
  left: 0; right: 0;
  height: 2px;
  background: linear-gradient(90deg, transparent, var(--color-cyan), transparent);
  animation: scanline 4s linear infinite;
}

/* ── Gauge / chart wrapper ── */
.stat-card {
  background: var(--bg-card);
  border: 1px solid rgba(0, 212, 255, 0.15);
  border-radius: 8px;
  padding: 16px;
  text-align: center;
  box-shadow: var(--glow-cyan);
}
.stat-label {
  font-size: 11px;
  letter-spacing: 2px;
  text-transform: uppercase;
  color: var(--color-text-dim);
  margin-bottom: 8px;
}
.stat-value {
  font-family: var(--font-mono);
  font-size: 28px;
  font-weight: 700;
  color: var(--color-cyan);
}

/* ── Mini progress bar in VM card ── */
.mini-bar-track {
  background: rgba(0, 212, 255, 0.1);
  border-radius: 2px;
  height: 4px;
  margin-top: 2px;
  overflow: hidden;
}
.mini-bar-fill {
  height: 100%;
  background: linear-gradient(90deg, var(--color-cyan), var(--color-purple));
  border-radius: 2px;
  transition: width 0.5s ease;
}

/* ── Table ── */
.ant-table-wrapper .ant-table {
  background: var(--bg-card) !important;
}
.ant-table-wrapper .ant-table-thead > tr > th {
  background: rgba(0, 212, 255, 0.05) !important;
  border-bottom: 1px solid rgba(0, 212, 255, 0.2) !important;
  color: var(--color-cyan) !important;
  font-size: 11px;
  letter-spacing: 1px;
  text-transform: uppercase;
}

/* ── Tag overrides ── */
.ant-tag { font-family: var(--font-mono) !important; }

/* ── Button glow on primary ── */
.ant-btn-primary {
  box-shadow: 0 0 8px rgba(0, 212, 255, 0.3) !important;
}
.ant-btn-primary:hover {
  box-shadow: 0 0 16px rgba(0, 212, 255, 0.5) !important;
}

/* ── Modal ── */
.ant-modal-content {
  background: var(--bg-secondary) !important;
  border: 1px solid rgba(0, 212, 255, 0.2) !important;
}
.ant-modal-header {
  background: transparent !important;
  border-bottom: 1px solid rgba(0, 212, 255, 0.15) !important;
}
```

**Step 2: Replace `frontend/src/main.tsx` completely**

```tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import { ConfigProvider, theme as antTheme } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import App from './App'
import './theme.css'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ConfigProvider
      locale={zhCN}
      theme={{
        algorithm: antTheme.darkAlgorithm,
        token: {
          colorPrimary: '#00d4ff',
          colorBgBase: '#080c14',
          colorBgContainer: '#0d1526',
          colorBgElevated: '#0d1526',
          colorBorder: 'rgba(0, 212, 255, 0.2)',
          colorText: '#c8d8f0',
          colorTextSecondary: '#4a6080',
          borderRadius: 6,
          fontFamily: "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
        },
        components: {
          Layout: { siderBg: '#060910', bodyBg: '#080c14', headerBg: '#080c14' },
          Menu: {
            darkItemBg: 'transparent',
            darkItemSelectedBg: 'rgba(0, 212, 255, 0.08)',
            darkItemSelectedColor: '#00d4ff',
            darkItemHoverBg: 'rgba(0, 212, 255, 0.04)',
          },
          Card: { colorBgContainer: 'rgba(13, 21, 38, 0.95)' },
          Table: { colorBgContainer: 'rgba(13, 21, 38, 0.95)', headerBg: 'rgba(0, 212, 255, 0.05)' },
          Modal: { contentBg: '#0d1526', headerBg: '#0d1526' },
          Drawer: { colorBgElevated: '#0d1526' },
          Tabs: { colorBgContainer: 'transparent' },
        },
      }}
    >
      <App />
    </ConfigProvider>
  </React.StrictMode>
)
```

---

## Task 10: Frontend — App layout with sidebar navigation

**Files:**
- Modify: `frontend/src/App.tsx`

**Step 1: Replace `frontend/src/App.tsx` completely**

```tsx
import { BrowserRouter, Routes, Route, useNavigate, useLocation } from 'react-router-dom'
import { Layout, Menu } from 'antd'
import {
  DashboardOutlined, HistoryOutlined, CopyOutlined,
  SaveOutlined, DatabaseOutlined,
} from '@ant-design/icons'
import Dashboard from './pages/Dashboard'
import VMDetail from './pages/VMDetail'
import EventLogPage from './pages/EventLogPage'
import TemplatesPage from './pages/TemplatesPage'
import BackupsPage from './pages/BackupsPage'

const { Sider, Content } = Layout

const NAV_ITEMS = [
  { key: '/', icon: <DashboardOutlined />, label: '总览' },
  { key: '/events', icon: <HistoryOutlined />, label: '事件日志' },
  { key: '/templates', icon: <CopyOutlined />, label: '模板管理' },
  { key: '/backups', icon: <SaveOutlined />, label: '备份管理' },
]

function SideNav() {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  const selectedKey = NAV_ITEMS.find(i => pathname.startsWith(i.key) && i.key !== '/')?.key
    ?? (pathname === '/' ? '/' : undefined)

  return (
    <Sider width={220} className="cyber-sider" style={{ position: 'fixed', height: '100vh', left: 0, top: 0, zIndex: 100 }}>
      <div className="logo-area">
        <span style={{ fontFamily: 'var(--font-mono)', color: 'var(--color-cyan)', fontWeight: 700, fontSize: 14, letterSpacing: 2 }}>
          <DatabaseOutlined style={{ marginRight: 8 }} />
          KVM MATRIX
        </span>
      </div>
      <Menu
        theme="dark"
        mode="inline"
        selectedKeys={selectedKey ? [selectedKey] : []}
        items={NAV_ITEMS}
        onClick={({ key }) => navigate(key)}
        style={{ marginTop: 8 }}
      />
    </Sider>
  )
}

function AppLayout() {
  return (
    <Layout style={{ minHeight: '100vh', background: 'var(--bg-primary)' }}>
      <SideNav />
      <Layout style={{ marginLeft: 220, background: 'var(--bg-primary)' }}>
        <Content style={{ padding: 24 }}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/vm/:name" element={<VMDetail />} />
            <Route path="/events" element={<EventLogPage />} />
            <Route path="/templates" element={<TemplatesPage />} />
            <Route path="/backups" element={<BackupsPage />} />
          </Routes>
        </Content>
      </Layout>
    </Layout>
  )
}

export default function App() {
  return (
    <BrowserRouter basename="/kvm">
      <AppLayout />
    </BrowserRouter>
  )
}
```

---

## Task 11: Frontend — Dashboard redesign (cyberpunk VM cards)

**Files:**
- Modify: `frontend/src/pages/Dashboard.tsx`

**Step 1: Replace `frontend/src/pages/Dashboard.tsx` completely**

```tsx
import { useEffect, useState, useCallback } from 'react'
import { useNavigate } from 'react-router-dom'
import { Col, Row, Space, Button, message, Typography, Tag, Tooltip } from 'antd'
import {
  PlayCircleOutlined, PoweroffOutlined, ThunderboltOutlined,
  DesktopOutlined, LockOutlined, WarningOutlined,
} from '@ant-design/icons'
import { vmApi, protectionApi, consoleApi } from '../api/client'
import type { VMSummary, ProtectionConfig, VMStats } from '../types'

const STATE_TAG: Record<string, { color: string; label: string }> = {
  running:     { color: '#00ff88', label: 'RUNNING' },
  shutoff:     { color: '#4a6080', label: 'OFFLINE' },
  paused:      { color: '#ffcc00', label: 'PAUSED' },
  crashed:     { color: '#ff4d6d', label: 'CRASHED' },
}

function MiniBar({ percent, color = 'var(--color-cyan)' }: { percent: number; color?: string }) {
  return (
    <div className="mini-bar-track">
      <div className="mini-bar-fill" style={{ width: `${Math.min(100, percent)}%`, background: color }} />
    </div>
  )
}

function VMCard({ vm, protection, stats, onAction }: {
  vm: VMSummary
  protection: ProtectionConfig
  stats: VMStats | undefined
  onAction: () => void
}) {
  const navigate = useNavigate()
  const running = vm.state === 'running'
  const prot = protection[vm.name]
  const isCritical = prot?.level === 'critical'
  const stateInfo = STATE_TAG[vm.state] ?? { color: '#4a6080', label: vm.state.toUpperCase() }

  const doAction = async (fn: () => Promise<unknown>, label: string) => {
    try { await fn(); message.success(label); onAction() }
    catch { message.error('操作失败') }
  }

  const openConsole = async () => {
    try {
      const info = await consoleApi.getUrl(vm.name)
      window.open(info.url, '_blank')
    } catch { message.error('获取控制台失败') }
  }

  const cpuPct = stats?.cpu_percent ?? 0
  const memPct = stats?.mem_percent ?? 0

  return (
    <div
      className={`cyber-card ${running ? 'vm-running-glow' : ''} ${isCritical ? 'vm-critical-border' : ''}`}
      style={{
        background: 'var(--bg-card)',
        border: `1px solid ${running ? 'rgba(0,255,136,0.3)' : 'rgba(0,212,255,0.15)'}`,
        borderRadius: 8,
        padding: 16,
        cursor: 'pointer',
        transition: 'all 0.3s',
        position: 'relative',
      }}
      onClick={() => navigate(`/vm/${vm.name}`)}
    >
      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 12 }}>
        <Space>
          {isCritical && <Tooltip title={prot.note || '关键基础设施'}><WarningOutlined style={{ color: 'var(--color-red)' }} /></Tooltip>}
          <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--color-text)', fontSize: 14 }}>
            {vm.name}
          </span>
        </Space>
        <Tag style={{ background: 'transparent', border: `1px solid ${stateInfo.color}`, color: stateInfo.color, fontFamily: 'var(--font-mono)', fontSize: 10 }}>
          {stateInfo.label}
        </Tag>
      </div>

      {/* Stats */}
      <div style={{ fontSize: 12, color: 'var(--color-text-dim)', marginBottom: 8 }}>
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span>CPU {running ? `${cpuPct.toFixed(1)}%` : `${vm.vcpus} vCPU`}</span>
          <span className="mono">{vm.vcpus} vCPU</span>
        </div>
        <MiniBar percent={running ? cpuPct : 0} />
        <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
          <span>MEM {running ? `${memPct.toFixed(1)}%` : `${vm.memory_mb} MiB`}</span>
          <span className="mono">{vm.memory_mb} MiB</span>
        </div>
        <MiniBar percent={running ? memPct : 0} color="var(--color-purple)" />
        {running && stats && (
          <div style={{ marginTop: 6, fontFamily: 'var(--font-mono)', fontSize: 11 }}>
            <span style={{ color: 'var(--color-green)' }}>↑ {fmtBytes(stats.net_tx_bytes)}</span>
            {' / '}
            <span style={{ color: 'var(--color-cyan)' }}>↓ {fmtBytes(stats.net_rx_bytes)}</span>
          </div>
        )}
      </div>

      {/* Actions */}
      <div onClick={e => e.stopPropagation()} style={{ display: 'flex', gap: 4, flexWrap: 'wrap', marginTop: 8 }}>
        <Button size="small" icon={<PlayCircleOutlined />} disabled={running}
          onClick={() => doAction(() => vmApi.start(vm.name), '已启动')}
          style={{ fontSize: 11, height: 26 }}>启动</Button>
        <Button size="small" icon={<PoweroffOutlined />} disabled={!running}
          onClick={() => doAction(() => vmApi.shutdown(vm.name), '已关机')}
          style={{ fontSize: 11, height: 26 }}>关机</Button>
        <Button size="small" danger icon={<ThunderboltOutlined />} disabled={!running}
          onClick={() => doAction(() => vmApi.forceOff(vm.name), '已强制关机')}
          style={{ fontSize: 11, height: 26 }}>强制</Button>
        <Button size="small" icon={<DesktopOutlined />} disabled={!running}
          onClick={openConsole}
          style={{ fontSize: 11, height: 26, borderColor: 'var(--color-purple)', color: 'var(--color-purple)' }}>
          控制台
        </Button>
      </div>
    </div>
  )
}

function fmtBytes(b: number): string {
  if (b >= 1024 ** 3) return `${(b / 1024 ** 3).toFixed(1)} GB`
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(1)} MB`
  if (b >= 1024) return `${(b / 1024).toFixed(1)} KB`
  return `${b} B`
}

export default function Dashboard() {
  const [vms, setVms] = useState<VMSummary[]>([])
  const [protection, setProtection] = useState<ProtectionConfig>({})
  const [statsMap, setStatsMap] = useState<Record<string, VMStats>>({})

  const loadVms = useCallback(() =>
    vmApi.list().then(setVms).catch(() => message.error('加载失败')), [])

  const loadStats = useCallback((list: VMSummary[]) => {
    list.filter(v => v.state === 'running').forEach(v => {
      vmApi.getStats(v.name).then(s => setStatsMap(prev => ({ ...prev, [v.name]: s }))).catch(() => {})
    })
  }, [])

  useEffect(() => {
    protectionApi.get().then(setProtection).catch(() => {})
    loadVms()
  }, [])

  useEffect(() => {
    if (vms.length) loadStats(vms)
    const t = setInterval(() => {
      loadVms().then(() => loadStats(vms))
    }, 5000)
    return () => clearInterval(t)
  }, [vms.length])

  const running = vms.filter(v => v.state === 'running').length

  return (
    <div>
      {/* Header */}
      <div style={{ marginBottom: 24 }}>
        <Typography.Title level={4} style={{ color: 'var(--color-cyan)', margin: 0, fontFamily: 'var(--font-mono)', letterSpacing: 2 }}>
          VIRTUAL MACHINE MATRIX
        </Typography.Title>
        <span style={{ color: 'var(--color-text-dim)', fontSize: 12, fontFamily: 'var(--font-mono)' }}>
          {running} RUNNING / {vms.length} TOTAL
        </span>
      </div>

      <Row gutter={[16, 16]}>
        {vms.map(vm => (
          <Col key={vm.name} xs={24} sm={12} md={8} lg={6}>
            <VMCard
              vm={vm}
              protection={protection}
              stats={statsMap[vm.name]}
              onAction={loadVms}
            />
          </Col>
        ))}
      </Row>
    </div>
  )
}
```

---

## Task 12: Frontend — VM Detail redesign + MonitorPanel

**Files:**
- Create: `frontend/src/components/MonitorPanel.tsx`
- Modify: `frontend/src/pages/VMDetail.tsx`

**Step 1: Create `frontend/src/components/MonitorPanel.tsx`**

```tsx
import { useEffect, useState } from 'react'
import { Row, Col, Empty } from 'antd'
import {
  RadialBarChart, RadialBar, ResponsiveContainer,
  LineChart, Line, XAxis, Tooltip as RTooltip,
} from 'recharts'
import { vmApi } from '../api/client'
import type { VMStats } from '../types'

const MAX_HISTORY = 100

function fmtBytes(b: number) {
  if (b >= 1024 ** 2) return `${(b / 1024 ** 2).toFixed(1)}MB`
  if (b >= 1024) return `${(b / 1024).toFixed(0)}KB`
  return `${b}B`
}

function GaugeCard({ label, value, color }: { label: string; value: number; color: string }) {
  const data = [{ value, fill: color }]
  return (
    <div className="stat-card">
      <div className="stat-label">{label}</div>
      <ResponsiveContainer width="100%" height={120}>
        <RadialBarChart
          cx="50%" cy="80%"
          innerRadius="60%" outerRadius="90%"
          startAngle={180} endAngle={0}
          data={data}
          barSize={12}
        >
          <RadialBar dataKey="value" cornerRadius={4} background={{ fill: 'rgba(255,255,255,0.05)' }} />
        </RadialBarChart>
      </ResponsiveContainer>
      <div className="stat-value" style={{ color, marginTop: -24 }}>{value.toFixed(1)}%</div>
    </div>
  )
}

function SparkCard({ label, data, dataKey, color, fmt }: {
  label: string; data: any[]; dataKey: string; color: string; fmt?: (v: number) => string
}) {
  return (
    <div className="stat-card" style={{ textAlign: 'left' }}>
      <div className="stat-label">{label}</div>
      <ResponsiveContainer width="100%" height={60}>
        <LineChart data={data}>
          <Line type="monotone" dataKey={dataKey} stroke={color} dot={false} strokeWidth={2} />
          <RTooltip
            formatter={(v: number) => fmt ? fmt(v) : v}
            contentStyle={{ background: 'var(--bg-secondary)', border: '1px solid rgba(0,212,255,0.3)', fontSize: 11 }}
          />
        </LineChart>
      </ResponsiveContainer>
    </div>
  )
}

export default function MonitorPanel({ name, running }: { name: string; running: boolean }) {
  const [stats, setStats] = useState<VMStats | null>(null)
  const [history, setHistory] = useState<(VMStats & { t: number })[]>([])

  useEffect(() => {
    if (!running) { setStats(null); setHistory([]); return }
    const load = async () => {
      try {
        const s = await vmApi.getStats(name)
        setStats(s)
        setHistory(prev => [...prev.slice(-MAX_HISTORY + 1), { ...s, t: Date.now() }])
      } catch {}
    }
    load()
    const t = setInterval(load, 3000)
    return () => clearInterval(t)
  }, [name, running])

  if (!running) return <Empty description="VM 未运行" style={{ padding: 40 }} />
  if (!stats) return <div style={{ color: 'var(--color-text-dim)', padding: 20 }}>加载中...</div>

  return (
    <div style={{ padding: '8px 0' }}>
      {/* Gauges */}
      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={24} sm={8}>
          <GaugeCard label="CPU USAGE" value={stats.cpu_percent} color="var(--color-cyan)" />
        </Col>
        <Col xs={24} sm={8}>
          <GaugeCard label="MEMORY USAGE" value={stats.mem_percent} color="var(--color-purple)" />
        </Col>
        <Col xs={24} sm={8}>
          <div className="stat-card">
            <div className="stat-label">MEMORY</div>
            <div className="stat-value" style={{ fontSize: 20, marginTop: 24 }}>
              {stats.mem_used_mb}
            </div>
            <div style={{ color: 'var(--color-text-dim)', fontSize: 11, fontFamily: 'var(--font-mono)' }}>
              / {stats.mem_total_mb} MiB
            </div>
          </div>
        </Col>
      </Row>

      {/* Sparklines */}
      <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
        <Col xs={24} sm={8}>
          <SparkCard label="CPU TREND" data={history} dataKey="cpu_percent" color="var(--color-cyan)" fmt={v => `${v.toFixed(1)}%`} />
        </Col>
        <Col xs={24} sm={8}>
          <SparkCard label="MEM TREND" data={history} dataKey="mem_percent" color="var(--color-purple)" fmt={v => `${v.toFixed(1)}%`} />
        </Col>
        <Col xs={24} sm={8}>
          <SparkCard label="NET TX" data={history} dataKey="net_tx_bytes" color="var(--color-green)" fmt={fmtBytes} />
        </Col>
      </Row>

      {/* Per-interface */}
      {stats.interfaces.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <div style={{ color: 'var(--color-text-dim)', fontSize: 11, letterSpacing: 2, textTransform: 'uppercase', marginBottom: 8 }}>
            Network Interfaces
          </div>
          {stats.interfaces.map(iface => (
            <div key={iface.dev} style={{
              display: 'flex', justifyContent: 'space-between', alignItems: 'center',
              padding: '8px 12px', marginBottom: 4,
              background: 'rgba(0,212,255,0.03)', border: '1px solid rgba(0,212,255,0.1)', borderRadius: 4,
            }}>
              <span className="mono" style={{ color: 'var(--color-cyan)' }}>{iface.dev}</span>
              <span className="mono" style={{ color: 'var(--color-text-dim)', fontSize: 11 }}>{iface.mac}</span>
              <span style={{ fontSize: 11, fontFamily: 'var(--font-mono)' }}>
                <span style={{ color: 'var(--color-green)' }}>↑ {fmtBytes(iface.tx_bytes)}</span>
                {' / '}
                <span style={{ color: 'var(--color-cyan)' }}>↓ {fmtBytes(iface.rx_bytes)}</span>
              </span>
            </div>
          ))}
        </div>
      )}
    </div>
  )
}
```

**Step 2: Replace `frontend/src/pages/VMDetail.tsx` completely**

```tsx
import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Space, Button, Tabs, message, Tag, Modal, Switch, Tooltip } from 'antd'
import {
  ArrowLeftOutlined, PlayCircleOutlined, PoweroffOutlined,
  ThunderboltOutlined, DesktopOutlined, WarningOutlined, LockOutlined,
} from '@ant-design/icons'
import { vmApi, consoleApi, protectionApi } from '../api/client'
import type { VMDetail, ProtectionConfig } from '../types'
import CPUPanel from '../components/CPUPanel'
import MemoryPanel from '../components/MemoryPanel'
import DiskPanel from '../components/DiskPanel'
import USBPanel from '../components/USBPanel'
import SnapshotPanel from '../components/SnapshotPanel'
import MonitorPanel from '../components/MonitorPanel'
import NetworkPanel from '../components/NetworkPanel'

const STATE_TAG: Record<string, { color: string; label: string }> = {
  running: { color: '#00ff88', label: 'RUNNING' },
  shutoff: { color: '#4a6080', label: 'OFFLINE' },
  paused:  { color: '#ffcc00', label: 'PAUSED' },
  crashed: { color: '#ff4d6d', label: 'CRASHED' },
}

export default function VMDetailPage() {
  const { name } = useParams<{ name: string }>()
  const navigate = useNavigate()
  const [vm, setVm] = useState<VMDetail | null>(null)
  const [protection, setProtection] = useState<ProtectionConfig>({})
  const [pendingAction, setPendingAction] = useState<null | { label: string; fn: () => Promise<unknown> }>(null)

  const load = () => { if (name) vmApi.get(name).then(setVm).catch(() => message.error('加载失败')) }

  useEffect(() => {
    load()
    protectionApi.get().then(setProtection).catch(() => {})
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [name])

  if (!vm || !name) return null
  const running = vm.state === 'running'
  const stateInfo = STATE_TAG[vm.state] ?? { color: '#4a6080', label: vm.state.toUpperCase() }
  const prot = protection[name]
  const isCritical = prot?.level === 'critical'

  const doAction = async (fn: () => Promise<unknown>, label: string) => {
    if (isCritical) {
      setPendingAction({ label, fn })
      return
    }
    try { await fn(); message.success(label); load() }
    catch { message.error('操作失败') }
  }

  const confirmAction = async () => {
    if (!pendingAction) return
    try { await pendingAction.fn(); message.success(pendingAction.label); load() }
    catch { message.error('操作失败') }
    finally { setPendingAction(null) }
  }

  const openConsole = async () => {
    try { const info = await consoleApi.getUrl(name); window.open(info.url, '_blank') }
    catch { message.error('获取控制台失败') }
  }

  const toggleProtection = async (checked: boolean) => {
    try {
      if (checked) await protectionApi.set(name, 'critical', '关键基础设施，需通过 BMC 操作')
      else await protectionApi.remove(name)
      const p = await protectionApi.get()
      setProtection(p)
      message.success(checked ? '已启用保护' : '已移除保护')
    } catch { message.error('操作失败') }
  }

  return (
    <div>
      {/* Critical VM warning modal */}
      <Modal
        open={!!pendingAction}
        onCancel={() => setPendingAction(null)}
        onOk={confirmAction}
        okText="我已知晓，继续操作"
        okButtonProps={{ danger: true }}
        cancelText="取消"
        title={<span style={{ color: 'var(--color-red)' }}>🚨 关键基础设施警告</span>}
      >
        <p style={{ color: 'var(--color-text)' }}>
          <strong>{name}</strong> 是受保护的关键基础设施 VM。
        </p>
        <p style={{ color: 'var(--color-text)' }}>
          操作后网络或管理界面可能中断，无法通过常规方式恢复。
        </p>
        <div style={{
          background: 'rgba(255,77,109,0.08)', border: '1px solid rgba(255,77,109,0.3)',
          borderRadius: 6, padding: 12, marginTop: 12,
        }}>
          <WarningOutlined style={{ color: 'var(--color-red)', marginRight: 8 }} />
          <span style={{ color: 'var(--color-red)', fontFamily: 'var(--font-mono)', fontSize: 12 }}>
            恢复方式：需通过 BMC（带外管理）控制台操作
          </span>
        </div>
      </Modal>

      {/* Header */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start', marginBottom: 20 }}>
        <Space wrap>
          <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/')} size="small" />
          <span style={{ fontFamily: 'var(--font-mono)', fontSize: 18, fontWeight: 700, color: 'var(--color-text)' }}>
            {vm.name}
          </span>
          <Tag style={{ background: 'transparent', border: `1px solid ${stateInfo.color}`, color: stateInfo.color, fontFamily: 'var(--font-mono)', fontSize: 11 }}>
            {stateInfo.label}
          </Tag>
          {isCritical && (
            <Tooltip title="关键基础设施">
              <LockOutlined style={{ color: 'var(--color-red)' }} />
            </Tooltip>
          )}
        </Space>
        <Space>
          <span style={{ color: 'var(--color-text-dim)', fontSize: 12 }}>保护模式</span>
          <Switch
            checked={isCritical}
            onChange={toggleProtection}
            checkedChildren={<WarningOutlined />}
            size="small"
          />
        </Space>
      </div>

      <Space style={{ marginBottom: 16 }} wrap>
        <Button icon={<PlayCircleOutlined />} disabled={running}
          onClick={() => doAction(() => vmApi.start(name), '已启动')}>启动</Button>
        <Button icon={<PoweroffOutlined />} disabled={!running}
          onClick={() => doAction(() => vmApi.shutdown(name), '已关机')}>关机</Button>
        <Button icon={<ThunderboltOutlined />} danger disabled={!running}
          onClick={() => doAction(() => vmApi.forceOff(name), '已强制关机')}>强制关机</Button>
        <Button icon={<DesktopOutlined />} disabled={!running}
          onClick={openConsole}
          style={{ borderColor: 'var(--color-purple)', color: 'var(--color-purple)' }}>控制台</Button>
      </Space>

      <Tabs items={[
        { key: 'monitor', label: '概览', children: <MonitorPanel name={name} running={running} /> },
        { key: 'cpu', label: 'CPU', children: <CPUPanel name={name} running={running} /> },
        { key: 'memory', label: '内存', children: <MemoryPanel name={name} running={running} /> },
        { key: 'disk', label: '磁盘', children: <DiskPanel name={name} /> },
        { key: 'network', label: '网络', children: <NetworkPanel name={name} running={running} /> },
        { key: 'usb', label: 'USB', children: <USBPanel name={name} /> },
        { key: 'snapshots', label: '快照', children: <SnapshotPanel name={name} /> },
      ]} />
    </div>
  )
}
```

---

## Task 13: Frontend — NetworkPanel

**Files:**
- Create: `frontend/src/components/NetworkPanel.tsx`

**Step 1: Create `frontend/src/components/NetworkPanel.tsx`**

```tsx
import { useEffect, useState } from 'react'
import { Table, Button, Drawer, Select, Form, message, Popconfirm, Tag, Space } from 'antd'
import { PlusOutlined, DeleteOutlined } from '@ant-design/icons'
import { networkApi } from '../api/client'
import type { NetworkInterface, HostNetwork } from '../types'

export default function NetworkPanel({ name, running }: { name: string; running: boolean }) {
  const [ifaces, setIfaces] = useState<NetworkInterface[]>([])
  const [hostNets, setHostNets] = useState<HostNetwork[]>([])
  const [drawerOpen, setDrawerOpen] = useState(false)
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)

  const load = () => {
    networkApi.listVm(name).then(setIfaces).catch(() => {})
    networkApi.listHost().then(setHostNets).catch(() => {})
  }
  useEffect(() => { load() }, [name])

  const attach = async (values: { source: string; model: string }) => {
    setLoading(true)
    try {
      const net = hostNets.find(n => n.name === values.source)
      await networkApi.attach(name, {
        source: values.source,
        source_type: net?.forward_mode === 'bridge' ? 'bridge' : 'network',
        model: values.model,
      })
      message.success('网卡已添加')
      load()
      setDrawerOpen(false)
      form.resetFields()
    } catch { message.error('添加失败') }
    finally { setLoading(false) }
  }

  const detach = async (mac: string) => {
    try { await networkApi.detach(name, mac); message.success('已移除'); load() }
    catch { message.error('移除失败') }
  }

  const columns = [
    { title: 'TARGET', dataIndex: 'target', key: 'target', render: (v: string) => <span className="mono">{v || '—'}</span> },
    { title: 'MAC', dataIndex: 'mac', key: 'mac', render: (v: string) => <span className="mono" style={{ fontSize: 11 }}>{v}</span> },
    { title: 'SOURCE', dataIndex: 'source', key: 'source', render: (v: string) => <Tag style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}>{v}</Tag> },
    { title: 'MODEL', dataIndex: 'model', key: 'model', render: (v: string) => <span className="mono">{v}</span> },
    {
      title: '操作', key: 'action',
      render: (_: unknown, row: NetworkInterface) => (
        <Popconfirm title="确认移除此网卡？" onConfirm={() => detach(row.mac)}>
          <Button size="small" danger icon={<DeleteOutlined />} />
        </Popconfirm>
      ),
    },
  ]

  return (
    <div>
      <div style={{ marginBottom: 12 }}>
        <Button icon={<PlusOutlined />} onClick={() => setDrawerOpen(true)}>添加网卡</Button>
      </div>
      <Table
        dataSource={ifaces}
        columns={columns}
        rowKey="mac"
        size="small"
        pagination={false}
      />
      <Drawer title="添加网卡" open={drawerOpen} onClose={() => setDrawerOpen(false)} width={360}>
        <Form form={form} layout="vertical" onFinish={attach}>
          <Form.Item name="source" label="虚拟网络" rules={[{ required: true }]}>
            <Select placeholder="选择网络">
              {hostNets.map(n => (
                <Select.Option key={n.name} value={n.name}>
                  {n.name} ({n.forward_mode})
                </Select.Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item name="model" label="网卡型号" initialValue="virtio">
            <Select>
              <Select.Option value="virtio">virtio（推荐）</Select.Option>
              <Select.Option value="e1000">e1000</Select.Option>
              <Select.Option value="rtl8139">rtl8139</Select.Option>
            </Select>
          </Form.Item>
          {running && (
            <div style={{ color: 'var(--color-green)', fontSize: 12, marginBottom: 12 }}>
              VM 运行中，将热插拔网卡
            </div>
          )}
          <Button type="primary" htmlType="submit" loading={loading} block>添加</Button>
        </Form>
      </Drawer>
    </div>
  )
}
```

---

## Task 14: Frontend — Event log page

**Files:**
- Create: `frontend/src/pages/EventLogPage.tsx`

**Step 1: Create `frontend/src/pages/EventLogPage.tsx`**

```tsx
import { useEffect, useState } from 'react'
import { Table, Tag, Select, Typography, Space, Pagination } from 'antd'
import { CheckCircleOutlined, CloseCircleOutlined } from '@ant-design/icons'
import { eventsApi, vmApi } from '../api/client'
import type { EventLog, VMSummary } from '../types'

export default function EventLogPage() {
  const [data, setData] = useState<{ items: EventLog[]; total: number }>({ items: [], total: 0 })
  const [page, setPage] = useState(1)
  const [vmFilter, setVmFilter] = useState('')
  const [vms, setVms] = useState<VMSummary[]>([])

  useEffect(() => { vmApi.list().then(setVms).catch(() => {}) }, [])
  useEffect(() => {
    eventsApi.list(page, vmFilter).then(r => setData({ items: r.items, total: r.total })).catch(() => {})
  }, [page, vmFilter])

  const columns = [
    {
      title: 'TIME', dataIndex: 'timestamp', key: 'ts', width: 180,
      render: (v: string) => <span className="mono" style={{ fontSize: 11 }}>{v.replace('T', ' ').slice(0, 19)}</span>,
    },
    {
      title: 'VM', dataIndex: 'vm_name', key: 'vm',
      render: (v: string) => v ? <Tag style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}>{v}</Tag> : <span style={{ color: 'var(--color-text-dim)' }}>—</span>,
    },
    {
      title: 'ACTION', dataIndex: 'path', key: 'path',
      render: (v: string) => <span className="mono" style={{ fontSize: 11, color: 'var(--color-cyan)' }}>{v}</span>,
    },
    {
      title: 'METHOD', dataIndex: 'method', key: 'method',
      render: (v: string) => {
        const colors: Record<string, string> = { POST: '#00d4ff', PUT: '#7b2fff', DELETE: '#ff4d6d' }
        return <Tag style={{ background: 'transparent', border: `1px solid ${colors[v] ?? '#4a6080'}`, color: colors[v] ?? '#4a6080', fontFamily: 'var(--font-mono)', fontSize: 10 }}>{v}</Tag>
      },
    },
    {
      title: 'STATUS', dataIndex: 'success', key: 'status',
      render: (v: boolean) => v
        ? <CheckCircleOutlined style={{ color: 'var(--color-green)' }} />
        : <CloseCircleOutlined style={{ color: 'var(--color-red)' }} />,
    },
  ]

  return (
    <div>
      <div style={{ marginBottom: 20 }}>
        <Typography.Title level={4} style={{ color: 'var(--color-cyan)', margin: 0, fontFamily: 'var(--font-mono)', letterSpacing: 2 }}>
          EVENT LOG
        </Typography.Title>
      </div>
      <Space style={{ marginBottom: 12 }}>
        <Select
          allowClear
          placeholder="按 VM 筛选"
          style={{ width: 200 }}
          onChange={v => { setVmFilter(v ?? ''); setPage(1) }}
        >
          {vms.map(v => <Select.Option key={v.name} value={v.name}>{v.name}</Select.Option>)}
        </Select>
      </Space>
      <Table
        dataSource={data.items}
        columns={columns}
        rowKey={(r, i) => `${r.timestamp}-${i}`}
        size="small"
        pagination={false}
      />
      <div style={{ marginTop: 16, textAlign: 'right' }}>
        <Pagination
          current={page}
          pageSize={50}
          total={data.total}
          onChange={setPage}
          showTotal={t => `共 ${t} 条`}
          size="small"
        />
      </div>
    </div>
  )
}
```

---

## Task 15: Frontend — Templates page

**Files:**
- Create: `frontend/src/pages/TemplatesPage.tsx`

**Step 1: Create `frontend/src/pages/TemplatesPage.tsx`**

```tsx
import { useEffect, useState } from 'react'
import { Row, Col, Button, Modal, Form, Input, Select, message, Popconfirm, Typography, Tag } from 'antd'
import { PlusOutlined, CopyOutlined, DeleteOutlined } from '@ant-design/icons'
import { templateApi, vmApi } from '../api/client'
import type { Template, VMSummary } from '../types'

export default function TemplatesPage() {
  const [templates, setTemplates] = useState<Template[]>([])
  const [vms, setVms] = useState<VMSummary[]>([])
  const [createOpen, setCreateOpen] = useState(false)
  const [cloneTarget, setCloneTarget] = useState<Template | null>(null)
  const [form] = Form.useForm()
  const [cloneForm] = Form.useForm()
  const [loading, setLoading] = useState(false)

  const load = () => {
    templateApi.list().then(setTemplates).catch(() => {})
    vmApi.list().then(setVms).catch(() => {})
  }
  useEffect(() => { load() }, [])

  const createTemplate = async (values: { vm_name: string; template_name: string; description?: string }) => {
    setLoading(true)
    try {
      await templateApi.create(values)
      message.success('模板已创建')
      load(); setCreateOpen(false); form.resetFields()
    } catch (e: any) { message.error(e?.response?.data?.detail ?? '创建失败') }
    finally { setLoading(false) }
  }

  const cloneTemplate = async (values: { new_vm_name: string }) => {
    if (!cloneTarget) return
    setLoading(true)
    try {
      await templateApi.clone(cloneTarget.name, values.new_vm_name)
      message.success('VM 已从模板克隆')
      load(); setCloneTarget(null); cloneForm.resetFields()
    } catch (e: any) { message.error(e?.response?.data?.detail ?? '克隆失败') }
    finally { setLoading(false) }
  }

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 20 }}>
        <Typography.Title level={4} style={{ color: 'var(--color-cyan)', margin: 0, fontFamily: 'var(--font-mono)', letterSpacing: 2 }}>
          TEMPLATE LIBRARY
        </Typography.Title>
        <Button icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>创建模板</Button>
      </div>

      <Row gutter={[16, 16]}>
        {templates.map(t => (
          <Col key={t.name} xs={24} sm={12} md={8}>
            <div style={{
              background: 'var(--bg-card)', border: '1px solid rgba(0,212,255,0.15)',
              borderRadius: 8, padding: 16, boxShadow: 'var(--glow-cyan)',
            }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 8 }}>
                <span style={{ fontFamily: 'var(--font-mono)', fontWeight: 700, color: 'var(--color-text)' }}>{t.name}</span>
                <Tag style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}>{t.size_gb} GB</Tag>
              </div>
              <div style={{ color: 'var(--color-text-dim)', fontSize: 12, marginBottom: 4 }}>
                来源: <span className="mono">{t.source_vm}</span>
              </div>
              <div style={{ color: 'var(--color-text-dim)', fontSize: 11, marginBottom: 12 }}>
                {t.description || '—'}
              </div>
              <div style={{ color: 'var(--color-text-dim)', fontSize: 11, marginBottom: 12 }}>
                {t.created_at.slice(0, 19).replace('T', ' ')}
              </div>
              <div style={{ display: 'flex', gap: 8 }}>
                <Button size="small" icon={<CopyOutlined />} onClick={() => setCloneTarget(t)}>克隆</Button>
                <Popconfirm title="确认删除此模板？" onConfirm={async () => {
                  await templateApi.delete(t.name); message.success('已删除'); load()
                }}>
                  <Button size="small" danger icon={<DeleteOutlined />} />
                </Popconfirm>
              </div>
            </div>
          </Col>
        ))}
        {templates.length === 0 && (
          <Col span={24} style={{ color: 'var(--color-text-dim)', textAlign: 'center', padding: 40 }}>
            暂无模板，选择关机状态的 VM 创建模板
          </Col>
        )}
      </Row>

      {/* Create modal */}
      <Modal title="创建模板" open={createOpen} onCancel={() => setCreateOpen(false)} footer={null}>
        <Form form={form} layout="vertical" onFinish={createTemplate}>
          <Form.Item name="vm_name" label="选择 VM（需已关机）" rules={[{ required: true }]}>
            <Select placeholder="选择 VM">
              {vms.filter(v => v.state !== 'running').map(v => (
                <Select.Option key={v.name} value={v.name}>{v.name}</Select.Option>
              ))}
            </Select>
          </Form.Item>
          <Form.Item name="template_name" label="模板名称" rules={[{ required: true }]}>
            <Input placeholder="my-template" />
          </Form.Item>
          <Form.Item name="description" label="描述（可选）">
            <Input.TextArea rows={2} />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={loading} block>创建</Button>
        </Form>
      </Modal>

      {/* Clone modal */}
      <Modal title={`从 ${cloneTarget?.name} 克隆`} open={!!cloneTarget} onCancel={() => setCloneTarget(null)} footer={null}>
        <Form form={cloneForm} layout="vertical" onFinish={cloneTemplate}>
          <Form.Item name="new_vm_name" label="新 VM 名称" rules={[{ required: true }]}>
            <Input placeholder="new-vm-name" />
          </Form.Item>
          <Button type="primary" htmlType="submit" loading={loading} block>克隆</Button>
        </Form>
      </Modal>
    </div>
  )
}
```

---

## Task 16: Frontend — Backups page

**Files:**
- Create: `frontend/src/pages/BackupsPage.tsx`

**Step 1: Create `frontend/src/pages/BackupsPage.tsx`**

```tsx
import { useEffect, useState } from 'react'
import { Table, Button, Modal, Select, message, Popconfirm, Typography, Tag, Space } from 'antd'
import { PlusOutlined, UndoOutlined, DeleteOutlined } from '@ant-design/icons'
import { backupApi, vmApi } from '../api/client'
import type { Backup, VMSummary } from '../types'

export default function BackupsPage() {
  const [backups, setBackups] = useState<Backup[]>([])
  const [vms, setVms] = useState<VMSummary[]>([])
  const [createOpen, setCreateOpen] = useState(false)
  const [selectedVm, setSelectedVm] = useState<string>('')
  const [loading, setLoading] = useState(false)

  const load = () => {
    backupApi.list().then(setBackups).catch(() => {})
    vmApi.list().then(setVms).catch(() => {})
  }
  useEffect(() => { load() }, [])

  const createBackup = async () => {
    if (!selectedVm) return
    setLoading(true)
    try {
      await backupApi.create(selectedVm)
      message.success('备份已创建')
      load(); setCreateOpen(false); setSelectedVm('')
    } catch (e: any) { message.error(e?.response?.data?.detail ?? '备份失败') }
    finally { setLoading(false) }
  }

  const restore = async (id: string) => {
    try { await backupApi.restore(id); message.success('已恢复，VM 已重新注册'); load() }
    catch (e: any) { message.error(e?.response?.data?.detail ?? '恢复失败') }
  }

  const columns = [
    { title: 'ID', dataIndex: 'id', key: 'id', render: (v: string) => <span className="mono" style={{ fontSize: 11 }}>{v}</span> },
    { title: 'VM', dataIndex: 'vm_name', key: 'vm', render: (v: string) => <Tag style={{ fontFamily: 'var(--font-mono)', fontSize: 10 }}>{v}</Tag> },
    {
      title: 'TIME', dataIndex: 'created_at', key: 'ts',
      render: (v: string) => <span className="mono" style={{ fontSize: 11 }}>{v.replace('T', ' ').slice(0, 19)}</span>,
    },
    { title: 'SIZE', dataIndex: 'size_gb', key: 'size', render: (v: number) => <span className="mono">{v} GB</span> },
    {
      title: '操作', key: 'action',
      render: (_: unknown, row: Backup) => (
        <Space>
          <Popconfirm
            title="恢复会停止并覆盖当前 VM，确认？"
            onConfirm={() => restore(row.id)}
            okButtonProps={{ danger: true }}
          >
            <Button size="small" icon={<UndoOutlined />}>恢复</Button>
          </Popconfirm>
          <Popconfirm title="确认删除此备份？" onConfirm={async () => {
            await backupApi.delete(row.id); message.success('已删除'); load()
          }}>
            <Button size="small" danger icon={<DeleteOutlined />} />
          </Popconfirm>
        </Space>
      ),
    },
  ]

  return (
    <div>
      <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 20 }}>
        <Typography.Title level={4} style={{ color: 'var(--color-cyan)', margin: 0, fontFamily: 'var(--font-mono)', letterSpacing: 2 }}>
          BACKUP MANAGEMENT
        </Typography.Title>
        <Button icon={<PlusOutlined />} onClick={() => setCreateOpen(true)}>创建备份</Button>
      </div>

      <Table
        dataSource={backups}
        columns={columns}
        rowKey="id"
        size="small"
        pagination={{ pageSize: 20 }}
      />

      <Modal
        title="创建备份"
        open={createOpen}
        onOk={createBackup}
        onCancel={() => setCreateOpen(false)}
        confirmLoading={loading}
        okText="开始备份"
      >
        <div style={{ marginBottom: 8, color: 'var(--color-text-dim)', fontSize: 12 }}>
          备份会复制 VM 配置和所有磁盘镜像，时间取决于磁盘大小。
        </div>
        <Select
          style={{ width: '100%' }}
          placeholder="选择 VM"
          value={selectedVm || undefined}
          onChange={setSelectedVm}
        >
          {vms.map(v => <Select.Option key={v.name} value={v.name}>{v.name} ({v.state})</Select.Option>)}
        </Select>
      </Modal>
    </div>
  )
}
```

---

## Final: Build and deploy

**Step 1: Rebuild both images**
```bash
cd /Users/edy/Data/code/zbnsec/kvm
docker compose build kvm-api kvm-web
```

**Step 2: Export and transfer**
```bash
docker save kvm-kvm-api kvm-kvm-web | gzip > kvm-update.tar.gz
# Transfer kvm-update.tar.gz + docker-compose.yml to VM
```

**Step 3: VM — load and restart**
```bash
cd ~/kvm
docker load < kvm-update.tar.gz
docker-compose up -d
docker-compose ps
```

**Step 4: Verify**
- Open `http://10.70.70.172/kvm/` — should show dark cyberpunk theme, sidebar navigation
- Click a running VM → 概览 tab should show gauges and sparklines
- Check 事件日志, 模板管理, 备份管理 pages
- Test VM protection toggle + BMC warning modal
