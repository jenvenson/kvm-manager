from fastapi import APIRouter, HTTPException
from app.services import libvirt_svc as svc

router = APIRouter(tags=["stats"])


@router.get("/vms/{name}/stats")
def get_stats(name: str):
    try:
        return svc.get_vm_stats(name)
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/host/info")
def get_host_info():
    try:
        return svc.get_host_info()
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
