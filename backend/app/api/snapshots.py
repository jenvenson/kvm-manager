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
