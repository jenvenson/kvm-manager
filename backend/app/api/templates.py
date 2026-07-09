from fastapi import APIRouter, HTTPException
from pydantic import BaseModel
from app.services import libvirt_svc as svc

router = APIRouter(tags=["templates"])


class TemplateCreate(BaseModel):
    vm_name: str
    template_name: str
    description: str = ""


class TemplateClone(BaseModel):
    new_vm_name: str


@router.get("/templates")
def list_templates():
    try:
        return svc.list_templates()
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/templates")
def create_template(body: TemplateCreate):
    try:
        svc.create_template(body.vm_name, body.template_name, body.description)
        return {"ok": True}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.post("/templates/{template_name}/clone")
def clone_template(template_name: str, body: TemplateClone):
    try:
        svc.clone_template(template_name, body.new_vm_name)
        return {"ok": True}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))


@router.delete("/templates/{template_name}")
def delete_template(template_name: str):
    try:
        svc.delete_template(template_name)
        return {"ok": True}
    except Exception as e:
        raise HTTPException(status_code=400, detail=str(e))
