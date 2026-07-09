# KVM Manager

A web-based management panel for KVM / libvirt virtual machines. It wraps the
libvirt API in a FastAPI backend and a React (Ant Design) frontend, and embeds
a noVNC console so you can manage guests entirely from the browser.

> **Security notice** — This is a high-privilege tool. Anyone who can log in can
> create, modify and destroy VMs on the host and edit raw domain XML (equivalent
> to `virsh edit`). Always set a strong `KVM_ADMIN_PASSWORD`, run it behind TLS,
> and **never expose it directly to the public internet.** Put it behind a VPN or
> an authenticating reverse proxy.

## Features

- VM lifecycle: start, graceful shutdown, force off, reboot
- CPU topology (sockets / cores / threads) and live/persistent memory sizing
- Disk management: create & attach qcow2, detach
- USB device passthrough and USB block-disk passthrough
- Snapshots: create (disk-only), revert, delete
- Virtual networks: attach / detach interfaces
- VNC console in the browser via noVNC / websockify
- QEMU guest-agent info (IPs, OS, hostname)
- Templates: capture a powered-off VM and clone new VMs from it
- Raw domain XML editor
- Write-operation event log and per-VM protection flags
- Live CPU / memory / network stats

## Architecture

```
┌─────────────┐     /kvm/api      ┌──────────────────────────┐
│   Browser   │ ───────────────►  │  kvm-app container       │
│ React + AntD│                   │  nginx → uvicorn(FastAPI)│
└─────┬───────┘                   │  → libvirt qemu:///system│
      │ /kvm/novnc (websockify)   └──────────────────────────┘
      ▼
┌──────────────────┐
│ kvm-novnc        │  websockify serving noVNC, reads VNC
│ container (host) │  tokens shared via a volume
└──────────────────┘
```

- **Backend** — FastAPI, talks to libvirt over `qemu:///system`; all XML is
  built/parsed with lxml.
- **Frontend** — React + Vite + Ant Design, served as static files by nginx.
- **Console** — the backend writes short-lived VNC tokens to a shared volume;
  the `kvm-novnc` container runs websockify + noVNC to proxy the VNC port.
- Both processes in `kvm-app` are supervised by `supervisord`.

## Requirements

- A Linux host running KVM with libvirt (`libvirtd`) and the `qemu:///system`
  URI reachable.
- Docker and Docker Compose.
- The container needs access to the libvirt socket and the libvirt group; adjust
  `group_add` in `docker-compose.yml` to your host's `libvirt` GID
  (`getent group libvirt`).

## Quick start

```bash
cp .env.example .env
# edit .env — KVM_ADMIN_PASSWORD is required, set KVM_AUTH_SECRET too
docker compose up -d
```

By default the app container publishes port `18080` and the frontend is served
under the `/kvm/` path, so front it with a reverse proxy that maps
`/kvm/ → 127.0.0.1:18080`. The default login user is `admin`.

## Configuration

All configuration is via environment variables (see `.env.example`):

| Variable | Required | Default | Description |
|----------|----------|---------|-------------|
| `KVM_ADMIN_PASSWORD` | **yes** | — | Admin password; the backend refuses to start if unset |
| `KVM_ADMIN_USER` | no | `admin` | Admin username |
| `KVM_AUTH_SECRET` | no | random per start | Token signing secret; set a stable value or sessions drop on restart |
| `KVM_TOKEN_TTL_HOURS` | no | `168` | Session lifetime in hours |
| `CORS_ORIGINS` | no | _(same-origin)_ | Comma-separated allowed origins |
| `NOVNC_HOST` / `NOVNC_PORT` / `NOVNC_PATH` | no | — | Where the browser reaches the noVNC endpoint |

Generate a signing secret:

```bash
python -c "import secrets; print(secrets.token_hex(32))"
```

## Authentication

Login (`POST /api/login`) exchanges the admin credentials for an HMAC-SHA256
signed token. Every `/api/*` endpoint requires that token as a
`Authorization: Bearer <token>` header; the frontend attaches it automatically.
No external auth dependency is used — signing is pure standard library.

## Development

Backend:

```bash
cd backend
python -m venv .venv && . .venv/bin/activate
pip install -r requirements.txt   # needs libvirt-dev / libvirt-python on the host
KVM_ADMIN_PASSWORD=dev uvicorn app.main:app --reload
```

Frontend:

```bash
cd frontend
npm install
npm run dev
```

## Deployment helper

`deploy.sh` builds the images locally, ships them to a remote host over SSH and
runs `docker compose up -d` there. Override the target with flags or env vars:

```bash
./deploy.sh --host 192.168.1.10 --user root
```

## License

[MIT](LICENSE)
