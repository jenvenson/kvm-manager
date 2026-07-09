import libvirt
import base64
import glob
import json
import os
import re
import shutil
import subprocess
import threading
import time
import uuid
from urllib.parse import quote
from contextlib import contextmanager
from datetime import datetime
from pathlib import Path
from typing import List

from lxml import etree

DOMAIN_STATES = {
    0: "nostate", 1: "running", 2: "blocked",
    3: "paused", 4: "shutdown", 5: "shutoff",
    6: "crashed", 7: "pmsuspended",
}

# Names that flow into filesystem paths must be strictly constrained to avoid
# path traversal (e.g. template_name="../../etc" → rmtree of an arbitrary dir).
_VALID_NAME = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]*$")
# USB vendor/product identifiers are 1-4 hex digits.
_HEX_ID = re.compile(r"^[0-9a-fA-F]{1,4}$")


def _check_name(name: str, kind: str = "name") -> str:
    if not isinstance(name, str) or ".." in name or not _VALID_NAME.match(name):
        raise ValueError(f"Invalid {kind}: {name!r}")
    return name


def _check_hex_id(value: str, kind: str = "id") -> str:
    v = value.replace("0x", "")
    if not _HEX_ID.match(v):
        raise ValueError(f"Invalid {kind}: {value!r}")
    return v



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
                "vcpus": int(etree.fromstring(d.XMLDesc()).findtext("vcpu") or 1),
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
            "vcpus": int(etree.fromstring(d.XMLDesc()).findtext("vcpu") or 1),
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


def reboot_vm(name: str):
    with _conn() as conn:
        d = conn.lookupByName(name)
        # Use default flags (0); explicit flag combinations cause QEMU driver errors
        # on older libvirt versions (unsupported flags 0xc).
        d.reboot(0)


def get_vm_xml(name: str) -> str:
    with _conn() as conn:
        d = conn.lookupByName(name)
        # VIR_DOMAIN_XML_INACTIVE=2: 返回持久化配置，与 virsh edit 一致
        # 运行中的 VM 改完后刷新能看到保存结果
        return d.XMLDesc(2)


def update_vm_xml(name: str, xml: str):
    # Validate well-formedness and that this is a domain definition before
    # handing it to libvirt. Full editing capability is intentional (this is
    # the browser equivalent of `virsh edit`), so element content is not
    # restricted — only structural validity is checked.
    try:
        tree = etree.fromstring(xml.encode() if isinstance(xml, str) else xml)
    except etree.XMLSyntaxError as e:
        raise ValueError(f"Malformed XML: {e}")
    if etree.QName(tree).localname != "domain":
        raise ValueError("Root element must be <domain>")
    with _conn() as conn:
        conn.defineXML(xml)


def get_guest_agent_status(name: str) -> dict:
    with _conn() as conn:
        d = conn.lookupByName(name)
        state, _ = d.state()
        if state != libvirt.VIR_DOMAIN_RUNNING:
            return {"status": "offline"}

        # Check agent channel via XML (no QEMU-specific API needed)
        xml_tree = etree.fromstring(d.XMLDesc(0).encode())
        agent_target = xml_tree.find(".//channel/target[@name='org.qemu.guest_agent.0']")
        if agent_target is None:
            return {"status": "no_agent"}
        if agent_target.get("state", "") != "connected":
            return {"status": "booting"}

        result: dict = {"status": "online", "ips": []}

        # Get IPs via guest agent (libvirt 2.0+)
        try:
            ifaces = d.interfaceAddresses(
                libvirt.VIR_DOMAIN_INTERFACE_ADDRESSES_SRC_AGENT, 0
            )
            for iface_name, info in ifaces.items():
                if iface_name == "lo":
                    continue
                for addr in info.get("addrs", []):
                    result["ips"].append({
                        "iface": iface_name,
                        "ip": addr["addr"],
                        "type": "ipv4" if addr["type"] == 0 else "ipv6",
                    })
        except Exception:
            pass

        # Get OS info via guestInfo (libvirt 6.0+), fall back to /etc/os-release via GA
        got_os = False
        try:
            _, params = d.guestInfo(
                libvirt.VIR_DOMAIN_GUEST_INFO_OS | libvirt.VIR_DOMAIN_GUEST_INFO_HOSTNAME, 0
            )
            result["os_name"] = params.get("os.pretty-name") or params.get("os.name", "")
            result["kernel"] = params.get("os.kernel-release", "")
            result["hostname"] = params.get("hostname", "")
            got_os = True
        except Exception:
            pass
        if not got_os:
            try:
                ok, out = _ga_exec(d, "/bin/cat", ["/etc/os-release"])
                if ok and out:
                    info: dict = {}
                    for line in out.splitlines():
                        if "=" in line:
                            k, _, v = line.partition("=")
                            info[k.strip()] = v.strip().strip('"')
                    result["os_name"] = info.get("PRETTY_NAME") or info.get("NAME", "")
                    result["hostname"] = ""
            except Exception:
                pass

        return result


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
    total = sockets * cores * threads
    with _conn() as conn:
        d = conn.lookupByName(name)
        xml = etree.fromstring(d.XMLDesc(libvirt.VIR_DOMAIN_XML_INACTIVE))
        vcpu_el = xml.find("vcpu")
        if vcpu_el is None:
            vcpu_el = etree.SubElement(xml, "vcpu")
        vcpu_el.text = str(total)
        vcpu_el.attrib.pop("current", None)
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
    _check_name(name)
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
        fmt_result = subprocess.run(
            ["qemu-img", "info", "--output=json", path],
            capture_output=True, text=True,
        )
        fmt = "qcow2"
        if fmt_result.returncode == 0:
            fmt = json.loads(fmt_result.stdout).get("format", "qcow2")
        disk_el = etree.Element("disk", type="file", device="disk")
        etree.SubElement(disk_el, "driver", name="qemu", type=fmt)
        etree.SubElement(disk_el, "source", file=path)
        etree.SubElement(disk_el, "target", dev=dev, bus="virtio")
        disk_xml = etree.tostring(disk_el, encoding="unicode")
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
    # Use explicit SCSI drive address unit numbers to detect conflicts.
    # Dev name labels in XML are unreliable (e.g. a file disk can be named
    # 'vde' on bus='scsi', which our name-based checks would miss).
    used_units: set[int] = set()
    for disk in xml_tree.findall("devices/disk"):
        addr = disk.find("address[@type='drive']")
        if addr is not None:
            try:
                used_units.add(int(addr.get("unit", -1)))
            except ValueError:
                pass
    unit = 0
    while unit in used_units:
        unit += 1
    if unit >= 26:
        raise ValueError("No available SCSI device names")
    return "sd" + chr(ord('a') + unit)


def _ga_exec(dom, path: str, args: list[str]) -> tuple[bool, str]:
    """Run a command inside VM via GA. Returns (ok, stdout_decoded)."""
    cmd_exec = json.dumps({
        "execute": "guest-exec",
        "arguments": {"path": path, "arg": args, "capture-output": True},
    })

    def _run_cmd(exec_str: str) -> str:
        try:
            return dom.qemuAgentCommand(exec_str, 5, 0)
        except AttributeError:
            r = subprocess.run(
                ["virsh", "qemu-agent-command", dom.name(), exec_str],
                capture_output=True, text=True, timeout=5,
            )
            return r.stdout if r.returncode == 0 else ""

    try:
        out = _run_cmd(cmd_exec)
        if not out:
            return False, ""
        pid = json.loads(out)["return"]["pid"]
        time.sleep(0.5)
        out2 = _run_cmd(json.dumps({"execute": "guest-exec-status", "arguments": {"pid": pid}}))
        if not out2:
            return False, ""
        ret = json.loads(out2)["return"]
        if not ret.get("exited"):
            return False, ""
        raw = ret.get("out-data", "")
        stdout = base64.b64decode(raw).decode(errors="replace") if raw else ""
        return True, stdout
    except Exception:
        return False, ""


def _ga_find_vm_dev(dom, host_dev: str) -> str:
    """Use lsblk inside VM to find which /dev/sdX matches the host device size."""
    try:
        host_bytes = int(Path(f"/sys/block/{os.path.basename(host_dev)}/size").read_text().strip()) * 512
    except Exception:
        return ""
    ok, out = _ga_exec(dom, "/bin/lsblk", ["-J", "-b", "-d", "-o", "NAME,SIZE,TYPE"])
    if not ok or not out:
        return ""
    try:
        devices = json.loads(out).get("blockdevices", [])
        for d in devices:
            if d.get("type") == "disk" and int(d.get("size", 0)) == host_bytes:
                return d["name"]
    except Exception:
        pass
    return ""


def attach_usb_disk(name: str, host_dev: str, persistent: bool) -> str:
    with _conn() as conn:
        dom = conn.lookupByName(name)
        _ensure_virtio_scsi_ctrl(dom)
        xml = etree.fromstring(dom.XMLDesc())
        target_dev = _next_scsi_dev(xml)
        disk_el = etree.Element("disk", type="block", device="disk")
        etree.SubElement(disk_el, "driver", name="qemu", type="raw")
        etree.SubElement(disk_el, "source", dev=host_dev)
        etree.SubElement(disk_el, "target", dev=target_dev, bus="scsi")
        disk_xml = etree.tostring(disk_el, encoding="unicode")
        flags = libvirt.VIR_DOMAIN_AFFECT_CONFIG if persistent else 0
        if dom.isActive():
            flags |= libvirt.VIR_DOMAIN_AFFECT_LIVE
        dom.attachDeviceFlags(disk_xml, flags)

        # Try to resolve the actual VM device name via GA
        actual_dev = _ga_find_vm_dev(dom, host_dev) if dom.isActive() else ""
        return actual_dev or target_dev


def _ga_check_mounted(dom, host_dev: str) -> tuple[bool, bool]:
    """Returns (ga_available, is_mounted). Resolves actual VM dev via size, then checks /proc/mounts."""
    actual_dev = _ga_find_vm_dev(dom, host_dev)
    if not actual_dev:
        return False, False
    ok, out = _ga_exec(dom, "/bin/grep", [f"/dev/{actual_dev}", "/proc/mounts"])
    if not ok:
        return False, False
    return True, bool(out.strip())


def detach_usb_disk(name: str, dev: str, force: bool = False) -> dict:
    """dev is the host device basename (e.g. sdc) — reconstructed to /dev/sdc for XML match."""
    host_dev = dev if dev.startswith('/') else f"/dev/{dev}"
    VIR_DOMAIN_XML_INACTIVE = 2  # persistent (inactive) config flag

    def _find_disk(xml_str: str):
        tree = etree.fromstring(xml_str)
        for disk in tree.findall("devices/disk[@type='block'][@device='disk']"):
            src = disk.find("source")
            tgt = disk.find("target")
            if src is None or tgt is None:
                continue
            if src.get("dev") == host_dev and tgt.get("bus") == "scsi":
                return disk
        return None

    with _conn() as conn:
        dom = conn.lookupByName(name)

        # Search live XML first; fall back to persistent (inactive) config
        detach_flags = 0
        target_disk = None
        if dom.isActive():
            target_disk = _find_disk(dom.XMLDesc(0))
            if target_disk is not None:
                detach_flags = libvirt.VIR_DOMAIN_AFFECT_LIVE
        if target_disk is None:
            target_disk = _find_disk(dom.XMLDesc(VIR_DOMAIN_XML_INACTIVE))
            if target_disk is not None:
                detach_flags = libvirt.VIR_DOMAIN_AFFECT_CONFIG

        if target_disk is None:
            raise ValueError(f"USB disk {dev} not found in VM {name}")

        ga_available, mounted = (
            _ga_check_mounted(dom, target_disk.find("source").get("dev", ""))
            if dom.isActive() else (False, False)
        )

        if mounted:
            return {"success": False, "ga_available": True, "mounted": True}

        if not ga_available and not force:
            return {"success": False, "ga_available": False, "mounted": False}

        dom.detachDeviceFlags(etree.tostring(target_disk, encoding="unicode"), detach_flags)
        return {"success": True, "ga_available": ga_available, "mounted": False}


def get_host_usb() -> List[dict]:
    devices = []
    for vendor_path in glob.glob("/sys/bus/usb/devices/*/idVendor"):
        base = Path(vendor_path).parent
        try:
            vendor = (base / "idVendor").read_text().strip()
            product = (base / "idProduct").read_text().strip()
            name_path = base / "product"
            dev_name = name_path.read_text().strip() if name_path.exists() else f"{vendor}:{product}"
            devices.append({"id": f"{vendor}:{product}", "vendor_id": vendor, "product_id": product, "name": dev_name})
        except OSError:
            continue
    return devices


def _is_usb_dev(dev_name: str) -> bool:
    sys_dev = Path(f"/sys/block/{dev_name}/device")
    if not sys_dev.exists():
        return False
    try:
        return "usb" in str(sys_dev.resolve())
    except OSError:
        return False


def _get_all_attached_block_devs(conn) -> dict:
    """Returns {host_dev: vm_name} for all scsi block devices attached to any VM."""
    result = {}
    for dom in conn.listAllDomains():
        try:
            xml = etree.fromstring(dom.XMLDesc())
        except libvirt.libvirtError:
            continue
        for disk in xml.findall("devices/disk[@type='block'][@device='disk']"):
            src = disk.find("source")
            tgt = disk.find("target")
            if src is not None and tgt is not None and tgt.get("bus") == "scsi":
                host_dev = src.get("dev", "")
                if host_dev:
                    result[host_dev] = dom.name()
    return result


def get_host_usb_disks() -> List[dict]:
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
            "in_use": False,
            "used_by": "",
        })
    with _conn() as conn:
        attached = _get_all_attached_block_devs(conn)
    for r in results:
        if r["dev"] in attached:
            r["in_use"] = True
            r["used_by"] = attached[r["dev"]]
    return results


def get_vm_usb_disks(name: str) -> List[dict]:

    def _dev_exists(dev_name: str) -> bool:
        return Path(f"/sys/block/{dev_name}").exists()

    def _model_of(dev_name: str) -> str:
        p = Path(f"/sys/block/{dev_name}/device/model")
        try:
            return p.read_text().strip() if p.exists() else ""
        except OSError:
            return ""

    def _size_bytes_of(dev_name: str) -> int:
        p = Path(f"/sys/block/{dev_name}/size")
        try:
            return int(p.read_text().strip()) * 512 if p.exists() else 0
        except (ValueError, OSError):
            return 0

    with _conn() as conn:
        d = conn.lookupByName(name)
        xml = etree.fromstring(d.XMLDesc())

        # Build a size→vmdev map from GA lsblk once, reuse for all disks
        ga_size_map: dict[int, str] = {}
        if d.isActive():
            ok, out = _ga_exec(d, "/bin/lsblk", ["-J", "-b", "-d", "-o", "NAME,SIZE,TYPE"])
            if ok and out:
                try:
                    for entry in json.loads(out).get("blockdevices", []):
                        if entry.get("type") == "disk":
                            sz = int(entry.get("size", 0))
                            if sz > 0:
                                ga_size_map[sz] = entry["name"]
                except Exception:
                    pass

        results = []
        for disk in xml.findall("devices/disk[@type='block'][@device='disk']"):
            src = disk.find("source")
            tgt = disk.find("target")
            if src is None or tgt is None:
                continue
            host_dev = src.get("dev", "")
            if not host_dev or tgt.get("bus") != "scsi":
                continue
            xml_dev = tgt.get("dev", "")
            host_dev_name = os.path.basename(host_dev)
            online = _dev_exists(host_dev_name)
            size_b = _size_bytes_of(host_dev_name) if online else 0

            # Prefer GA-detected actual VM device name over XML label
            actual_dev = ga_size_map.get(size_b) or xml_dev

            results.append({
                "dev": actual_dev,
                "host_dev": host_dev,
                "name": _model_of(host_dev_name) if online else host_dev_name,
                "size_gb": round(size_b / (1024 ** 3), 1) if size_b else 0.0,
                "status": "online" if online else "offline",
            })
        return results


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
    vendor_id = _check_hex_id(vendor_id, "vendor_id")
    product_id = _check_hex_id(product_id, "product_id")
    with _conn() as conn:
        d = conn.lookupByName(name)
        hostdev = etree.Element("hostdev", mode="subsystem", type="usb", managed="yes")
        source = etree.SubElement(hostdev, "source")
        etree.SubElement(source, "vendor", id=f"0x{vendor_id}")
        etree.SubElement(source, "product", id=f"0x{product_id}")
        d.attachDeviceFlags(
            etree.tostring(hostdev, encoding="unicode"),
            libvirt.VIR_DOMAIN_AFFECT_CONFIG,
        )


def detach_usb(name: str, usb_id: str):
    parts = usb_id.split(":")
    if len(parts) != 2:
        raise ValueError(f"Invalid USB id format: {usb_id!r}, expected vendor_id:product_id")
    vendor_id, product_id = parts
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
        snap_el = etree.Element("domainsnapshot")
        etree.SubElement(snap_el, "name").text = snap_name
        etree.SubElement(snap_el, "description").text = description
        snap_xml = etree.tostring(snap_el, encoding="unicode")
        # DISK_ONLY(16) | ATOMIC(128): 只快照磁盘，不暂停 VM 保存内存，速度快
        flags = 16 | 128
        d.snapshotCreateXML(snap_xml, flags)


def revert_snapshot(name: str, snap_name: str):
    with _conn() as conn:
        d = conn.lookupByName(name)
        snap = d.snapshotLookupByName(snap_name)
        d.revertToSnapshot(snap)


def delete_snapshot(name: str, snap_name: str):
    with _conn() as conn:
        d = conn.lookupByName(name)
        snap = d.snapshotLookupByName(snap_name)
        try:
            snap.delete(0)
        except libvirt.libvirtError:
            # 外部快照删除元数据后可能因文件合并失败抛异常
            # 验证快照是否真的已删除，已删则视为成功
            try:
                d.snapshotLookupByName(snap_name)
                raise  # 快照仍存在，是真正的失败
            except libvirt.libvirtError:
                pass   # 快照已不存在，操作实际成功


def get_console_url(name: str, vnc_host: str, novnc_host: str, novnc_port: int, novnc_path: str = "") -> dict:
    with _conn() as conn:
        d = conn.lookupByName(name)
        xml = etree.fromstring(d.XMLDesc())
        graphics = xml.find("devices/graphics[@type='vnc']")
        if graphics is None:
            raise ValueError("VNC not configured for this VM")
        port = graphics.get("port", "-1")
        if port == "-1":
            raise ValueError("VNC port not assigned — is the VM running?")

        # Ensure VNC listens on 0.0.0.0 so websockify (in Docker) can reach it
        if graphics.get("listen", "127.0.0.1") != "0.0.0.0":
            state, _ = d.state()
            running = state == libvirt.VIR_DOMAIN_RUNNING
            # Build updated graphics XML
            g_xml = etree.fromstring(d.XMLDesc(libvirt.VIR_DOMAIN_XML_INACTIVE)).find("devices/graphics[@type='vnc']")
            if g_xml is not None:
                g_xml.set("listen", "0.0.0.0")
                listen_el = g_xml.find("listen[@type='address']")
                if listen_el is not None:
                    listen_el.set("address", "0.0.0.0")
                g_str = etree.tostring(g_xml, encoding="unicode")
                # Update persistent config
                inactive_xml = etree.fromstring(d.XMLDesc(libvirt.VIR_DOMAIN_XML_INACTIVE))
                ig = inactive_xml.find("devices/graphics[@type='vnc']")
                if ig is not None:
                    ig.set("listen", "0.0.0.0")
                    il = ig.find("listen[@type='address']")
                    if il is not None:
                        il.set("address", "0.0.0.0")
                conn.defineXML(etree.tostring(inactive_xml, encoding="unicode"))
                # Hot-patch running VM
                if running:
                    try:
                        d.updateDeviceFlags(g_str, libvirt.VIR_DOMAIN_AFFECT_LIVE)
                    except libvirt.libvirtError:
                        pass

    token = uuid.uuid4().hex
    token_dir = os.environ.get("VNC_TOKEN_DIR", "/vnc-tokens")
    os.makedirs(token_dir, exist_ok=True)
    token_file = os.path.join(token_dir, "tokens.cfg")
    # Keep only the last 100 tokens to prevent unbounded growth. The
    # read-modify-write must be atomic: concurrent console requests would
    # otherwise clobber each other's tokens, silently breaking VNC.
    with _token_lock:
        try:
            with open(token_file, "r") as f:
                lines = f.readlines()
        except FileNotFoundError:
            lines = []
        lines = lines[-99:] if len(lines) >= 100 else lines
        lines.append(f"{token}: {vnc_host}:{port}\n")
        with open(token_file, "w") as f:
            f.writelines(lines)

    if novnc_path:
        base = f"http://{novnc_host}:{novnc_port}/{novnc_path}"
        ws_path = f"{novnc_path}/websockify?token={token}"
    else:
        base = f"http://{novnc_host}:{novnc_port}"
        ws_path = f"websockify?token={token}"
    return {
        "url": f"{base}/vnc.html?path={quote(ws_path, safe='')}",
        "token": token,
    }


# Serialises the read-modify-write of the shared VNC token file.
_token_lock = threading.Lock()

# In-memory cache for CPU delta calculation: name -> (cpu_time_ns, wall_time)
_cpu_cache: dict = {}
# Guards the read-compute-write sequence on _cpu_cache below.
_cpu_lock = threading.Lock()


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
            with _cpu_lock:
                if name in _cpu_cache:
                    prev_cpu, prev_wall = _cpu_cache[name]
                    wall_ns = (now - prev_wall) * 1e9
                    vcpus = int(etree.fromstring(d.XMLDesc()).findtext("vcpu") or 1)
                    if wall_ns > 0:
                        cpu_pct = max(0.0, min(100.0, (cpu_time - prev_cpu) / (wall_ns * vcpus) * 100))
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
    if source_type not in ("network", "bridge"):
        raise ValueError(f"Invalid source_type: {source_type!r}")
    mac = _random_mac()
    src_attr = "network" if source_type == "network" else "bridge"
    iface = etree.Element("interface", type=source_type)
    etree.SubElement(iface, "mac", address=mac)
    etree.SubElement(iface, "source", **{src_attr: source})
    etree.SubElement(iface, "model", type=model)
    iface_xml = etree.tostring(iface, encoding="unicode")
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


def _data_dir() -> str:
    d = os.environ.get("DATA_DIR", "/app/data")
    os.makedirs(d, exist_ok=True)
    return d


# Reentrant so a caller can hold it across a whole load-modify-save sequence
# while _load_json/_save_json re-acquire it internally for standalone reads.
_json_lock = threading.RLock()


def _load_json(name: str) -> dict:
    path = os.path.join(_data_dir(), f"{name}.json")
    with _json_lock:
        try:
            with open(path) as f:
                return json.load(f)
        except (FileNotFoundError, ValueError):
            return {}


def _save_json(name: str, data: dict):
    path = os.path.join(_data_dir(), f"{name}.json")
    with _json_lock:
        with open(path, "w") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)


def get_protection_config() -> dict:
    return _load_json("protection")


def set_vm_protection(vm_name: str, level: str | None, note: str = ""):
    with _json_lock:
        config = _load_json("protection")
        if level is None:
            config.pop(vm_name, None)
        else:
            config[vm_name] = {"level": level, "note": note}
        _save_json("protection", config)


def list_templates() -> List[dict]:
    manifest = _load_json("templates")
    return [
        {k: v for k, v in t.items() if k != "xml"}
        for t in manifest.values()
    ]


def create_template(vm_name: str, template_name: str, description: str = ""):
    _check_name(vm_name, "vm_name")
    _check_name(template_name, "template_name")
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

    with _json_lock:
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
    _check_name(template_name, "template_name")
    _check_name(new_vm_name, "new_vm_name")
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
    _check_name(template_name, "template_name")
    with _json_lock:
        manifest = _load_json("templates")
        if template_name not in manifest:
            raise ValueError(f"Template {template_name!r} not found")
        tpl_dir = os.path.join(_data_dir(), "templates", template_name)
        if os.path.exists(tpl_dir):
            shutil.rmtree(tpl_dir)
        del manifest[template_name]
        _save_json("templates", manifest)


def get_host_info() -> dict:
    with _conn() as conn:
        info = conn.getInfo()
        # info: [type, memory_MiB, cpus, mhz, nodes, sockets, cores, threads]
        free_bytes = conn.getFreeMemory()
        return {
            "host_cpus": info[2],
            "host_memory_mb": info[1],
            "host_memory_free_mb": free_bytes // (1024 * 1024),
        }
