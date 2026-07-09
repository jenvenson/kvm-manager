import os
from fastapi import APIRouter, HTTPException

from app.services import libvirt_svc as svc
from app.models.schemas import ConsoleInfo

router = APIRouter(tags=["console"])

VNC_HOST = os.environ.get("VNC_HOST", "host.docker.internal")
NOVNC_HOST = os.environ.get("NOVNC_HOST", "localhost")
NOVNC_PORT = int(os.environ.get("NOVNC_PORT", "6080"))
NOVNC_PATH = os.environ.get("NOVNC_PATH", "").strip("/")


@router.get("/vms/{name}/console", response_model=ConsoleInfo)
def get_console(name: str):
    try:
        return svc.get_console_url(name, VNC_HOST, NOVNC_HOST, NOVNC_PORT, NOVNC_PATH)
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
