#!/usr/bin/env bash
# deploy.sh — build kvm images locally and deploy to production server
# Usage: ./deploy.sh [--host HOST] [--user USER] [--port PORT] [--remote-dir DIR]
set -euo pipefail

# ── Defaults (override with flags or env vars) ────────────────────────────────
REMOTE_HOST="${KVM_HOST:-10.70.70.172}"
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

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

log() { echo "[$(date '+%H:%M:%S')] $*"; }

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

# ── Step 4: Deploy on server ──────────────────────────────────────────────────
log "Deploying on server..."
ssh ${SSH_OPTS} "${REMOTE_USER}@${REMOTE_HOST}" bash -s <<REMOTE
set -euo pipefail
cd ${REMOTE_DIR}

echo "[remote] Loading images..."
docker load < kvm-deploy.tar.gz

echo "[remote] Stopping existing containers..."
docker compose down || true

echo "[remote] Starting containers..."
docker compose up -d

echo "[remote] Waiting for kvm-app to be healthy..."
for i in \$(seq 1 30); do
  if docker compose ps kvm-app | grep -q "Up"; then
    echo "[remote] kvm-app is up"
    break
  fi
  sleep 2
done

echo "[remote] Container status:"
docker compose ps

echo "[remote] Cleaning up archive..."
rm -f kvm-deploy.tar.gz
REMOTE

# ── Step 5: Cleanup local temp ────────────────────────────────────────────────
rm -f /tmp/kvm-deploy.tar.gz

log "Deploy complete. Access: http://${REMOTE_HOST}/kvm/"
