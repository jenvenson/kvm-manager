from pydantic import BaseModel
from typing import Optional


class VMSummary(BaseModel):
    name: str
    state: str
    vcpus: int
    memory_mb: int


class VMDetail(VMSummary):
    uuid: str
    autostart: bool


class CPUConfig(BaseModel):
    vcpus: int
    sockets: int
    cores: int
    threads: int


class CPUUpdate(BaseModel):
    vcpus: int = 0  # ignored; total = sockets * cores * threads
    sockets: int
    cores: int
    threads: int


class MemoryConfig(BaseModel):
    current_mb: int
    max_mb: int


class MemoryUpdate(BaseModel):
    current_mb: Optional[int] = None
    max_mb: Optional[int] = None


class DiskInfo(BaseModel):
    dev: str
    path: str
    size_gb: float
    format: str


class DiskAttach(BaseModel):
    path: Optional[str] = None
    size_gb: Optional[float] = None


class USBDevice(BaseModel):
    id: str
    vendor_id: str
    product_id: str
    name: str


class USBAttach(BaseModel):
    vendor_id: str
    product_id: str


class HostUsbDisk(BaseModel):
    dev: str
    name: str
    size_gb: float
    in_use: bool = False
    used_by: str = ""


class UsbDiskAttach(BaseModel):
    host_dev: str
    persistent: bool = True


class UsbDiskInfo(BaseModel):
    dev: str
    host_dev: str
    name: str
    size_gb: float
    status: str


class SnapshotInfo(BaseModel):
    name: str
    description: str
    created_at: str
    state: str


class SnapshotCreate(BaseModel):
    name: str
    description: str = ""


class ConsoleInfo(BaseModel):
    url: str
    token: str
