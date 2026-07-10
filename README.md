# KVM Manager

English | [简体中文](README.zh-CN.md)

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
- VNC console in the browser via noVNC / websockify (guests must expose VNC, not SPICE — see [VM console](#vm-console-vnc-only))
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
- Guests you intend to open in the browser console must have a
  `<graphics type='vnc'>` device — SPICE-only guests are not supported
  (see [VM console](#vm-console-vnc-only)).

## Quick start

There are two ways to deploy, pick one based on where you build:

- **On the KVM host itself** → use `./quickstart.sh` (below). Builds and starts
  the stack locally.
- **From a separate dev machine** → use [`./deploy.sh`](#deployment-helper). Builds
  images locally and ships them to a remote host over SSH.

On the KVM host, the fastest path is the bootstrap script — it prepares `.env`
(generating a signing secret and, if you don't supply one, an admin password),
detects the host's `libvirt` group GID, then builds and starts the stack:

```bash
./quickstart.sh
```

It's safe to re-run: existing `.env` values are kept, only missing ones are
filled in. Prefer to do it by hand? The manual equivalent is:

```bash
cp .env.example .env
# edit .env — KVM_ADMIN_PASSWORD is required, set KVM_AUTH_SECRET too, and set
# LIBVIRT_GID to your host's libvirt GID (getent group libvirt | cut -d: -f3)
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

## VM console (VNC only)

The browser console works **only for guests that expose a VNC graphics device**.
The backend hands websockify a VNC (RFB) endpoint and the browser runs noVNC —
**SPICE is not supported**. A guest configured with `<graphics type='spice'>`
(or with no graphics device at all) cannot be opened from the web UI.

**Symptom** — clicking *Console* shows "获取控制台失败" / *Failed to open
console*, and the backend logs a `400` on `GET /api/vms/<name>/console`. The
backend returns this whenever the domain XML has no `<graphics type='vnc'>`
device.

**Check a guest's graphics type:**

```bash
virsh dumpxml <vm-name> | grep '<graphics'
```

**Add a VNC device.** libvirt allows one graphics device of each type, so you
can keep an existing SPICE device and add VNC alongside it. Run
`virsh edit <vm-name>` and add inside `<devices>`:

```xml
<graphics type='vnc' port='-1' autoport='yes' listen='0.0.0.0'/>
```

Graphics devices cannot be hot-plugged, so **power-cycle the guest** for the
change to take effect. On the first console request the backend also rewrites
the VNC `listen` address to `0.0.0.0` so websockify (running with host
networking) can reach the port. Because the raw VNC port (5900+) is then open on
all host interfaces, keep it blocked from untrusted networks at the firewall —
only the reverse-proxy port (usually 80/443) should be publicly reachable.

## QEMU guest agent

The panel reads IPs, OS type, and hostname via the QEMU guest agent channel.
The feature is optional — the VM still works without it, but those fields will
be blank.

### Guest XML prerequisite

The domain must have a `virtio-serial` channel device. Check with:

```bash
virsh dumpxml <vm-name> | grep -A2 'guest_agent'
```

If nothing is returned, add the following inside `<devices>` (via
`virsh edit <vm-name>`) and cold-boot the guest:

```xml
<channel type='unix'>
  <target type='virtio' name='org.qemu.guest_agent.0'/>
</channel>
```

### Linux guests

| Distro | Install command |
|--------|-----------------|
| Ubuntu / Debian | `apt install -y qemu-guest-agent` |
| RHEL / CentOS / Rocky | `yum install -y qemu-guest-agent` |
| Fedora | `dnf install -y qemu-guest-agent` |
| Arch Linux | `pacman -S qemu-guest-agent` |

Then enable and start the service:

```bash
systemctl enable --now qemu-guest-agent
```

### Windows guests

Install the **VirtIO drivers ISO** — it bundles the QEMU Guest Agent MSI:

1. Download the latest ISO from the [Fedora VirtIO Drivers page](https://fedorapeople.org/groups/virt/virtio-win/direct-downloads/stable-virtio/).
2. Mount the ISO inside the Windows guest.
3. Run `guest-agent\qemu-ga-x86_64.msi` (or the `i386` variant for 32-bit).
4. The `QEMU Guest Agent` Windows service starts automatically.

### Verify

```bash
virsh qemu-agent-command <vm-name> '{"execute":"guest-ping"}'
# expected: {"return":{}}
```

## Authentication

Login (`POST /api/login`) exchanges the admin credentials for an HMAC-SHA256
signed token. Every `/api/*` endpoint requires that token as a
`Authorization: Bearer <token>` header; the frontend attaches it automatically.
No external auth dependency is used — signing is pure standard library.

## Deployment helper

Use this when you build on a dev machine and push ready-made images to a
separate KVM host over SSH. If you are *already on* the KVM host, use
[`./quickstart.sh`](#quick-start) instead.

`deploy.sh` builds both Docker images locally, ships them (plus
`docker-compose.yml` and your `.env`) to the remote host over SSH, aligns
`LIBVIRT_GID` with the remote host's libvirt group, then runs
`docker compose up -d` there.

**Prerequisites** (on the dev machine):

- Docker installed and running locally
- SSH access to the KVM host (key-based auth recommended; password auth also works)
- A local `.env` file — the remote stack needs it for `KVM_ADMIN_PASSWORD` etc.

**Step 1 — create `.env` on the dev machine:**

```bash
cp .env.example .env
```

Edit `.env` and set at minimum:

```
KVM_ADMIN_PASSWORD=your-strong-password
NOVNC_HOST=<KVM host IP or hostname reachable from the browser>
```

**Step 2 — run deploy:**

```bash
./deploy.sh --host <KVM host IP> --user <ssh user>
```

Full list of flags (all optional except `--host`):

| Flag | Env var | Default | Description |
|------|---------|---------|-------------|
| `--host HOST` | `KVM_HOST` | *(required)* | KVM host IP or hostname |
| `--user USER` | `KVM_USER` | `root` | SSH user |
| `--port PORT` | `KVM_PORT` | `22` | SSH port |
| `--remote-dir DIR` | `KVM_REMOTE_DIR` | `/opt/kvm` | Directory on the remote host |

**Example:**

```bash
./deploy.sh --host 192.168.1.10 --user ubuntu
```

Or export once and reuse:

```bash
export KVM_HOST=192.168.1.10 KVM_USER=ubuntu
./deploy.sh
```

After the script finishes, open `http://<KVM host IP>/kvm/` in your browser.

## Nginx reverse proxy

If you front the stack with Nginx, add the following to your `http` block once
(needed for WebSocket upgrade headers):

```nginx
map $http_upgrade $connection_upgrade {
    default upgrade;
    ''      close;
}
```

Then add a `server` block (or merge into an existing one):

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

Replace `127.0.0.1` with the actual host if Nginx and the containers run on
different machines. Port `18080` is the `kvm-app` container; port `16080` is
the `kvm-novnc` container.

## License

[MIT](LICENSE)
