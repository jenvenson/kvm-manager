# KVM Manager Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a lightweight KVM management web platform with FastAPI backend, React frontend, noVNC console, and snapshot management.

**Architecture:** Three Docker Compose services: `kvm-api` (FastAPI + libvirt-python, port 8000), `kvm-web` (React + Nginx, port 8080), `kvm-novnc` (websockify + noVNC, port 6080). `kvm-api` communicates with libvirt via Unix socket mount. VNC token files are shared between `kvm-api` and `kvm-novnc` via a named Docker volume. Nginx proxies `/api/*` to `kvm-api`.

**Tech Stack:** Python 3.11, FastAPI 0.111, libvirt-python, pydantic v2, lxml; React 18, TypeScript 5, Ant Design 5, Vite 5, axios; Docker Compose, Nginx, websockify, noVNC v1.4.0

---

### Task 1: Git Init and Project Structure

**Files:**
- Create: `.gitignore`

**Step 1: Init git**
```bash
git init
```

**Step 2: Create `.gitignore`**
```
__pycache__/
*.py[cod]
.venv/
.pytest_cache/
node_modules/
frontend/dist/
.env
.env.*
vnc-tokens/*.cfg
```

**Step 3: Create directories**
```bash
mkdir -p backend/app/{api,services,models}
mkdir -p frontend/src/{api,pages,components}
mkdir -p novnc
touch backend/app/__init__.py \
      backend/app/api/__init__.py \
      backend/app/services/__init__.py \
      backend/app/models/__init__.py
```

**Step 4: Commit**
```bash
git add .
git commit -m "chore: init project structure"
```

---

### Task 2: Docker Compose + noVNC Container

**Files:**
- Create: `docker-compose.yml`
- Create: `novnc/Dockerfile`

**Step 1: Write `novnc/Dockerfile`**
```dockerfile
FROM python:3.11-slim
RUN pip install --no-cache-dir websockify && \
    apt-get update && apt-get install -y --no-install-recommends wget tar && \
    mkdir /novnc && \
    wget -qO- https://github.com/novnc/noVNC/archive/refs/tags/v1.4.0.tar.gz \
      | tar xz -C /novnc --strip-components=1 && \
    apt-get purge -y wget tar && apt-get autoremove -y && rm -rf /var/lib/apt/lists/*
EXPOSE 6080
CMD ["websockify", "0.0.0.0:6080", "--web=/novnc", \
     "--token-plugin=TokenFile", "--token-source=/vnc-tokens/tokens.cfg"]
```

**Step 2: Write `docker-compose.yml`**
```yaml
version: "3.9"

services:
  kvm-api:
    build: ./backend
    ports:
      - "8000:8000"
    volumes:
      - /var/run/libvirt/libvirt.sock:/var/run/libvirt/libvirt.sock
      - /var/lib/libvirt/images:/var/lib/libvirt/images
      - vnc_tokens:/vnc-tokens
    group_add:
      - libvirt
    environment:
      - VNC_TOKEN_DIR=/vnc-tokens
      - VNC_HOST=host.docker.internal
      - NOVNC_HOST=${HOST_IP:-localhost}
      - NOVNC_PORT=6080
    extra_hosts:
      - "host.docker.internal:host-gateway"
    restart: unless-stopped

  kvm-web:
    build: ./frontend
    ports:
      - "8080:80"
    depends_on:
      - kvm-api
    restart: unless-stopped

  kvm-novnc:
    build: ./novnc
    ports:
      - "6080:6080"
    volumes:
      - vnc_tokens:/vnc-tokens
    extra_hosts:
      - "host.docker.internal:host-gateway"
    restart: unless-stopped

volumes:
  vnc_tokens:
```

**Step 3: Commit**
```bash
git add docker-compose.yml novnc/
git commit -m "chore: docker-compose and novnc container"
```

---

### Task 3: Backend Dockerfile and Requirements

**Files:**
- Create: `backend/Dockerfile`
- Create: `backend/requirements.txt`

**Step 1: Write `backend/requirements.txt`**
```
fastapi==0.111.0
uvicorn[standard]==0.29.0
libvirt-python==10.3.0
lxml==5.2.2
pydantic==2.7.1
```

**Step 2: Write `backend/Dockerfile`**
```dockerfile
FROM python:3.11-slim

RUN apt-get update && apt-get install -y --no-install-recommends \
    libvirt-dev pkg-config gcc \
    && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt

COPY . .

CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000"]
```

**Step 3: Commit**
```bash
git add backend/
git commit -m "chore: backend Dockerfile and requirements"
```

---

### Task 4: Schemas and FastAPI App Entry Point

**Files:**
- Create: `backend/app/models/schemas.py`
- Create: `backend/app/main.py`

**Step 1: Write `backend/app/models/schemas.py`**
```python
from pydantic import BaseModel
from typing import Optional


class VMSummary(BaseModel):
    name: str
    state: str
    vcpus: int
    memory_mb: int


class VMDetail(VMSummary):
    uuid: str
    autostart: bool


class CPUConfig(BaseModel):
    vcpus: int
    sockets: int
    cores: int
    threads: int


class CPUUpdate(BaseModel):
    vcpus: int
    sockets: int
    cores: int
    threads: int


class MemoryConfig(BaseModel):
    current_mb: int
    max_mb: int


class MemoryUpdate(BaseModel):
    current_mb: Optional[int] = None
    max_mb: Optional[int] = None


class DiskInfo(BaseModel):
    dev: str
    path: str
    size_gb: float
    format: str


class DiskAttach(BaseModel):
    path: Optional[str] = None
    size_gb: Optional[float] = None


class USBDevice(BaseModel):
    id: str
    vendor_id: str
    product_id: str
    name: str


class USBAttach(BaseModel):
    vendor_id: str
    product_id: str


class SnapshotInfo(BaseModel):
    name: str
    description: str
    created_at: str
    state: str


class SnapshotCreate(BaseModel):
    name: str
    description: str = ""


class ConsoleInfo(BaseModel):
    url: str
    token: str
```

**Step 2: Write `backend/app/main.py`**
```python
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from app.api import vms, cpu, memory, disk, usb, snapshots, console

app = FastAPI(title="KVM Manager API")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(vms.router, prefix="/api")
app.include_router(cpu.router, prefix="/api")
app.include_router(memory.router, prefix="/api")
app.include_router(disk.router, prefix="/api")
app.include_router(usb.router, prefix="/api")
app.include_router(snapshots.router, prefix="/api")
app.include_router(console.router, prefix="/api")
```

**Step 3: Commit**
```bash
git add backend/app/models/schemas.py backend/app/main.py
git commit -m "feat: schemas and FastAPI app entry point"
```

---

### Task 5: LibvirtService — VM Lifecycle

**Files:**
- Create: `backend/app/services/libvirt_svc.py`

**Step 1: Write the file**

```python
import libvirt
import os
import glob
import uuid
from contextlib import contextmanager
from datetime import datetime
from typing import List

from lxml import etree

DOMAIN_STATES = {
    0: "nostate", 1: "running", 2: "blocked",
    3: "paused", 4: "shutdown", 5: "shutoff",
    6: "crashed", 7: "pmsuspended",
}


@contextmanager
def _conn():
    conn = libvirt.open("qemu:///system")
    try:
        yield conn
    finally:
        conn.close()


def _state_str(domain) -> str:
    state, _ = domain.state()
    return DOMAIN_STATES.get(state, "unknown")


def list_vms() -> List[dict]:
    with _conn() as conn:
        return [
            {
                "name": d.name(),
                "state": _state_str(d),
                "vcpus": d.maxVcpus(),
                "memory_mb": d.maxMemory() // 1024,
            }
            for d in conn.listAllDomains()
        ]


def get_vm(name: str) -> dict:
    with _conn() as conn:
        d = conn.lookupByName(name)
        return {
            "name": d.name(),
            "state": _state_str(d),
            "vcpus": d.maxVcpus(),
            "memory_mb": d.maxMemory() // 1024,
            "uuid": d.UUIDString(),
            "autostart": bool(d.autostart()),
        }


def start_vm(name: str):
    with _conn() as conn:
        conn.lookupByName(name).create()


def shutdown_vm(name: str):
    with _conn() as conn:
        conn.lookupByName(name).shutdown()


def force_off_vm(name: str):
    with _conn() as conn:
        conn.lookupByName(name).destroy()
```

**Step 2: Commit**
```bash
git add backend/app/services/libvirt_svc.py
git commit -m "feat: libvirt service - VM lifecycle"
```

---

### Task 6: LibvirtService — Resources (CPU, Memory, Disk, USB, Snapshot, Console)

**Files:**
- Modify: `backend/app/services/libvirt_svc.py` (append all functions below)

**Step 1: Append CPU functions**
```python
def get_cpu_config(name: str) -> dict:
    with _conn() as conn:
        d = conn.lookupByName(name)
        xml = etree.fromstring(d.XMLDesc())
        vcpus = int(xml.findtext("vcpu") or 1)
        topo = xml.find("cpu/topology")
        return {
            "vcpus": vcpus,
            "sockets": int(topo.get("sockets", 1)) if topo is not None else 1,
            "cores": int(topo.get("cores", vcpus)) if topo is not None else vcpus,
            "threads": int(topo.get("threads", 1)) if topo is not None else 1,
        }


def set_cpu_config(name: str, vcpus: int, sockets: int, cores: int, threads: int):
    with _conn() as conn:
        d = conn.lookupByName(name)
        d.setVcpusFlags(vcpus, libvirt.VIR_DOMAIN_AFFECT_CONFIG)
        xml = etree.fromstring(d.XMLDesc(libvirt.VIR_DOMAIN_XML_INACTIVE))
        cpu_el = xml.find("cpu")
        if cpu_el is None:
            cpu_el = etree.SubElement(xml, "cpu")
        topo = cpu_el.find("topology")
        if topo is None:
            topo = etree.SubElement(cpu_el, "topology")
        topo.set("sockets", str(sockets))
        topo.set("cores", str(cores))
        topo.set("threads", str(threads))
        conn.defineXML(etree.tostring(xml, encoding="unicode"))
```

**Step 2: Append Memory functions**
```python
def get_memory_config(name: str) -> dict:
    with _conn() as conn:
        d = conn.lookupByName(name)
        info = d.info()  # [state, maxMem_kib, memory_kib, nVirtCpu, cpuTime]
        return {"current_mb": info[2] // 1024, "max_mb": info[1] // 1024}


def set_memory(name: str, current_mb: int | None, max_mb: int | None):
    with _conn() as conn:
        d = conn.lookupByName(name)
        state, _ = d.state()
        running = state == libvirt.VIR_DOMAIN_RUNNING
        if max_mb is not None:
            flags = libvirt.VIR_DOMAIN_AFFECT_CONFIG | libvirt.VIR_DOMAIN_MEM_MAXIMUM
            d.setMemoryFlags(max_mb * 1024, flags)
        if current_mb is not None:
            flags = libvirt.VIR_DOMAIN_AFFECT_CONFIG
            if running:
                flags |= libvirt.VIR_DOMAIN_AFFECT_LIVE
            d.setMemoryFlags(current_mb * 1024, flags)
```

**Step 3: Append Disk functions**
```python
def get_disks(name: str) -> List[dict]:
    with _conn() as conn:
        d = conn.lookupByName(name)
        xml = etree.fromstring(d.XMLDesc())
        disks = []
        for disk in xml.findall("devices/disk[@device='disk']"):
            src = disk.find("source")
            tgt = disk.find("target")
            driver = disk.find("driver")
            if src is None or tgt is None:
                continue
            path = src.get("file", "")
            dev = tgt.get("dev", "")
            fmt = driver.get("type", "raw") if driver is not None else "raw"
            size_gb = 0.0
            if path and os.path.exists(path):
                size_gb = round(os.stat(path).st_size / (1024 ** 3), 2)
            disks.append({"dev": dev, "path": path, "size_gb": size_gb, "format": fmt})
        return disks


def attach_disk(name: str, path: str | None, size_gb: float | None):
    import subprocess
    if path is None and size_gb is not None:
        path = f"/var/lib/libvirt/images/{name}-{os.urandom(4).hex()}.qcow2"
        subprocess.run(["qemu-img", "create", "-f", "qcow2", path, f"{size_gb}G"], check=True)
    with _conn() as conn:
        d = conn.lookupByName(name)
        xml = etree.fromstring(d.XMLDesc())
        used = {
            disk.find("target").get("dev")
            for disk in xml.findall("devices/disk[@device='disk']")
            if disk.find("target") is not None
        }
        dev = next(f"vd{c}" for c in "bcdefghijklmnop" if f"vd{c}" not in used)
        disk_xml = (
            f"<disk type='file' device='disk'>"
            f"<driver name='qemu' type='qcow2'/>"
            f"<source file='{path}'/>"
            f"<target dev='{dev}' bus='virtio'/>"
            f"</disk>"
        )
        d.attachDeviceFlags(disk_xml, libvirt.VIR_DOMAIN_AFFECT_CONFIG)


def detach_disk(name: str, dev: str):
    with _conn() as conn:
        d = conn.lookupByName(name)
        xml = etree.fromstring(d.XMLDesc())
        for disk in xml.findall("devices/disk[@device='disk']"):
            tgt = disk.find("target")
            if tgt is not None and tgt.get("dev") == dev:
                d.detachDeviceFlags(
                    etree.tostring(disk, encoding="unicode"),
                    libvirt.VIR_DOMAIN_AFFECT_CONFIG,
                )
                return
        raise ValueError(f"Disk {dev} not found")
```

**Step 4: Append USB functions**
```python
def get_host_usb() -> List[dict]:
    devices = []
    for path in glob.glob("/sys/bus/usb/devices/*/idVendor"):
        base = os.path.dirname(path)
        try:
            vendor = open(f"{base}/idVendor").read().strip()
            product = open(f"{base}/idProduct").read().strip()
            name_file = f"{base}/product"
            dev_name = open(name_file).read().strip() if os.path.exists(name_file) else f"{vendor}:{product}"
            devices.append({"id": f"{vendor}:{product}", "vendor_id": vendor, "product_id": product, "name": dev_name})
        except OSError:
            continue
    return devices


def get_vm_usb(name: str) -> List[dict]:
    with _conn() as conn:
        d = conn.lookupByName(name)
        xml = etree.fromstring(d.XMLDesc())
        devices = []
        for hostdev in xml.findall("devices/hostdev[@type='usb']"):
            src = hostdev.find("source")
            if src is None:
                continue
            v = src.find("vendor")
            p = src.find("product")
            if v is None or p is None:
                continue
            vid = v.get("id", "").replace("0x", "")
            pid = p.get("id", "").replace("0x", "")
            devices.append({"id": f"{vid}:{pid}", "vendor_id": vid, "product_id": pid, "name": f"USB {vid}:{pid}"})
        return devices


def attach_usb(name: str, vendor_id: str, product_id: str):
    with _conn() as conn:
        d = conn.lookupByName(name)
        xml = (
            f"<hostdev mode='subsystem' type='usb' managed='yes'>"
            f"<source><vendor id='0x{vendor_id}'/><product id='0x{product_id}'/></source>"
            f"</hostdev>"
        )
        d.attachDeviceFlags(xml, libvirt.VIR_DOMAIN_AFFECT_CONFIG)


def detach_usb(name: str, usb_id: str):
    vendor_id, product_id = usb_id.split(":")
    with _conn() as conn:
        d = conn.lookupByName(name)
        xml = etree.fromstring(d.XMLDesc())
        for hostdev in xml.findall("devices/hostdev[@type='usb']"):
            src = hostdev.find("source")
            if src is None:
                continue
            v = src.find("vendor")
            p = src.find("product")
            if v is None or p is None:
                continue
            if v.get("id", "").replace("0x", "") == vendor_id and p.get("id", "").replace("0x", "") == product_id:
                d.detachDeviceFlags(etree.tostring(hostdev, encoding="unicode"), libvirt.VIR_DOMAIN_AFFECT_CONFIG)
                return
        raise ValueError(f"USB {usb_id} not found")
```

**Step 5: Append Snapshot functions**
```python
def list_snapshots(name: str) -> List[dict]:
    with _conn() as conn:
        d = conn.lookupByName(name)
        result = []
        for snap in d.listAllSnapshots():
            xml = etree.fromstring(snap.getXMLDesc())
            created = xml.findtext("creationTime") or "0"
            result.append({
                "name": snap.getName(),
                "description": xml.findtext("description") or "",
                "created_at": datetime.fromtimestamp(int(created)).isoformat(),
                "state": xml.findtext("state") or "unknown",
            })
        return result


def create_snapshot(name: str, snap_name: str, description: str):
    with _conn() as conn:
        d = conn.lookupByName(name)
        snap_xml = f"<domainsnapshot><name>{snap_name}</name><description>{description}</description></domainsnapshot>"
        d.snapshotCreateXML(snap_xml, 0)


def revert_snapshot(name: str, snap_name: str):
    with _conn() as conn:
        d = conn.lookupByName(name)
        snap = d.snapshotLookupByName(snap_name)
        d.revertToSnapshot(snap)


def delete_snapshot(name: str, snap_name: str):
    with _conn() as conn:
        d = conn.lookupByName(name)
        snap = d.snapshotLookupByName(snap_name)
        snap.delete()
```

**Step 6: Append Console/VNC function**
```python
def get_console_url(name: str, vnc_host: str, novnc_host: str, novnc_port: int) -> dict:
    with _conn() as conn:
        d = conn.lookupByName(name)
        xml = etree.fromstring(d.XMLDesc())
        graphics = xml.find("devices/graphics[@type='vnc']")
        if graphics is None:
            raise ValueError("VNC not configured for this VM")
        port = graphics.get("port", "-1")
        if port == "-1":
            raise ValueError("VNC port not assigned — is the VM running?")

    token = uuid.uuid4().hex
    token_dir = os.environ.get("VNC_TOKEN_DIR", "/vnc-tokens")
    os.makedirs(token_dir, exist_ok=True)
    token_file = os.path.join(token_dir, "tokens.cfg")
    with open(token_file, "a") as f:
        f.write(f"{token}: {vnc_host}:{port}\n")

    return {
        "url": f"http://{novnc_host}:{novnc_port}/vnc.html?path=websockify&token={token}",
        "token": token,
    }
```

**Step 7: Commit**
```bash
git add backend/app/services/libvirt_svc.py
git commit -m "feat: libvirt service - all resource operations"
```

---

### Task 7: VM API Router

**Files:**
- Create: `backend/app/api/vms.py`

```python
from fastapi import APIRouter, HTTPException
import libvirt

from app.services import libvirt_svc as svc
from app.models.schemas import VMSummary, VMDetail

router = APIRouter(tags=["vms"])


def _wrap(fn, *args, **kwargs):
    try:
        return fn(*args, **kwargs)
    except libvirt.libvirtError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.get("/vms", response_model=list[VMSummary])
def list_vms():
    return _wrap(svc.list_vms)


@router.get("/vms/{name}", response_model=VMDetail)
def get_vm(name: str):
    return _wrap(svc.get_vm, name)


@router.post("/vms/{name}/start")
def start_vm(name: str):
    _wrap(svc.start_vm, name)
    return {"status": "started"}


@router.post("/vms/{name}/shutdown")
def shutdown_vm(name: str):
    _wrap(svc.shutdown_vm, name)
    return {"status": "shutdown"}


@router.post("/vms/{name}/force-off")
def force_off_vm(name: str):
    _wrap(svc.force_off_vm, name)
    return {"status": "forced off"}
```

**Commit:**
```bash
git add backend/app/api/vms.py
git commit -m "feat: VM API routes"
```

---

### Task 8: CPU and Memory API Routers

**Files:**
- Create: `backend/app/api/cpu.py`
- Create: `backend/app/api/memory.py`

**`backend/app/api/cpu.py`:**
```python
from fastapi import APIRouter, HTTPException
import libvirt

from app.services import libvirt_svc as svc
from app.models.schemas import CPUConfig, CPUUpdate

router = APIRouter(tags=["cpu"])


@router.get("/vms/{name}/cpu", response_model=CPUConfig)
def get_cpu(name: str):
    try:
        return svc.get_cpu_config(name)
    except libvirt.libvirtError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.put("/vms/{name}/cpu")
def update_cpu(name: str, body: CPUUpdate):
    try:
        svc.set_cpu_config(name, body.vcpus, body.sockets, body.cores, body.threads)
        return {"status": "updated"}
    except libvirt.libvirtError as e:
        raise HTTPException(status_code=400, detail=str(e))
```

**`backend/app/api/memory.py`:**
```python
from fastapi import APIRouter, HTTPException
import libvirt

from app.services import libvirt_svc as svc
from app.models.schemas import MemoryConfig, MemoryUpdate

router = APIRouter(tags=["memory"])


@router.get("/vms/{name}/memory", response_model=MemoryConfig)
def get_memory(name: str):
    try:
        return svc.get_memory_config(name)
    except libvirt.libvirtError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.put("/vms/{name}/memory")
def update_memory(name: str, body: MemoryUpdate):
    try:
        svc.set_memory(name, body.current_mb, body.max_mb)
        return {"status": "updated"}
    except libvirt.libvirtError as e:
        raise HTTPException(status_code=400, detail=str(e))
```

**Commit:**
```bash
git add backend/app/api/cpu.py backend/app/api/memory.py
git commit -m "feat: CPU and memory API routes"
```

---

### Task 9: Disk, USB, Snapshot, Console API Routers

**Files:**
- Create: `backend/app/api/disk.py`
- Create: `backend/app/api/usb.py`
- Create: `backend/app/api/snapshots.py`
- Create: `backend/app/api/console.py`

**`backend/app/api/disk.py`:**
```python
from fastapi import APIRouter, HTTPException
import libvirt

from app.services import libvirt_svc as svc
from app.models.schemas import DiskInfo, DiskAttach

router = APIRouter(tags=["disk"])


@router.get("/vms/{name}/disks", response_model=list[DiskInfo])
def list_disks(name: str):
    try:
        return svc.get_disks(name)
    except libvirt.libvirtError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/vms/{name}/disks")
def add_disk(name: str, body: DiskAttach):
    if body.path is None and body.size_gb is None:
        raise HTTPException(status_code=422, detail="Provide path or size_gb")
    try:
        svc.attach_disk(name, body.path, body.size_gb)
        return {"status": "attached"}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/vms/{name}/disks/{dev}")
def remove_disk(name: str, dev: str):
    try:
        svc.detach_disk(name, dev)
        return {"status": "detached"}
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except libvirt.libvirtError as e:
        raise HTTPException(status_code=400, detail=str(e))
```

**`backend/app/api/usb.py`:**
```python
from fastapi import APIRouter, HTTPException
import libvirt

from app.services import libvirt_svc as svc
from app.models.schemas import USBDevice, USBAttach

router = APIRouter(tags=["usb"])


@router.get("/host/usb", response_model=list[USBDevice])
def list_host_usb():
    return svc.get_host_usb()


@router.get("/vms/{name}/usb", response_model=list[USBDevice])
def list_vm_usb(name: str):
    try:
        return svc.get_vm_usb(name)
    except libvirt.libvirtError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/vms/{name}/usb")
def attach_usb(name: str, body: USBAttach):
    try:
        svc.attach_usb(name, body.vendor_id, body.product_id)
        return {"status": "attached"}
    except libvirt.libvirtError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/vms/{name}/usb/{usb_id}")
def detach_usb(name: str, usb_id: str):
    try:
        svc.detach_usb(name, usb_id)
        return {"status": "detached"}
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except libvirt.libvirtError as e:
        raise HTTPException(status_code=400, detail=str(e))
```

**`backend/app/api/snapshots.py`:**
```python
from fastapi import APIRouter, HTTPException
import libvirt

from app.services import libvirt_svc as svc
from app.models.schemas import SnapshotInfo, SnapshotCreate

router = APIRouter(tags=["snapshots"])


@router.get("/vms/{name}/snapshots", response_model=list[SnapshotInfo])
def list_snapshots(name: str):
    try:
        return svc.list_snapshots(name)
    except libvirt.libvirtError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/vms/{name}/snapshots")
def create_snapshot(name: str, body: SnapshotCreate):
    try:
        svc.create_snapshot(name, body.name, body.description)
        return {"status": "created"}
    except libvirt.libvirtError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/vms/{name}/snapshots/{snap}/revert")
def revert_snapshot(name: str, snap: str):
    try:
        svc.revert_snapshot(name, snap)
        return {"status": "reverted"}
    except libvirt.libvirtError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/vms/{name}/snapshots/{snap}")
def delete_snapshot(name: str, snap: str):
    try:
        svc.delete_snapshot(name, snap)
        return {"status": "deleted"}
    except libvirt.libvirtError as e:
        raise HTTPException(status_code=400, detail=str(e))
```

**`backend/app/api/console.py`:**
```python
import os
from fastapi import APIRouter, HTTPException

from app.services import libvirt_svc as svc
from app.models.schemas import ConsoleInfo

router = APIRouter(tags=["console"])

VNC_HOST = os.environ.get("VNC_HOST", "host.docker.internal")
NOVNC_HOST = os.environ.get("NOVNC_HOST", "localhost")
NOVNC_PORT = int(os.environ.get("NOVNC_PORT", "6080"))


@router.get("/vms/{name}/console", response_model=ConsoleInfo)
def get_console(name: str):
    try:
        return svc.get_console_url(name, VNC_HOST, NOVNC_HOST, NOVNC_PORT)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
```

**Commit:**
```bash
git add backend/app/api/
git commit -m "feat: disk, USB, snapshot, console API routes"
```

---

### Task 10: Frontend Scaffold

**Files:**
- Create: `frontend/package.json`
- Create: `frontend/vite.config.ts`
- Create: `frontend/tsconfig.json`
- Create: `frontend/index.html`
- Create: `frontend/src/main.tsx`
- Create: `frontend/Dockerfile`
- Create: `frontend/nginx.conf`

**`frontend/package.json`:**
```json
{
  "name": "kvm-web",
  "version": "1.0.0",
  "private": true,
  "scripts": {
    "dev": "vite",
    "build": "tsc && vite build",
    "preview": "vite preview"
  },
  "dependencies": {
    "react": "^18.3.1",
    "react-dom": "^18.3.1",
    "react-router-dom": "^6.23.1",
    "antd": "^5.18.0",
    "axios": "^1.7.2",
    "@ant-design/icons": "^5.3.7"
  },
  "devDependencies": {
    "@types/react": "^18.3.3",
    "@types/react-dom": "^18.3.0",
    "@vitejs/plugin-react": "^4.3.0",
    "typescript": "^5.4.5",
    "vite": "^5.2.12"
  }
}
```

**`frontend/vite.config.ts`:**
```typescript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: { '/api': 'http://localhost:8000' },
  },
})
```

**`frontend/tsconfig.json`:**
```json
{
  "compilerOptions": {
    "target": "ES2020",
    "lib": ["ES2020", "DOM", "DOM.Iterable"],
    "module": "ESNext",
    "moduleResolution": "bundler",
    "jsx": "react-jsx",
    "strict": true,
    "skipLibCheck": true
  },
  "include": ["src"]
}
```

**`frontend/index.html`:**
```html
<!doctype html>
<html lang="zh">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>KVM Manager</title>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/src/main.tsx"></script>
  </body>
</html>
```

**`frontend/src/main.tsx`:**
```tsx
import React from 'react'
import ReactDOM from 'react-dom/client'
import App from './App'

ReactDOM.createRoot(document.getElementById('root')!).render(
  <React.StrictMode><App /></React.StrictMode>
)
```

**`frontend/nginx.conf`:**
```nginx
server {
    listen 80;
    root /usr/share/nginx/html;
    index index.html;

    location /api/ {
        proxy_pass http://kvm-api:8000;
        proxy_set_header Host $host;
    }

    location / {
        try_files $uri $uri/ /index.html;
    }
}
```

**`frontend/Dockerfile`:**
```dockerfile
FROM node:20-slim AS builder
WORKDIR /app
COPY package.json .
RUN npm install
COPY . .
RUN npm run build

FROM nginx:alpine
COPY --from=builder /app/dist /usr/share/nginx/html
COPY nginx.conf /etc/nginx/conf.d/default.conf
```

**Commit:**
```bash
git add frontend/
git commit -m "chore: frontend scaffold"
```

---

### Task 11: Frontend Types and API Client

**Files:**
- Create: `frontend/src/types.ts`
- Create: `frontend/src/api/client.ts`

**`frontend/src/types.ts`:**
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
```

**`frontend/src/api/client.ts`:**
```typescript
import axios from 'axios'
import type { VMSummary, VMDetail, CPUConfig, MemoryConfig, DiskInfo, USBDevice, SnapshotInfo, ConsoleInfo } from '../types'

const api = axios.create({ baseURL: '/api' })

export const vmApi = {
  list: () => api.get<VMSummary[]>('/vms').then(r => r.data),
  get: (name: string) => api.get<VMDetail>(`/vms/${name}`).then(r => r.data),
  start: (name: string) => api.post(`/vms/${name}/start`),
  shutdown: (name: string) => api.post(`/vms/${name}/shutdown`),
  forceOff: (name: string) => api.post(`/vms/${name}/force-off`),
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
```

**Commit:**
```bash
git add frontend/src/types.ts frontend/src/api/
git commit -m "feat: frontend types and API client"
```

---

### Task 12: App Router

**Files:**
- Create: `frontend/src/App.tsx`

```tsx
import { BrowserRouter, Routes, Route } from 'react-router-dom'
import { ConfigProvider } from 'antd'
import zhCN from 'antd/locale/zh_CN'
import Dashboard from './pages/Dashboard'
import VMDetail from './pages/VMDetail'

export default function App() {
  return (
    <ConfigProvider locale={zhCN}>
      <BrowserRouter>
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/vm/:name" element={<VMDetail />} />
        </Routes>
      </BrowserRouter>
    </ConfigProvider>
  )
}
```

**Commit:**
```bash
git add frontend/src/App.tsx
git commit -m "feat: app router"
```

---

### Task 13: Dashboard Page

**Files:**
- Create: `frontend/src/pages/Dashboard.tsx`

```tsx
import { useEffect, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { Card, Col, Row, Badge, Button, Space, message, Layout, Typography } from 'antd'
import { PoweroffOutlined, ThunderboltOutlined, PlayCircleOutlined } from '@ant-design/icons'
import { vmApi } from '../api/client'
import type { VMSummary } from '../types'

const STATE_COLOR: Record<string, 'success' | 'error' | 'warning' | 'default'> = {
  running: 'success', shutoff: 'default', paused: 'warning', crashed: 'error',
}

export default function Dashboard() {
  const [vms, setVms] = useState<VMSummary[]>([])
  const navigate = useNavigate()

  const load = () => vmApi.list().then(setVms).catch(() => message.error('加载失败'))

  useEffect(() => {
    load()
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [])

  const action = async (fn: () => Promise<unknown>, msg: string) => {
    try { await fn(); message.success(msg); load() }
    catch { message.error('操作失败') }
  }

  return (
    <Layout style={{ minHeight: '100vh', padding: 24 }}>
      <Typography.Title level={3} style={{ marginBottom: 24 }}>KVM 管理平台</Typography.Title>
      <Row gutter={[16, 16]}>
        {vms.map(vm => (
          <Col key={vm.name} xs={24} sm={12} md={8} lg={6}>
            <Card
              hoverable
              title={<Space><Badge status={STATE_COLOR[vm.state] ?? 'default'} />{vm.name}</Space>}
              extra={<Button type="link" onClick={() => navigate(`/vm/${vm.name}`)}>详情</Button>}
            >
              <p>CPU: {vm.vcpus} vCPU &nbsp; 内存: {vm.memory_mb} MiB</p>
              <p>状态: {vm.state}</p>
              <Space>
                <Button size="small" icon={<PlayCircleOutlined />} disabled={vm.state === 'running'}
                  onClick={() => action(() => vmApi.start(vm.name), '已启动')}>启动</Button>
                <Button size="small" icon={<PoweroffOutlined />} disabled={vm.state !== 'running'}
                  onClick={() => action(() => vmApi.shutdown(vm.name), '已发送关机')}>关机</Button>
                <Button size="small" danger icon={<ThunderboltOutlined />} disabled={vm.state !== 'running'}
                  onClick={() => action(() => vmApi.forceOff(vm.name), '已强制关机')}>强制</Button>
              </Space>
            </Card>
          </Col>
        ))}
      </Row>
    </Layout>
  )
}
```

**Commit:**
```bash
git add frontend/src/pages/Dashboard.tsx
git commit -m "feat: Dashboard page"
```

---

### Task 14: VMDetail Page

**Files:**
- Create: `frontend/src/pages/VMDetail.tsx`

```tsx
import { useEffect, useState } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { Layout, Typography, Space, Button, Badge, Tabs, message, Breadcrumb } from 'antd'
import { ArrowLeftOutlined, PlayCircleOutlined, PoweroffOutlined, ThunderboltOutlined, DesktopOutlined } from '@ant-design/icons'
import { vmApi, consoleApi } from '../api/client'
import type { VMDetail } from '../types'
import CPUPanel from '../components/CPUPanel'
import MemoryPanel from '../components/MemoryPanel'
import DiskPanel from '../components/DiskPanel'
import USBPanel from '../components/USBPanel'
import SnapshotPanel from '../components/SnapshotPanel'

const STATE_COLOR: Record<string, 'success' | 'error' | 'warning' | 'default'> = {
  running: 'success', shutoff: 'default', paused: 'warning', crashed: 'error',
}

export default function VMDetailPage() {
  const { name } = useParams<{ name: string }>()
  const navigate = useNavigate()
  const [vm, setVm] = useState<VMDetail | null>(null)

  const load = () => { if (name) vmApi.get(name).then(setVm).catch(() => message.error('加载失败')) }

  useEffect(() => {
    load()
    const t = setInterval(load, 5000)
    return () => clearInterval(t)
  }, [name])

  const action = async (fn: () => Promise<unknown>, msg: string) => {
    try { await fn(); message.success(msg); load() }
    catch { message.error('操作失败') }
  }

  const openConsole = async () => {
    if (!name) return
    try {
      const info = await consoleApi.getUrl(name)
      window.open(info.url, '_blank')
    } catch {
      message.error('获取控制台失败，请确认 VM 正在运行且已启用 VNC')
    }
  }

  if (!vm || !name) return null
  const running = vm.state === 'running'

  return (
    <Layout style={{ minHeight: '100vh', padding: 24 }}>
      <Breadcrumb items={[{ title: <a onClick={() => navigate('/')}>首页</a> }, { title: vm.name }]} style={{ marginBottom: 16 }} />
      <Space style={{ marginBottom: 16 }} wrap>
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate('/')}>返回</Button>
        <Typography.Title level={4} style={{ margin: 0 }}>
          <Badge status={STATE_COLOR[vm.state] ?? 'default'} /> {vm.name}
        </Typography.Title>
        <Button icon={<PlayCircleOutlined />} disabled={running}
          onClick={() => action(() => vmApi.start(name), '已启动')}>启动</Button>
        <Button icon={<PoweroffOutlined />} disabled={!running}
          onClick={() => action(() => vmApi.shutdown(name), '已发送关机')}>关机</Button>
        <Button icon={<ThunderboltOutlined />} danger disabled={!running}
          onClick={() => action(() => vmApi.forceOff(name), '已强制关机')}>强制关机</Button>
        <Button icon={<DesktopOutlined />} disabled={!running} onClick={openConsole}>控制台</Button>
      </Space>
      <Tabs items={[
        { key: 'cpu', label: 'CPU', children: <CPUPanel name={name} running={running} /> },
        { key: 'memory', label: '内存', children: <MemoryPanel name={name} running={running} /> },
        { key: 'disk', label: '磁盘', children: <DiskPanel name={name} /> },
        { key: 'usb', label: 'USB', children: <USBPanel name={name} /> },
        { key: 'snapshots', label: '快照', children: <SnapshotPanel name={name} /> },
      ]} />
    </Layout>
  )
}
```

**Commit:**
```bash
git add frontend/src/pages/VMDetail.tsx
git commit -m "feat: VMDetail page"
```

---

### Task 15: CPUPanel and MemoryPanel

**Files:**
- Create: `frontend/src/components/CPUPanel.tsx`
- Create: `frontend/src/components/MemoryPanel.tsx`

**`CPUPanel.tsx`:**
```tsx
import { useEffect, useState } from 'react'
import { Form, InputNumber, Button, message, Alert } from 'antd'
import { cpuApi } from '../api/client'
import type { CPUConfig } from '../types'

export default function CPUPanel({ name, running }: { name: string; running: boolean }) {
  const [form] = Form.useForm<CPUConfig>()
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    cpuApi.get(name).then(d => form.setFieldsValue(d)).catch(() => message.error('加载 CPU 配置失败'))
  }, [name])

  const submit = async (values: CPUConfig) => {
    setLoading(true)
    try { await cpuApi.update(name, values); message.success('CPU 配置已更新') }
    catch { message.error('更新失败') }
    finally { setLoading(false) }
  }

  return (
    <>
      {running && <Alert message="CPU 配置只能在关机状态下修改" type="warning" style={{ marginBottom: 16 }} />}
      <Form form={form} onFinish={submit} layout="vertical" style={{ maxWidth: 400 }}>
        <Form.Item name="vcpus" label="vCPU 数量" rules={[{ required: true }]}>
          <InputNumber min={1} max={64} disabled={running} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="sockets" label="Sockets" rules={[{ required: true }]}>
          <InputNumber min={1} disabled={running} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="cores" label="Cores" rules={[{ required: true }]}>
          <InputNumber min={1} disabled={running} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="threads" label="Threads" rules={[{ required: true }]}>
          <InputNumber min={1} disabled={running} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item>
          <Button type="primary" htmlType="submit" loading={loading} disabled={running}>应用</Button>
        </Form.Item>
      </Form>
    </>
  )
}
```

**`MemoryPanel.tsx`:**
```tsx
import { useEffect, useState } from 'react'
import { Form, InputNumber, Button, message, Alert } from 'antd'
import { memoryApi } from '../api/client'
import type { MemoryConfig } from '../types'

export default function MemoryPanel({ name, running }: { name: string; running: boolean }) {
  const [form] = Form.useForm<MemoryConfig>()
  const [loading, setLoading] = useState(false)

  useEffect(() => {
    memoryApi.get(name).then(d => form.setFieldsValue(d)).catch(() => message.error('加载内存配置失败'))
  }, [name])

  const submit = async (values: MemoryConfig) => {
    setLoading(true)
    try {
      const payload: Partial<MemoryConfig> = { current_mb: values.current_mb }
      if (!running) payload.max_mb = values.max_mb
      await memoryApi.update(name, payload)
      message.success('内存配置已更新')
    } catch { message.error('更新失败') }
    finally { setLoading(false) }
  }

  return (
    <>
      {running && <Alert message="运行中只能修改 current 内存，max 内存需关机后修改" type="info" style={{ marginBottom: 16 }} />}
      <Form form={form} onFinish={submit} layout="vertical" style={{ maxWidth: 400 }}>
        <Form.Item name="current_mb" label="当前内存 (MiB)" rules={[{ required: true }]}>
          <InputNumber min={128} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item name="max_mb" label="最大内存 (MiB)" rules={[{ required: true }]}>
          <InputNumber min={128} disabled={running} style={{ width: '100%' }} />
        </Form.Item>
        <Form.Item>
          <Button type="primary" htmlType="submit" loading={loading}>应用</Button>
        </Form.Item>
      </Form>
    </>
  )
}
```

**Commit:**
```bash
git add frontend/src/components/CPUPanel.tsx frontend/src/components/MemoryPanel.tsx
git commit -m "feat: CPUPanel and MemoryPanel components"
```

---

### Task 16: DiskPanel and USBPanel

**Files:**
- Create: `frontend/src/components/DiskPanel.tsx`
- Create: `frontend/src/components/USBPanel.tsx`

**`DiskPanel.tsx`:**
```tsx
import { useEffect, useState } from 'react'
import { Table, Button, Drawer, Form, Input, InputNumber, Space, Popconfirm, message } from 'antd'
import { PlusOutlined } from '@ant-design/icons'
import { diskApi } from '../api/client'
import type { DiskInfo } from '../types'

export default function DiskPanel({ name }: { name: string }) {
  const [disks, setDisks] = useState<DiskInfo[]>([])
  const [open, setOpen] = useState(false)
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)

  const load = () => diskApi.list(name).then(setDisks).catch(() => message.error('加载磁盘失败'))
  useEffect(() => { load() }, [name])

  const attach = async (values: { path?: string; size_gb?: number }) => {
    setLoading(true)
    try { await diskApi.attach(name, values); message.success('磁盘已挂载'); setOpen(false); form.resetFields(); load() }
    catch { message.error('挂载失败') }
    finally { setLoading(false) }
  }

  const detach = async (dev: string) => {
    try { await diskApi.detach(name, dev); message.success('磁盘已移除'); load() }
    catch { message.error('移除失败') }
  }

  const cols = [
    { title: '设备', dataIndex: 'dev' },
    { title: '路径', dataIndex: 'path', ellipsis: true },
    { title: '大小 (GB)', dataIndex: 'size_gb' },
    { title: '格式', dataIndex: 'format' },
    { title: '操作', render: (_: unknown, r: DiskInfo) => (
      <Popconfirm title="确认移除此磁盘？" onConfirm={() => detach(r.dev)}>
        <Button danger size="small">移除</Button>
      </Popconfirm>
    )},
  ]

  return (
    <>
      <Button icon={<PlusOutlined />} onClick={() => setOpen(true)} style={{ marginBottom: 16 }}>添加磁盘</Button>
      <Table dataSource={disks} columns={cols} rowKey="dev" pagination={false} />
      <Drawer title="添加磁盘" open={open} onClose={() => setOpen(false)} width={400}>
        <Form form={form} onFinish={attach} layout="vertical">
          <Form.Item name="path" label="已有镜像路径"><Input placeholder="/var/lib/libvirt/images/disk.qcow2" /></Form.Item>
          <Form.Item name="size_gb" label="或新建大小 (GB)"><InputNumber min={1} style={{ width: '100%' }} /></Form.Item>
          <Form.Item>
            <Space>
              <Button type="primary" htmlType="submit" loading={loading}>挂载</Button>
              <Button onClick={() => setOpen(false)}>取消</Button>
            </Space>
          </Form.Item>
        </Form>
      </Drawer>
    </>
  )
}
```

**`USBPanel.tsx`:**
```tsx
import { useEffect, useState } from 'react'
import { Table, Button, Drawer, List, Popconfirm, message } from 'antd'
import { PlusOutlined } from '@ant-design/icons'
import { usbApi } from '../api/client'
import type { USBDevice } from '../types'

export default function USBPanel({ name }: { name: string }) {
  const [vmUsb, setVmUsb] = useState<USBDevice[]>([])
  const [hostUsb, setHostUsb] = useState<USBDevice[]>([])
  const [open, setOpen] = useState(false)

  const load = () => usbApi.listVm(name).then(setVmUsb).catch(() => message.error('加载 USB 失败'))
  useEffect(() => { load() }, [name])

  const openDrawer = () => {
    usbApi.listHost().then(setHostUsb).catch(() => message.error('加载宿主机 USB 失败'))
    setOpen(true)
  }

  const attach = async (d: USBDevice) => {
    try { await usbApi.attach(name, { vendor_id: d.vendor_id, product_id: d.product_id }); message.success('USB 已挂载'); setOpen(false); load() }
    catch { message.error('挂载失败') }
  }

  const detach = async (id: string) => {
    try { await usbApi.detach(name, id); message.success('USB 已移除'); load() }
    catch { message.error('移除失败') }
  }

  const cols = [
    { title: '设备', dataIndex: 'name' },
    { title: 'ID', dataIndex: 'id' },
    { title: '操作', render: (_: unknown, r: USBDevice) => (
      <Popconfirm title="确认卸载此 USB？" onConfirm={() => detach(r.id)}>
        <Button danger size="small">卸载</Button>
      </Popconfirm>
    )},
  ]

  return (
    <>
      <Button icon={<PlusOutlined />} onClick={openDrawer} style={{ marginBottom: 16 }}>挂载 USB</Button>
      <Table dataSource={vmUsb} columns={cols} rowKey="id" pagination={false} />
      <Drawer title="选择 USB 设备" open={open} onClose={() => setOpen(false)} width={400}>
        <List dataSource={hostUsb} renderItem={item => (
          <List.Item actions={[<Button size="small" onClick={() => attach(item)}>挂载</Button>]}>
            <List.Item.Meta title={item.name} description={item.id} />
          </List.Item>
        )} />
      </Drawer>
    </>
  )
}
```

**Commit:**
```bash
git add frontend/src/components/DiskPanel.tsx frontend/src/components/USBPanel.tsx
git commit -m "feat: DiskPanel and USBPanel components"
```

---

### Task 17: SnapshotPanel

**Files:**
- Create: `frontend/src/components/SnapshotPanel.tsx`

```tsx
import { useEffect, useState } from 'react'
import { Table, Button, Modal, Form, Input, Popconfirm, message, Space } from 'antd'
import { PlusOutlined } from '@ant-design/icons'
import { snapshotApi } from '../api/client'
import type { SnapshotInfo } from '../types'

export default function SnapshotPanel({ name }: { name: string }) {
  const [snaps, setSnaps] = useState<SnapshotInfo[]>([])
  const [open, setOpen] = useState(false)
  const [form] = Form.useForm()
  const [loading, setLoading] = useState(false)

  const load = () => snapshotApi.list(name).then(setSnaps).catch(() => message.error('加载快照失败'))
  useEffect(() => { load() }, [name])

  const create = async (values: { name: string; description?: string }) => {
    setLoading(true)
    try { await snapshotApi.create(name, values); message.success('快照已创建'); setOpen(false); form.resetFields(); load() }
    catch { message.error('创建失败') }
    finally { setLoading(false) }
  }

  const revert = async (snap: string) => {
    try { await snapshotApi.revert(name, snap); message.success('已还原，VM 将重启'); load() }
    catch { message.error('还原失败') }
  }

  const del = async (snap: string) => {
    try { await snapshotApi.delete(name, snap); message.success('快照已删除'); load() }
    catch { message.error('删除失败') }
  }

  const cols = [
    { title: '名称', dataIndex: 'name' },
    { title: '描述', dataIndex: 'description' },
    { title: '创建时间', dataIndex: 'created_at' },
    { title: '状态', dataIndex: 'state' },
    { title: '操作', render: (_: unknown, r: SnapshotInfo) => (
      <Space>
        <Popconfirm title="还原到此快照？VM 将重启。" onConfirm={() => revert(r.name)}>
          <Button size="small">还原</Button>
        </Popconfirm>
        <Popconfirm title="确认删除此快照？" onConfirm={() => del(r.name)}>
          <Button danger size="small">删除</Button>
        </Popconfirm>
      </Space>
    )},
  ]

  return (
    <>
      <Button icon={<PlusOutlined />} onClick={() => setOpen(true)} style={{ marginBottom: 16 }}>创建快照</Button>
      <Table dataSource={snaps} columns={cols} rowKey="name" pagination={false} />
      <Modal title="创建快照" open={open} onCancel={() => setOpen(false)} footer={null}>
        <Form form={form} onFinish={create} layout="vertical">
          <Form.Item name="name" label="快照名称" rules={[{ required: true }]}><Input /></Form.Item>
          <Form.Item name="description" label="描述"><Input.TextArea rows={2} /></Form.Item>
          <Form.Item>
            <Space>
              <Button type="primary" htmlType="submit" loading={loading}>创建</Button>
              <Button onClick={() => setOpen(false)}>取消</Button>
            </Space>
          </Form.Item>
        </Form>
      </Modal>
    </>
  )
}
```

**Commit:**
```bash
git add frontend/src/components/SnapshotPanel.tsx
git commit -m "feat: SnapshotPanel component"
```

---

### Task 18: Integration Verification

**Step 1: Verify git log**
```bash
git log --oneline
```
Expected: 17 commits ending at "feat: SnapshotPanel component"

**Step 2: Verify all files exist**
```bash
find . -type f | grep -v '.git' | grep -v node_modules | sort
```

**Step 3: Build frontend (type-check)**
```bash
cd frontend && npm install && npm run build
```
Expected: `dist/` created, no TypeScript errors.

**Step 4: Start stack on KVM host**
```bash
docker compose up -d
```

**Step 5: Verify services**
```bash
docker compose ps
# All three services: Up
curl http://localhost:8000/api/vms
# Returns JSON list of VMs
```

Access:
- Web UI: `http://localhost:8080`
- API docs: `http://localhost:8000/docs`
- Console (via UI button when VM running)
