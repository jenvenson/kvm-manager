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
- 浏览器内的 VNC 控制台（通过 noVNC / websockify）
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

## 认证

登录（`POST /api/login`）用管理员凭据换取一个 HMAC-SHA256 签名令牌。每一个
`/api/*` 端点都要求把该令牌放在 `Authorization: Bearer <token>` 请求头里；前端会
自动附加它。没有使用任何外部认证依赖 —— 签名完全基于标准库。

## 部署辅助脚本

当目标服务器上没有源码检出或构建工具，而你更愿意把现成的镜像推送过去、而不是
在那里构建时，使用这个脚本。如果你直接在 KVM 宿主机上部署，请改用
[`./quickstart.sh`](#快速开始) —— 你不需要这个脚本。

`deploy.sh` 会在本地构建镜像，通过 SSH 把它们（以及 `docker-compose.yml` 和你
本地的 `.env`）传输到远程宿主机，让 `LIBVIRT_GID` 与远程宿主机的 libvirt 组对齐，
并在那里执行 `docker compose up -d`。它要求本地先存在一个 `.env`。可以用参数或
环境变量覆盖目标：

```bash
./deploy.sh --host 192.168.1.10 --user root
```

## 许可证

[MIT](LICENSE)
