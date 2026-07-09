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
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.put("/vms/{name}/memory")
def update_memory(name: str, body: MemoryUpdate):
    try:
        svc.set_memory(name, body.current_mb, body.max_mb)
        return {"status": "updated"}
    except libvirt.libvirtError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
