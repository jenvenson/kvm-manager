from fastapi import APIRouter, Query
from app.middleware.events import read_events

router = APIRouter(tags=["events"])


@router.get("/events")
def get_events(
    page: int = Query(default=1, ge=1),
    page_size: int = Query(default=50, ge=1, le=500),
    vm_name: str = "",
):
    return read_events(page=page, page_size=page_size, vm_name=vm_name)
