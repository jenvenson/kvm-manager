#!/usr/bin/env bash
# deploy.sh — build kvm images locally and deploy to production server
# Usage: ./deploy.sh [--host HOST] [--user USER] [--port PORT] [--remote-dir DIR]
set -euo pipefail

# ── Defaults (override with flags or env vars) ────────────────────────────────
REMOTE_HOST="${KVM_HOST:-}"
REMOTE_USER="${KVM_USER:-root}"
REMOTE_PORT="${KVM_PORT:-22}"
REMOTE_DIR="${KVM_REMOTE_DIR:-/opt/kvm}"
SSH_OPTS="-o StrictHostKeyChecking=no -p ${REMOTE_PORT}"

# ── Parse flags ───────────────────────────────────────────────────────────────
while [[ $# -gt 0 ]]; do
  case $1 in
    --host)      REMOTE_HOST="$2"; shift 2 ;;
    --user)      REMOTE_USER="$2"; shift 2 ;;
    --port)      REMOTE_PORT="$2"; SSH_OPTS="-o StrictHostKeyChecking=no -p ${REMOTE_PORT}"; shift 2 ;;
    --remote-dir) REMOTE_DIR="$2"; shift 2 ;;
    *) echo "Unknown option: $1"; exit 1 ;;
  esac
done

if [[ -z "$REMOTE_HOST" ]]; then
  echo "ERROR: target host is not set. Use --host <ip> or set KVM_HOST=<ip>." >&2
  exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

log() { echo "[$(date '+%H:%M:%S')] $*"; }

# ── Preflight: the remote stack needs a .env (KVM_ADMIN_PASSWORD is required) ──
if [[ ! -f .env ]]; then
  echo "ERROR: .env not found. Create it first (cp .env.example .env, or run" >&2
  echo "       ./quickstart.sh locally) — the remote 'docker compose up' needs it." >&2
  exit 1
fi

# ── Step 1: Build images ──────────────────────────────────────────────────────
log "Building kvm-app image..."
docker build -t kvm-app .

log "Building kvm-novnc image..."
docker build -t kvm-novnc ./novnc

# ── Step 2: Export images ─────────────────────────────────────────────────────
log "Exporting images to /tmp/kvm-deploy.tar.gz ..."
docker save kvm-app kvm-novnc | gzip > /tmp/kvm-deploy.tar.gz
log "Archive size: $(du -sh /tmp/kvm-deploy.tar.gz | cut -f1)"

# ── Step 3: Upload to server ──────────────────────────────────────────────────
log "Uploading images to ${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DIR} ..."
ssh ${SSH_OPTS} "${REMOTE_USER}@${REMOTE_HOST}" "mkdir -p ${REMOTE_DIR}"
scp -P "${REMOTE_PORT}" /tmp/kvm-deploy.tar.gz "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DIR}/kvm-deploy.tar.gz"
scp -P "${REMOTE_PORT}" docker-compose.yml      "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DIR}/docker-compose.yml"
scp -P "${REMOTE_PORT}" .env                     "${REMOTE_USER}@${REMOTE_HOST}:${REMOTE_DIR}/.env"

# ── Step 4: Deploy on server ──────────────────────────────────────────────────
log "Deploying on server..."
ssh ${SSH_OPTS} "${REMOTE_USER}@${REMOTE_HOST}" bash -s <<REMOTE
set -euo pipefail
cd ${REMOTE_DIR}

# Prefer the Compose v2 plugin ("docker compose"); fall back to the standalone
# v1 binary ("docker-compose") if the plugin is not installed.
if docker compose version >/dev/null 2>&1; then
  COMPOSE="docker compose"
elif command -v docker-compose >/dev/null 2>&1; then
  COMPOSE="docker-compose"
else
  echo "[remote] ERROR: neither 'docker compose' nor 'docker-compose' is available." >&2
  exit 1
fi
echo "[remote] Using compose command: \$COMPOSE"

echo "[remote] Loading images..."
docker load < kvm-deploy.tar.gz

echo "[remote] Aligning LIBVIRT_GID with this host's libvirt group..."
GID=\$(getent group libvirt | cut -d: -f3 || true)
if [ -n "\$GID" ]; then
  if grep -qE '^LIBVIRT_GID=' .env; then
    sed -i "s/^LIBVIRT_GID=.*/LIBVIRT_GID=\$GID/" .env
  else
    echo "LIBVIRT_GID=\$GID" >> .env
  fi
  echo "[remote] LIBVIRT_GID=\$GID"
else
  echo "[remote] WARN: no 'libvirt' group found; leaving LIBVIRT_GID as shipped."
fi

echo "[remote] Stopping existing containers..."
\$COMPOSE down || true

echo "[remote] Starting containers..."
\$COMPOSE up -d

echo "[remote] Waiting for kvm-app to be healthy..."
for i in \$(seq 1 30); do
  if \$COMPOSE ps kvm-app | grep -q "Up"; then
    echo "[remote] kvm-app is up"
    break
  fi
  sleep 2
done

echo "[remote] Container status:"
\$COMPOSE ps

echo "[remote] Cleaning up archive..."
rm -f kvm-deploy.tar.gz
REMOTE

# ── Step 5: Cleanup local temp ────────────────────────────────────────────────
rm -f /tmp/kvm-deploy.tar.gz

log "Deploy complete. Access: http://${REMOTE_HOST}/kvm/"
