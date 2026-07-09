# KVM 管理可视化平台 设计文档

**日期**: 2026-07-06  
**定位**: 轻量级单机 KVM 硬件配置管理平台，内网使用，无认证

---

## 一、整体架构

```
宿主机 (KVM 运行在这里)
├── /var/run/libvirt/libvirt.sock
├── /var/lib/libvirt/images/       ← 磁盘镜像目录（挂载到容器）
│
└── Docker Compose
    ├── kvm-api   (FastAPI + libvirt-python, port 8000)
    │   ├── 挂载 /var/run/libvirt/libvirt.sock
    │   └── 挂载 /var/lib/libvirt/images
    └── kvm-web   (React + Ant Design, Nginx, port 8080)
         └── /api/* → 反向代理到 kvm-api:8000
```

**核心约束**：
- `kvm-api` 容器通过 `group_add: libvirt` 获得 socket 读写权限
- CPU 配置只支持关机状态修改
- 内存 `current` 支持运行时调整，`max` 需关机
- 无 WebSocket，前端每 5 秒轮询 VM 状态

---

## 二、项目结构

```
kvm/
├── docker-compose.yml
├── backend/
│   ├── Dockerfile
│   ├── requirements.txt
│   └── app/
│       ├── main.py
│       ├── api/
│       │   ├── vms.py          # VM 列表、状态、电源操作
│       │   ├── cpu.py          # CPU 配置
│       │   ├── memory.py       # 内存配置
│       │   ├── disk.py         # 磁盘管理
│       │   └── usb.py          # USB 直通
│       ├── services/
│       │   └── libvirt_svc.py  # 封装所有 libvirt 调用
│       └── models/
│           └── schemas.py      # Pydantic 数据结构
└── frontend/
    ├── Dockerfile
    ├── nginx.conf
    ├── package.json
    └── src/
        ├── App.tsx
        ├── api/client.ts       # axios 封装
        ├── pages/
        │   ├── Dashboard.tsx   # VM 列表总览
        │   └── VMDetail.tsx    # VM 详情页（含 Tab）
        └── components/
            ├── CPUPanel.tsx
            ├── MemoryPanel.tsx
            ├── DiskPanel.tsx
            └── USBPanel.tsx
```

---

## 三、API 接口

所有接口前缀 `/api`，返回 JSON。

### VM 基础操作
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/vms` | 列出所有 VM（名称、状态、CPU数、内存） |
| GET | `/api/vms/{name}` | VM 详情 |
| POST | `/api/vms/{name}/start` | 启动 |
| POST | `/api/vms/{name}/shutdown` | 关机（ACPI） |
| POST | `/api/vms/{name}/force-off` | 强制关机 |

### CPU 配置
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/vms/{name}/cpu` | 当前 CPU 配置 |
| PUT | `/api/vms/{name}/cpu` | 修改 vCPU 数、sockets/cores/threads |

### 内存配置
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/vms/{name}/memory` | 当前内存配置 |
| PUT | `/api/vms/{name}/memory` | 修改 current / max 内存（MiB） |

### 磁盘管理
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/vms/{name}/disks` | 列出所有磁盘 |
| POST | `/api/vms/{name}/disks` | 添加磁盘（镜像路径或新建大小） |
| DELETE | `/api/vms/{name}/disks/{dev}` | 移除磁盘（如 vdb） |

### USB 直通
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/host/usb` | 列出宿主机所有 USB 设备 |
| GET | `/api/vms/{name}/usb` | 列出 VM 已挂载 USB |
| POST | `/api/vms/{name}/usb` | 挂载 USB（vendor_id + product_id） |
| DELETE | `/api/vms/{name}/usb/{id}` | 卸载 USB |

---

## 四、前端页面

### Dashboard（`/`）
- VM 列表卡片网格（名称、状态徽标、CPU数、内存）
- 每张卡片内置启动 / 关机 / 强制关机快捷按钮
- 点击卡片进入 VMDetail

### VMDetail（`/vm/:name`）
- 顶部：VM 名称 + 当前状态 + 电源操作按钮
- Tab 页签：

| Tab | 内容 |
|-----|------|
| CPU | vCPU 数量输入、sockets/cores/threads 拓扑表单，关机状态才可编辑 |
| 内存 | current / max 内存数字输入（MiB），运行中只允许改 current |
| 磁盘 | 磁盘列表（设备名、大小、路径）+ 添加/移除，添加用 Drawer |
| USB | 已挂载列表 + 从宿主机 USB 设备选择挂载，Drawer 展示可用设备 |

### 交互约定
- 配置修改：填写表单 → 点击「应用」→ Toast 反馈
- CPU/内存 max 修改时 VM 运行中：弹出确认警告
- 状态每 5 秒轮询（仅刷新状态字段）

---

## 五、关键技术决策

| 决策 | 选择 | 原因 |
|------|------|------|
| libvirt 通信 | Unix socket 挂载 | 无需 TCP，最小权限 |
| CPU 热插拔 | 不支持 | 复杂度高，轻量级不做 |
| 磁盘新建 | 支持指定大小自动 qcow2 | 方便实验室场景 |
| 状态同步 | 轮询 5s | WebSocket 对小规模过重 |
| 认证 | 无 | 内网专用 |
