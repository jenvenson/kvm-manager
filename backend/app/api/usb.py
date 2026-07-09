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
