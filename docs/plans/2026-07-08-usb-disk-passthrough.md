# USB Disk Passthrough Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Replace the existing USB hostdev tab with a "USB直通盘" feature that passes through host USB block devices to VMs via virtio-scsi, with auto device assignment, GA-based mount checking before detach, and offline device status tracking.

**Architecture:** Backend adds `usb_disk.py` API + service functions to list host USB block devices (via `/sys/block/` sysfs path traversal to detect USB ancestry), attach/detach via libvirt with auto virtio-scsi controller injection, and GA mount safety check before detach. Frontend replaces `USBPanel` with `UsbDiskPanel` showing host disks and VM-attached disks in one view. No docker-compose changes needed — `/sys` is already accessible in the container.

**Tech Stack:** FastAPI + libvirt-python (backend), React 18 + TypeScript + Ant Design (frontend), `/sys/block/` sysfs for USB block device detection (no extra mounts required).

**Key constraints:**
- No tests required — verify by running the service and checking responses
- Frontend base path `/kvm/`, axios baseURL `/kvm/api`
- libvirt socket path: `libvirt-sock` (not `libvirt.sock`)
- Persistent data to `/app/data/`, backend in Docker

---

## Task 1: Add backend schemas for USB disk passthrough

**Files:**
- Modify: `backend/app/models/schemas.py`

**Step 1: Add three new schema classes after the existing `USBAttach` class**

```python
class HostUsbDisk(BaseModel):
    dev: str          # /dev/sdb
    name: str         # Samsung T7
    size_gb: float


class UsbDiskAttach(BaseModel):
    host_dev: str     # /dev/sdb
    persistent: bool = True


class UsbDiskInfo(BaseModel):
    dev: str          # target inside VM, e.g. sdb
    host_dev: str     # source on host, e.g. /dev/sdb
    name: str         # model name
    size_gb: float
    status: str       # "online" | "offline"
```

**Step 2: Commit**

```bash
git add backend/app/models/schemas.py
git commit -m "feat: add HostUsbDisk, UsbDiskAttach, UsbDiskInfo schemas"
```

---

## Task 3: Backend service — list host USB block devices

**Files:**
- Modify: `backend/app/services/libvirt_svc.py`

**Step 1: Add `_is_usb_dev()` helper and `get_host_usb_disks()` after `get_host_usb()`**

```python
def _is_usb_dev(dev_name: str) -> bool:
    """Check if a block device (e.g. 'sdb') is USB-connected via sysfs path."""
    from pathlib import Path
    sys_dev = Path(f"/sys/block/{dev_name}/device")
    if not sys_dev.exists():
        return False
    try:
        return "usb" in str(sys_dev.resolve())
    except OSError:
        return False


def get_host_usb_disks() -> List[dict]:
    from pathlib import Path
    results = []
    sys_block = Path("/sys/block")
    if not sys_block.exists():
        return results
    for dev_path in sorted(sys_block.iterdir()):
        dev_name = dev_path.name
        if not _is_usb_dev(dev_name):
            continue
        size_bytes = 0
        try:
            size_bytes = int((dev_path / "size").read_text().strip()) * 512
        except (ValueError, OSError):
            pass
        model = ""
        try:
            model_path = dev_path / "device" / "model"
            if model_path.exists():
                model = model_path.read_text().strip()
        except OSError:
            pass
        results.append({
            "dev": f"/dev/{dev_name}",
            "name": model or dev_name,
            "size_gb": round(size_bytes / (1024 ** 3), 1),
        })
    return results
```

**Step 3: Commit**

```bash
git add backend/app/services/libvirt_svc.py
git commit -m "feat: add get_host_usb_disks service and _is_usb_dev helper"
```

---

## Task 4: Backend service — list VM attached USB disks

**Files:**
- Modify: `backend/app/services/libvirt_svc.py`

**Step 1: Add `get_vm_usb_disks()` after `get_host_usb_disks()`**

```python
def get_vm_usb_disks(name: str) -> List[dict]:
    from pathlib import Path

    def _dev_exists(dev_name: str) -> bool:
        return Path(f"/sys/block/{dev_name}").exists()

    def _model_of(dev_name: str) -> str:
        p = Path(f"/sys/block/{dev_name}/device/model")
        try:
            return p.read_text().strip() if p.exists() else ""
        except OSError:
            return ""

    def _size_of(dev_name: str) -> float:
        p = Path(f"/sys/block/{dev_name}/size")
        try:
            return round(int(p.read_text().strip()) * 512 / (1024 ** 3), 1) if p.exists() else 0.0
        except (ValueError, OSError):
            return 0.0

    with _conn() as conn:
        d = conn.lookupByName(name)
        xml = etree.fromstring(d.XMLDesc())
        results = []
        for disk in xml.findall("devices/disk[@type='block'][@device='disk']"):
            src = disk.find("source")
            tgt = disk.find("target")
            if src is None or tgt is None:
                continue
            host_dev = src.get("dev", "")
            if not host_dev or tgt.get("bus") != "scsi":
                continue
            target_dev = tgt.get("dev", "")
            host_dev_name = os.path.basename(host_dev)
            online = _dev_exists(host_dev_name)
            results.append({
                "dev": target_dev,
                "host_dev": host_dev,
                "name": _model_of(host_dev_name) if online else host_dev_name,
                "size_gb": _size_of(host_dev_name) if online else 0.0,
                "status": "online" if online else "offline",
            })
        return results
```

**Step 2: Commit**

```bash
git add backend/app/services/libvirt_svc.py
git commit -m "feat: add get_vm_usb_disks service"
```

---

## Task 5: Backend service — attach USB disk

**Files:**
- Modify: `backend/app/services/libvirt_svc.py`

**Step 1: Add two helpers before `attach_usb_disk()`**

```python
def _ensure_virtio_scsi_ctrl(dom) -> None:
    xml = etree.fromstring(dom.XMLDesc())
    if xml.find("devices/controller[@type='scsi'][@model='virtio-scsi']") is not None:
        return
    ctrl_xml = "<controller type='scsi' model='virtio-scsi' index='0'/>"
    flags = libvirt.VIR_DOMAIN_AFFECT_CONFIG
    if dom.isActive():
        flags |= libvirt.VIR_DOMAIN_AFFECT_LIVE
    dom.attachDeviceFlags(ctrl_xml, flags)


def _next_scsi_dev(xml_tree) -> str:
    used = {
        disk.find("target").get("dev", "")
        for disk in xml_tree.findall("devices/disk[@device='disk']")
        if disk.find("target") is not None
    }
    for c in "abcdefghijklmnopqrstuvwxyz":
        name = f"sd{c}"
        if name not in used:
            return name
    raise ValueError("No available SCSI device names")
```

**Step 2: Add `attach_usb_disk()` after the helpers**

```python
def attach_usb_disk(name: str, host_dev: str, persistent: bool) -> str:
    with _conn() as conn:
        dom = conn.lookupByName(name)
        _ensure_virtio_scsi_ctrl(dom)
        xml = etree.fromstring(dom.XMLDesc())
        target_dev = _next_scsi_dev(xml)
        disk_xml = (
            f"<disk type='block' device='disk'>"
            f"<driver name='qemu' type='raw'/>"
            f"<source dev='{host_dev}'/>"
            f"<target dev='{target_dev}' bus='scsi'/>"
            f"</disk>"
        )
        flags = libvirt.VIR_DOMAIN_AFFECT_CONFIG if persistent else 0
        if dom.isActive():
            flags |= libvirt.VIR_DOMAIN_AFFECT_LIVE
        dom.attachDeviceFlags(disk_xml, flags)
        return target_dev
```

**Step 3: Commit**

```bash
git add backend/app/services/libvirt_svc.py
git commit -m "feat: add attach_usb_disk service with virtio-scsi controller injection"
```

---

## Task 6: Backend service — detach USB disk with GA check

**Files:**
- Modify: `backend/app/services/libvirt_svc.py`

**Step 1: Add `_ga_check_mounted()` helper**

```python
def _ga_check_mounted(dom, target_dev: str) -> tuple[bool, bool]:
    """Returns (ga_available, is_mounted). Checks /proc/mounts inside VM."""
    import json, time
    try:
        cmd = json.dumps({
            "execute": "guest-exec",
            "arguments": {
                "path": "/bin/grep",
                "arg": [f"/dev/{target_dev}", "/proc/mounts"],
                "capture-output": True,
            },
        })
        result = json.loads(dom.qemuAgentCommand(cmd, 5, 0))
        pid = result["return"]["pid"]
        time.sleep(0.3)
        status_cmd = json.dumps({"execute": "guest-exec-status", "arguments": {"pid": pid}})
        status = json.loads(dom.qemuAgentCommand(status_cmd, 5, 0))
        exit_code = status["return"].get("exitcode", 1)
        return True, exit_code == 0
    except libvirt.libvirtError:
        return False, False
```

**Step 2: Add `detach_usb_disk()` after the GA helper**

```python
def detach_usb_disk(name: str, dev: str, force: bool = False) -> dict:
    """
    Returns dict with keys: success, ga_available, mounted
    If ga_available=False and force=False, caller should prompt user to confirm.
    If mounted=True, detach is blocked.
    """
    with _conn() as conn:
        dom = conn.lookupByName(name)
        xml = etree.fromstring(dom.XMLDesc())

        target_disk = None
        for disk in xml.findall("devices/disk[@type='block'][@device='disk']"):
            tgt = disk.find("target")
            if tgt is not None and tgt.get("dev") == dev and tgt.get("bus") == "scsi":
                target_disk = disk
                break
        if target_disk is None:
            raise ValueError(f"USB disk {dev} not found in VM {name}")

        ga_available, mounted = _ga_check_mounted(dom, dev)

        if mounted:
            return {"success": False, "ga_available": True, "mounted": True}

        if not ga_available and not force:
            return {"success": False, "ga_available": False, "mounted": False}

        flags = libvirt.VIR_DOMAIN_AFFECT_CONFIG
        if dom.isActive():
            flags |= libvirt.VIR_DOMAIN_AFFECT_LIVE
        dom.detachDeviceFlags(etree.tostring(target_disk, encoding="unicode"), flags)
        return {"success": True, "ga_available": ga_available, "mounted": False}
```

**Step 3: Commit**

```bash
git add backend/app/services/libvirt_svc.py
git commit -m "feat: add detach_usb_disk with GA mount check"
```

---

## Task 7: Backend API router — usb_disk.py

**Files:**
- Create: `backend/app/api/usb_disk.py`

**Step 1: Create the file**

```python
from fastapi import APIRouter, HTTPException, Query
import libvirt

from app.services import libvirt_svc as svc
from app.models.schemas import HostUsbDisk, UsbDiskAttach, UsbDiskInfo

router = APIRouter(tags=["usb-disk"])


@router.get("/host/usb-disks", response_model=list[HostUsbDisk])
def list_host_usb_disks():
    return svc.get_host_usb_disks()


@router.get("/vms/{name}/usb-disks", response_model=list[UsbDiskInfo])
def list_vm_usb_disks(name: str):
    try:
        return svc.get_vm_usb_disks(name)
    except libvirt.libvirtError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/vms/{name}/usb-disks")
def attach_usb_disk(name: str, body: UsbDiskAttach):
    try:
        target_dev = svc.attach_usb_disk(name, body.host_dev, body.persistent)
        return {"status": "attached", "target_dev": target_dev}
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except libvirt.libvirtError as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/vms/{name}/usb-disks/{dev}")
def detach_usb_disk(name: str, dev: str, force: bool = Query(default=False)):
    try:
        result = svc.detach_usb_disk(name, dev, force=force)
        if result["mounted"]:
            raise HTTPException(status_code=409, detail="设备在虚拟机内仍有挂载，请先执行 umount")
        if not result["ga_available"] and not force:
            return {"status": "ga_unavailable", "message": "无法检测挂载状态，请确认已在 VM 内 umount"}
        return {"status": "detached"}
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
    except libvirt.libvirtError as e:
        raise HTTPException(status_code=400, detail=str(e))
```

**Step 2: Commit**

```bash
git add backend/app/api/usb_disk.py
git commit -m "feat: add usb_disk API router"
```

---

## Task 8: Wire usb_disk router into main.py, remove old USB router

**Files:**
- Modify: `backend/app/main.py`

**Step 1: Replace `usb` with `usb_disk` in imports and router list**

Change line 3 from:
```python
from app.api import vms, cpu, memory, disk, usb, snapshots, console
```
to:
```python
from app.api import vms, cpu, memory, disk, usb_disk, snapshots, console
```

Change line 17 from:
```python
for router in [vms, cpu, memory, disk, usb, snapshots, console,
```
to:
```python
for router in [vms, cpu, memory, disk, usb_disk, snapshots, console,
```

**Step 2: Commit**

```bash
git add backend/app/main.py
git commit -m "feat: register usb_disk router, remove old usb router"
```

---

## Task 9: Frontend — add types for USB disk passthrough

**Files:**
- Modify: `frontend/src/types.ts`

**Step 1: Replace `USBDevice` with new types, keep it for reference only if used elsewhere**

Add after `export interface USBDevice ...`:

```typescript
export interface HostUsbDisk {
  dev: string       // /dev/sdb
  name: string      // Samsung T7
  size_gb: number
}

export interface UsbDiskInfo {
  dev: string       // target in VM, e.g. sdb
  host_dev: string  // /dev/sdb
  name: string
  size_gb: number
  status: 'online' | 'offline'
}
```

**Step 2: Commit**

```bash
git add frontend/src/types.ts
git commit -m "feat: add HostUsbDisk and UsbDiskInfo types"
```

---

## Task 10: Frontend — add usbDiskApi to client.ts

**Files:**
- Modify: `frontend/src/api/client.ts`

**Step 1: Add import for new types**

Add `HostUsbDisk, UsbDiskInfo` to the type import line.

**Step 2: Add `usbDiskApi` after `usbApi`**

```typescript
export const usbDiskApi = {
  listHost: () =>
    api.get<HostUsbDisk[]>('/host/usb-disks').then(r => r.data),
  listVm: (name: string) =>
    api.get<UsbDiskInfo[]>(`/vms/${name}/usb-disks`).then(r => r.data),
  attach: (name: string, data: { host_dev: string; persistent: boolean }) =>
    api.post(`/vms/${name}/usb-disks`, data),
  detach: (name: string, dev: string, force = false) =>
    api.delete(`/vms/${name}/usb-disks/${dev}`, { params: { force } }),
}
```

**Step 3: Commit**

```bash
git add frontend/src/api/client.ts
git commit -m "feat: add usbDiskApi to API client"
```

---

## Task 11: Frontend — create UsbDiskPanel component

**Files:**
- Create: `frontend/src/components/UsbDiskPanel.tsx`

**Step 1: Create the component**

```tsx
import { useEffect, useState } from 'react'
import {
  Button, Table, Tag, Popconfirm, Modal, Radio, Space, message, Divider, Tooltip,
} from 'antd'
import { ReloadOutlined } from '@ant-design/icons'
import { usbDiskApi } from '../api/client'
import type { HostUsbDisk, UsbDiskInfo } from '../types'

export default function UsbDiskPanel({ name }: { name: string }) {
  const [hostDisks, setHostDisks] = useState<HostUsbDisk[]>([])
  const [vmDisks, setVmDisks] = useState<UsbDiskInfo[]>([])
  const [loadingHost, setLoadingHost] = useState(false)
  const [attachingDev, setAttachingDev] = useState<string | null>(null)
  const [persistent, setPersistent] = useState(true)
  const [gaModal, setGaModal] = useState<{ dev: string } | null>(null)

  const loadVm = () =>
    usbDiskApi.listVm(name).then(setVmDisks).catch(() => message.error('加载已挂载磁盘失败'))

  const loadHost = () => {
    setLoadingHost(true)
    usbDiskApi.listHost()
      .then(setHostDisks)
      .catch(() => message.error('加载宿主机 USB 磁盘失败'))
      .finally(() => setLoadingHost(false))
  }

  useEffect(() => { loadVm(); loadHost() }, [name])

  const attach = async (disk: HostUsbDisk) => {
    setAttachingDev(disk.dev)
    try {
      await usbDiskApi.attach(name, { host_dev: disk.dev, persistent })
      message.success(`已挂载 ${disk.name} 到 VM`)
      loadVm()
    } catch {
      message.error('挂载失败')
    } finally {
      setAttachingDev(null)
    }
  }

  const detach = async (dev: string, force = false) => {
    try {
      const res = await usbDiskApi.detach(name, dev, force)
      const data = res.data as { status: string; message?: string }
      if (data.status === 'ga_unavailable') {
        setGaModal({ dev })
        return
      }
      message.success('已解挂')
      loadVm()
    } catch (e: unknown) {
      const err = e as { response?: { data?: { detail?: string } } }
      message.error(err?.response?.data?.detail || '解挂失败')
    }
  }

  const forceDetach = async () => {
    if (!gaModal) return
    await detach(gaModal.dev, true)
    setGaModal(null)
    loadVm()
  }

  const hostCols = [
    { title: '设备', dataIndex: 'dev', width: 120 },
    { title: '型号', dataIndex: 'name' },
    { title: '大小', dataIndex: 'size_gb', width: 90, render: (v: number) => `${v} GB` },
    {
      title: '操作', width: 80,
      render: (_: unknown, r: HostUsbDisk) => (
        <Button
          size="small"
          type="primary"
          loading={attachingDev === r.dev}
          onClick={() => attach(r)}
        >
          挂载
        </Button>
      ),
    },
  ]

  const vmCols = [
    { title: 'VM 设备', dataIndex: 'dev', width: 100, render: (v: string) => `/dev/${v}` },
    { title: '宿主机设备', dataIndex: 'host_dev', width: 120 },
    { title: '型号', dataIndex: 'name' },
    { title: '大小', dataIndex: 'size_gb', width: 90, render: (v: number) => `${v} GB` },
    {
      title: '状态', dataIndex: 'status', width: 90,
      render: (v: string) =>
        v === 'online'
          ? <Tag color="green">在线</Tag>
          : <Tag color="red">设备离线</Tag>,
    },
    {
      title: '操作', width: 80,
      render: (_: unknown, r: UsbDiskInfo) => (
        r.status === 'offline'
          ? (
            <Popconfirm
              title="设备已离线，确认从 VM 配置中移除？"
              onConfirm={() => detach(r.dev, true)}
            >
              <Button danger size="small">清理</Button>
            </Popconfirm>
          )
          : (
            <Tooltip title="解挂前请在 VM 内执行 umount">
              <Button danger size="small" onClick={() => detach(r.dev)}>解挂</Button>
            </Tooltip>
          )
      ),
    },
  ]

  return (
    <>
      <div style={{ marginBottom: 8 }}>
        <Space>
          <span>挂载模式：</span>
          <Radio.Group value={persistent} onChange={e => setPersistent(e.target.value)}>
            <Radio value={true}>持久化（重启保留）</Radio>
            <Radio value={false}>仅运行时</Radio>
          </Radio.Group>
        </Space>
      </div>

      <Divider orientation="left">宿主机 USB 磁盘</Divider>
      <Button
        icon={<ReloadOutlined />}
        size="small"
        loading={loadingHost}
        onClick={loadHost}
        style={{ marginBottom: 8 }}
      >
        刷新
      </Button>
      <Table
        dataSource={hostDisks}
        columns={hostCols}
        rowKey="dev"
        pagination={false}
        size="small"
      />

      <Divider orientation="left">已挂载到本 VM</Divider>
      <Table
        dataSource={vmDisks}
        columns={vmCols}
        rowKey="dev"
        pagination={false}
        size="small"
      />

      <Modal
        title="无法检测挂载状态"
        open={!!gaModal}
        onOk={forceDetach}
        onCancel={() => setGaModal(null)}
        okText="确认已 umount，强制解挂"
        okButtonProps={{ danger: true }}
        cancelText="取消"
      >
        <p>虚拟机未安装 Guest Agent，无法自动检测设备是否已在 VM 内卸载。</p>
        <p>请确认已在 VM 内执行 <code>umount /dev/{gaModal?.dev}</code>，否则可能导致数据损坏。</p>
      </Modal>
    </>
  )
}
```

**Step 2: Commit**

```bash
git add frontend/src/components/UsbDiskPanel.tsx
git commit -m "feat: add UsbDiskPanel component"
```

---

## Task 12: Frontend — replace USB tab in VMDetail with USB直通盘

**Files:**
- Modify: `frontend/src/pages/VMDetail.tsx`

**Step 1: Replace USBPanel import with UsbDiskPanel**

Change:
```typescript
import USBPanel from '../components/USBPanel'
```
to:
```typescript
import UsbDiskPanel from '../components/UsbDiskPanel'
```

**Step 2: Replace the USB tab entry**

Change:
```typescript
{ key: 'usb', label: 'USB', children: <USBPanel name={name} /> },
```
to:
```typescript
{ key: 'usb', label: 'USB直通盘', children: <UsbDiskPanel name={name} /> },
```

**Step 3: Commit**

```bash
git add frontend/src/pages/VMDetail.tsx
git commit -m "feat: replace USB tab with USB直通盘 using UsbDiskPanel"
```

---

## Verification

After all tasks complete, rebuild and test:

```bash
docker compose build kvm-api kvm-web
docker compose up -d
```

Check these flows:
1. **List host USB disks** — `GET /api/host/usb-disks` should return plugged-in USB disks
2. **Attach** — Select a disk in UI, click 挂载, confirm it appears in VM-attached list
3. **Virtio-scsi controller** — `virsh dumpxml <vm> | grep virtio-scsi` should show controller
4. **Inside VM** — `lsblk` should show new `/dev/sdX` device
5. **Detach (GA available)** — Mount device in VM, click 解挂, expect 409 error. Umount, retry, expect success
6. **Detach (GA unavailable)** — Click 解挂 without GA, expect confirmation modal to appear
7. **Offline device** — Physically remove USB while still in VM attached list, refresh, expect 🔴 offline status and 清理 button
