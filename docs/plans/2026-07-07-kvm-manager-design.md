# KVM 管理可视化平台 设计文档（v2）

**日期**: 2026-07-07  
**定位**: 轻量级单机 KVM 硬件配置管理平台，内网使用，无认证  
**变更**: 在 v1 基础上新增快照管理、noVNC 控制台

---

## 一、整体架构

```
宿主机 (KVM 运行在这里)
├── /var/run/libvirt/libvirt.sock
├── /var/lib/libvirt/images/       ← 磁盘镜像目录
│
└── Docker Compose
    ├── kvm-api    (FastAPI + libvirt-python, port 8000)
    │   ├── 挂载 /var/run/libvirt/libvirt.sock
    │   ├── 挂载 /var/lib/libvirt/images
    │   └── 挂载 /vnc-tokens       ← 写入 token 映射文件
    ├── kvm-web    (React + Ant Design, Nginx, port 8080)
    │   └── /api/* → 反向代理到 kvm-api:8000
    └── kvm-novnc  (novnc + websockify, port 6080)  ← 新增
        └── 挂载 /vnc-tokens       ← 读取 token 映射文件
```

**核心约束**：
- `kvm-api` 容器通过 `group_add: libvirt` 获得 socket 读写权限
- CPU 配置只支持关机状态修改
- 内存 `current` 支持运行时调整，`max` 需关机
- 无 WebSocket，前端每 5 秒轮询 VM 状态
- noVNC 控制台通过共享 token 文件目录与 kvm-novnc 通信

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
│       │   ├── usb.py          # USB 直通
│       │   ├── snapshots.py    # 快照管理（新增）
│       │   └── console.py      # noVNC 控制台（新增）
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
            ├── USBPanel.tsx
            └── SnapshotPanel.tsx  # 快照管理（新增）
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

### 快照管理（新增）
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/vms/{name}/snapshots` | 列出所有快照（名称、创建时间、描述） |
| POST | `/api/vms/{name}/snapshots` | 创建快照（body: name, description） |
| POST | `/api/vms/{name}/snapshots/{snap}/revert` | 还原到指定快照 |
| DELETE | `/api/vms/{name}/snapshots/{snap}` | 删除快照 |

**快照行为约定**：
- 创建：VM 运行中或关机均可，统一走 live snapshot（磁盘 + 内存），关机时 libvirt 自动降级为仅磁盘
- 还原：强制关闭 VM，还原后如快照时 VM 在运行则自动启动
- 删除：不影响 VM 当前状态

### 控制台（新增）
| 方法 | 路径 | 说明 |
|------|------|------|
| GET | `/api/vms/{name}/console` | 返回 noVNC URL 和 token |

**返回结构**：
```json
{
  "url": "http://<host>:6080/vnc.html?path=websockify&token=<token>",
  "token": "<token>"
}
```

调用时 kvm-api 从 libvirt 查出 VM 的 VNC 端口，生成 UUID token，写入 `/vnc-tokens/` 目录供 websockify 读取。

---

## 四、前端页面

### Dashboard（`/`）
- VM 列表卡片网格（名称、状态徽标、CPU数、内存）
- 每张卡片内置启动 / 关机 / 强制关机快捷按钮
- 点击卡片进入 VMDetail

### VMDetail（`/vm/:name`）
- 顶部：VM 名称 + 当前状态 + 电源操作按钮 + **「控制台」按钮**（新增）
  - 「控制台」仅 VM 运行中可点击，关机状态置灰
  - 点击后新标签页打开 noVNC URL
- Tab 页签：

| Tab | 内容 |
|-----|------|
| CPU | vCPU 数量输入、sockets/cores/threads 拓扑表单，关机状态才可编辑 |
| 内存 | current / max 内存数字输入（MiB），运行中只允许改 current |
| 磁盘 | 磁盘列表（设备名、大小、路径）+ 添加/移除，添加用 Drawer |
| USB | 已挂载列表 + 从宿主机 USB 设备选择挂载，Drawer 展示可用设备 |
| 快照 | 快照列表 + 创建/还原/删除操作（新增） |

**快照 Tab 交互**：
- 顶部「创建快照」按钮 → Modal 弹窗（名称必填，描述选填）
- 快照列表显示：名称、创建时间、描述
- 每条快照操作：「还原」（弹确认框，提示 VM 将重启）、「删除」（弹确认框）
- 操作完成后 Toast 反馈，列表自动刷新

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
| 快照类型 | 内部快照（internal） | 简单，qcow2 场景足够 |
| 快照模式 | live snapshot（磁盘 + 内存） | 支持运行中 VM，关机时自动降级 |
| noVNC 部署 | 独立容器 + 共享 token 文件 | 职责分离，架构清晰 |
| 控制台入口 | 新标签页 | 不干扰当前操作界面 |
