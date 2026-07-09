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
