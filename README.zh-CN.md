# KVM Manager

[English](README.md) | 简体中文

一个基于 Web 的 KVM / libvirt 虚拟机管理面板。它用 FastAPI 后端封装了
libvirt API，前端采用 React（Ant Design），并内嵌 noVNC 控制台，让你完全在
浏览器里管理虚拟机。

> **安全提示** —— 这是一个高权限工具。任何能登录的人都可以在宿主机上创建、
> 修改、销毁虚拟机，并编辑原始的 domain XML（等同于 `virsh edit`）。请务必设置
> 一个强 `KVM_ADMIN_PASSWORD`，在 TLS 之后运行，并且**绝不要把它直接暴露到公网**。
> 请把它放在 VPN 或带认证的反向代理之后。

## 功能特性

- 虚拟机生命周期：启动、优雅关机、强制关闭、重启
- CPU 拓扑（插槽 / 核心 / 线程）以及在线 / 持久化内存调整
- 磁盘管理：创建并挂载 qcow2、卸载
- USB 设备直通与 USB 块设备（磁盘）直通
- 快照：创建（仅磁盘）、回滚、删除
- 虚拟网络：挂载 / 卸载网络接口
- 浏览器内的 VNC 控制台（通过 noVNC / websockify）（虚拟机必须提供 VNC 而非 SPICE，详见 [虚拟机控制台](#虚拟机控制台仅支持-vnc)）
- QEMU guest-agent 信息（IP、操作系统、主机名）
- 模板：从一台已关机的虚拟机捕获模板，并克隆出新的虚拟机
- 原始 domain XML 编辑器
- 写操作事件日志与按虚拟机的保护标志
- 实时 CPU / 内存 / 网络统计

## 架构

```
┌─────────────┐     /kvm/api      ┌──────────────────────────┐
│   浏览器     │ ───────────────►  │  kvm-app 容器             │
│ React + AntD│                   │  nginx → uvicorn(FastAPI)│
└─────┬───────┘                   │  → libvirt qemu:///system│
      │ /kvm/novnc (websockify)   └──────────────────────────┘
      ▼
┌──────────────────┐
│ kvm-novnc        │  websockify 提供 noVNC，读取通过共享
│ 容器 (宿主机)     │  卷传递的 VNC 令牌
└──────────────────┘
```

- **后端** —— FastAPI，通过 `qemu:///system` 与 libvirt 通信；所有 XML 都用
  lxml 构建 / 解析。
- **前端** —— React + Vite + Ant Design，作为静态文件由 nginx 提供。
- **控制台** —— 后端把短时效的 VNC 令牌写入共享卷；`kvm-novnc` 容器运行
  websockify + noVNC 来代理 VNC 端口。
- `kvm-app` 中的两个进程都由 `supervisord` 托管。

## 环境要求

- 一台运行 KVM 的 Linux 宿主机，装有 libvirt（`libvirtd`），且 `qemu:///system`
  URI 可访问。
- Docker 和 Docker Compose。
- 容器需要访问 libvirt socket 以及 libvirt 用户组；请把 `docker-compose.yml`
  里的 `group_add` 调整为你宿主机的 `libvirt` GID
  （`getent group libvirt`）。
- 想在浏览器控制台中打开的虚拟机，必须带有 `<graphics type='vnc'>` 设备 ——
  仅配置 SPICE 的虚拟机不受支持（详见 [虚拟机控制台](#虚拟机控制台仅支持-vnc)）。

## 快速开始

有两种部署方式，根据你在哪里构建来选择其一：

- **在 KVM 宿主机上** → 使用 `./quickstart.sh`（见下）。在本地构建并启动整个
  技术栈。
- **在独立的开发机上** → 使用 [`./deploy.sh`](#部署辅助脚本)。在本地构建镜像，
  然后通过 SSH 推送到远程宿主机。

在 KVM 宿主机上，最快的路径是引导脚本 —— 它会准备好 `.env`（生成签名密钥，
如果你没有提供还会生成一个管理员密码），检测宿主机的 `libvirt` 组 GID，然后
构建并启动技术栈：

```bash
./quickstart.sh
```

它可以安全地重复运行：已有的 `.env` 值会被保留，只填补缺失的项。更喜欢手动
操作？等价的手动步骤是：

```bash
cp .env.example .env
# 编辑 .env —— KVM_ADMIN_PASSWORD 是必填项，也请设置 KVM_AUTH_SECRET，并把
# LIBVIRT_GID 设为你宿主机的 libvirt GID（getent group libvirt | cut -d: -f3）
docker compose up -d
```

默认情况下，应用容器发布端口 `18080`，前端在 `/kvm/` 路径下提供，所以请用一个
反向代理把 `/kvm/ → 127.0.0.1:18080`。默认登录用户是 `admin`。

## 配置

所有配置都通过环境变量完成（参见 `.env.example`）：

| 变量 | 是否必填 | 默认值 | 说明 |
|------|----------|--------|------|
| `KVM_ADMIN_PASSWORD` | **是** | — | 管理员密码；未设置时后端拒绝启动 |
| `KVM_ADMIN_USER` | 否 | `admin` | 管理员用户名 |
| `KVM_AUTH_SECRET` | 否 | 每次启动随机 | 令牌签名密钥；设置一个稳定值，否则重启后会话失效 |
| `KVM_TOKEN_TTL_HOURS` | 否 | `168` | 会话有效期（小时） |
| `CORS_ORIGINS` | 否 | _（同源）_ | 逗号分隔的允许来源 |
| `NOVNC_HOST` / `NOVNC_PORT` / `NOVNC_PATH` | 否 | — | 浏览器访问 noVNC 端点的地址 |

生成一个签名密钥：

```bash
python -c "import secrets; print(secrets.token_hex(32))"
```

## 虚拟机控制台（仅支持 VNC）

浏览器控制台**只对提供了 VNC 图形设备的虚拟机可用**。后端把一个 VNC(RFB) 端点
交给 websockify，浏览器里跑的是 noVNC —— **不支持 SPICE**。配置为
`<graphics type='spice'>`（或完全没有图形设备）的虚拟机，无法从 Web 界面打开。

**现象** —— 点击「控制台」时提示"获取控制台失败"，后端日志出现
`GET /api/vms/<name>/console` 返回 `400`。只要 domain XML 里没有
`<graphics type='vnc'>` 设备，后端就会返回这个 400。

**查看某台虚拟机的图形类型：**

```bash
virsh dumpxml <虚拟机名> | grep '<graphics'
```

**添加一个 VNC 设备。** libvirt 允许每种类型各挂一个图形设备，所以你可以在保留
已有 SPICE 设备的同时再加一个 VNC。执行 `virsh edit <虚拟机名>`，在 `<devices>`
里加入：

```xml
<graphics type='vnc' port='-1' autoport='yes' listen='0.0.0.0'/>
```

图形设备不支持热插拔，所以要让改动生效**必须重启该虚拟机**。首次打开控制台时，
后端还会把 VNC 的 `listen` 地址改写为 `0.0.0.0`，以便使用宿主机网络的 websockify
能连到该端口。由于此时裸 VNC 端口（5900 起）会在宿主机所有网卡上开放，请在防火墙
层面阻止不受信任网络访问它 —— 对外只应放行反向代理端口（通常是 80/443）。

## QEMU guest agent

管理面板通过 QEMU guest agent 通道读取虚拟机的 IP、操作系统类型和主机名。
该功能是可选的 —— 没有它虚拟机仍然可以正常使用，但这些字段会显示为空。

### Guest XML 前置条件

Domain 里必须有一个 `virtio-serial` channel 设备。可用以下命令检查：

```bash
virsh dumpxml <虚拟机名> | grep -A2 'guest_agent'
```

如果没有输出，通过 `virsh edit <虚拟机名>` 在 `<devices>` 里添加以下内容，
然后冷启动虚拟机：

```xml
<channel type='unix'>
  <target type='virtio' name='org.qemu.guest_agent.0'/>
</channel>
```

### Linux 客户机

| 发行版 | 安装命令 |
|--------|---------|
| Ubuntu / Debian | `apt install -y qemu-guest-agent` |
| RHEL / CentOS / Rocky | `yum install -y qemu-guest-agent` |
| Fedora | `dnf install -y qemu-guest-agent` |
| Arch Linux | `pacman -S qemu-guest-agent` |

然后启用并启动服务：

```bash
systemctl enable --now qemu-guest-agent
```

### Windows 客户机

安装 **VirtIO 驱动 ISO** —— 其中包含 QEMU Guest Agent 的 MSI 安装包：

1. 从 [Fedora VirtIO 驱动页面](https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/stable-virtio/) 下载最新 ISO。
2. 在 Windows 客户机内挂载该 ISO。
3. 运行 `guest-agent\qemu-ga-x86_64.msi`（32 位系统选 `i386` 版本）。
4. `QEMU Guest Agent` Windows 服务会自动启动。

### 验证

```bash
virsh qemu-agent-command <虚拟机名> '{"execute":"guest-ping"}'
# 期望输出：{"return":{}}
```

## 认证

登录（`POST /api/login`）用管理员凭据换取一个 HMAC-SHA256 签名令牌。每一个
`/api/*` 端点都要求把该令牌放在 `Authorization: Bearer <token>` 请求头里；前端会
自动附加它。没有使用任何外部认证依赖 —— 签名完全基于标准库。

## 部署辅助脚本

适用场景：在开发机上构建，通过 SSH 把镜像推送到独立的 KVM 宿主机。如果你
*已经在* KVM 宿主机上操作，请改用 [`./quickstart.sh`](#快速开始)，不需要这个脚本。

`deploy.sh` 会在本地构建两个 Docker 镜像，通过 SSH 把它们（以及
`docker-compose.yml` 和你的 `.env`）传输到远程宿主机，自动对齐远程宿主机的
`LIBVIRT_GID`，然后在那里执行 `docker compose up -d`。

**前置条件**（在开发机上）：

- 本地已安装并运行 Docker
- 可以 SSH 登录 KVM 宿主机（推荐密钥认证，密码认证也可以）
- 本地已有 `.env` 文件 —— 远程 stack 需要它来读取 `KVM_ADMIN_PASSWORD` 等变量

**第一步 —— 在开发机上创建 `.env`：**

```bash
cp .env.example .env
```

编辑 `.env`，至少设置以下两项：

```
KVM_ADMIN_PASSWORD=你的强密码
NOVNC_HOST=<浏览器可访问的 KVM 宿主机 IP 或域名>
```

**第二步 —— 执行部署：**

```bash
./deploy.sh --host <KVM 宿主机 IP> --user <SSH 用户名>
```

所有参数（除 `--host` 外均可选）：

| 参数 | 环境变量 | 默认值 | 说明 |
|------|---------|--------|------|
| `--host HOST` | `KVM_HOST` | *(必填)* | KVM 宿主机 IP 或域名 |
| `--user USER` | `KVM_USER` | `root` | SSH 用户名 |
| `--port PORT` | `KVM_PORT` | `22` | SSH 端口 |
| `--remote-dir DIR` | `KVM_REMOTE_DIR` | `/opt/kvm` | 远程宿主机上的部署目录 |

**示例：**

```bash
./deploy.sh --host 192.168.1.10 --user ubuntu
```

或导出环境变量后直接运行：

```bash
export KVM_HOST=192.168.1.10 KVM_USER=ubuntu
./deploy.sh
```

脚本执行完毕后，在浏览器中打开 `http://<KVM 宿主机 IP>/kvm/`。

## Nginx 反向代理

如果你用 Nginx 作为前端，在 `http` 块里加一次以下配置（WebSocket 升级头所需）：

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
```

然后在对应的 `server` 块中（或并入现有块）添加：

```nginx
location /kvm/ {
    proxy_pass http://127.0.0.1:18080/;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_connect_timeout 900;
    proxy_send_timeout    900;
    proxy_read_timeout    900;
    proxy_http_version 1.1;
    proxy_set_header Upgrade    $http_upgrade;
    proxy_set_header Connection $connection_upgrade;

    location /kvm/novnc/ {
        proxy_pass http://127.0.0.1:16080/;
        proxy_http_version 1.1;
        proxy_set_header Host       $host;
        proxy_set_header Upgrade    $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
        proxy_read_timeout 3600s;
        proxy_send_timeout 3600s;
    }
}
```

如果 Nginx 和容器不在同一台机器上，请将 `127.0.0.1` 替换为实际宿主机地址。
端口 `18080` 对应 `kvm-app` 容器，端口 `16080` 对应 `kvm-novnc` 容器。

## 许可证

[MIT](LICENSE)
