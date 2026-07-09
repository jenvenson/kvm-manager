from fastapi import APIRouter, HTTPException
import libvirt
from pydantic import BaseModel

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


@router.post("/vms/{name}/reboot")
def reboot_vm(name: str):
    _wrap(svc.reboot_vm, name)
    return {"status": "rebooted"}


@router.get("/vms/{name}/xml")
def get_vm_xml(name: str):
    return {"xml": _wrap(svc.get_vm_xml, name)}


class XmlBody(BaseModel):
    xml: str


@router.put("/vms/{name}/xml")
def update_vm_xml(name: str, body: XmlBody):
    _wrap(svc.update_vm_xml, name, body.xml)
    return {"status": "updated"}


@router.get("/vms/{name}/guest-agent")
def get_guest_agent(name: str):
    return _wrap(svc.get_guest_agent_status, name)
