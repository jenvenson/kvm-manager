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
