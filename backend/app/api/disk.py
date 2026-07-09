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
