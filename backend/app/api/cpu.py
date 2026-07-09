from fastapi import APIRouter, HTTPException
import libvirt

from app.services import libvirt_svc as svc
from app.models.schemas import CPUConfig, CPUUpdate

router = APIRouter(tags=["cpu"])


@router.get("/vms/{name}/cpu", response_model=CPUConfig)
def get_cpu(name: str):
    try:
        return svc.get_cpu_config(name)
    except libvirt.libvirtError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.put("/vms/{name}/cpu")
def update_cpu(name: str, body: CPUUpdate):
    try:
        svc.set_cpu_config(name, body.vcpus, body.sockets, body.cores, body.threads)
        return {"status": "updated"}
    except libvirt.libvirtError as e:
        raise HTTPException(status_code=400, detail=str(e))
    except ValueError as e:
        raise HTTPException(status_code=404, detail=str(e))
