import os

from fastapi import Depends, FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from app import auth
from app.api import vms, cpu, memory, disk, usb_disk, snapshots, console
from app.api import stats, networks, config, templates, events
from app.middleware.events import EventLogMiddleware

auth.ensure_configured()

app = FastAPI(title="KVM Manager API")

_cors_origins = [o.strip() for o in os.environ.get("CORS_ORIGINS", "").split(",") if o.strip()]
if _cors_origins:
    app.add_middleware(
        CORSMiddleware,
        allow_origins=_cors_origins,
        allow_methods=["*"],
        allow_headers=["*"],
    )
app.add_middleware(EventLogMiddleware)


class LoginBody(BaseModel):
    username: str
    password: str


@app.post("/api/login")
def login(body: LoginBody):
    if not auth.check_credentials(body.username, body.password):
        raise HTTPException(status_code=401, detail="invalid credentials")
    token, exp = auth.issue_token(body.username)
    return {"token": token, "expires_at": exp}


for router in [vms, cpu, memory, disk, usb_disk, snapshots, console,
               stats, networks, config, templates, events]:
    app.include_router(
        router.router, prefix="/api", dependencies=[Depends(auth.require_auth)]
    )
