from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from app.services import libvirt_svc as svc

router = APIRouter(tags=["networks"])


class NetworkAttach(BaseModel):
    source: str
    source_type: str = "network"
    model: str = "virtio"


@router.get("/host/networks")
def list_host_networks():
    try:
        return svc.get_host_networks()
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.get("/vms/{name}/networks")
def list_vm_networks(name: str):
    try:
        return svc.get_vm_networks(name)
    except Exception as e:
        raise HTTPException(status_code=404, detail=str(e))


@router.post("/vms/{name}/networks")
def attach_network(name: str, body: NetworkAttach):
    try:
        svc.attach_network(name, body.source, body.source_type, body.model)
        return {"ok": True}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/vms/{name}/networks/{mac}")
def detach_network(name: str, mac: str):
    try:
        svc.detach_network(name, mac)
        return {"ok": True}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
