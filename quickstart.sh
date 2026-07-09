#!/usr/bin/env bash
# quickstart.sh — one-command local bootstrap on a KVM/libvirt host.
#
# Prepares .env (generating a signing secret and, if needed, an admin
# password), detects the host's libvirt group GID, then builds and starts
# the stack with docker compose. Safe to re-run: existing .env values are
# kept, only missing ones are filled in.
#
# Usage: ./quickstart.sh
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

ENV_FILE=".env"
PLACEHOLDER_PW="change-me-to-a-strong-password"

log()  { echo "[quickstart] $*"; }
warn() { echo "[quickstart] WARN: $*" >&2; }
die()  { echo "[quickstart] ERROR: $*" >&2; exit 1; }
have() { command -v "$1" >/dev/null 2>&1; }

# ── Detect the docker compose command ─────────────────────────────────────────
if docker compose version >/dev/null 2>&1; then
  DC=(docker compose)
elif have docker-compose; then
  DC=(docker-compose)
else
  die "docker compose not found. Install Docker + the Compose plugin first."
fi
have docker || die "docker not found. Install Docker first."

# ── .env helpers ──────────────────────────────────────────────────────────────
env_get() {  # env_get KEY -> prints current value (may be empty)
  [[ -f "$ENV_FILE" ]] || return 0
  grep -E "^$1=" "$ENV_FILE" | head -1 | cut -d= -f2- || true
}

env_set() {  # env_set KEY VALUE — replace or append; value read via ENVIRON to
             # avoid shell/sed metacharacter pitfalls (passwords, secrets).
  local key="$1" val="$2"
  if grep -qE "^${key}=" "$ENV_FILE"; then
    KEY="$key" VAL="$val" awk -F= '
      BEGIN { k = ENVIRON["KEY"]; v = ENVIRON["VAL"] }
      $1 == k { print k "=" v; next }
      { print }
    ' "$ENV_FILE" > "$ENV_FILE.tmp" && mv "$ENV_FILE.tmp" "$ENV_FILE"
  else
    printf '%s=%s\n' "$key" "$val" >> "$ENV_FILE"
  fi
}

gen_secret() {
  if have openssl; then openssl rand -hex 32
  elif have python3; then python3 -c 'import secrets; print(secrets.token_hex(32))'
  else head -c 32 /dev/urandom | od -An -tx1 | tr -d ' \n'
  fi
}

# ── Step 1: ensure .env exists ────────────────────────────────────────────────
if [[ ! -f "$ENV_FILE" ]]; then
  [[ -f .env.example ]] || die ".env.example is missing; cannot bootstrap .env"
  cp .env.example "$ENV_FILE"
  log "Created $ENV_FILE from .env.example"
fi

# ── Step 2: admin password ────────────────────────────────────────────────────
cur_pw="$(env_get KVM_ADMIN_PASSWORD)"
if [[ -z "$cur_pw" || "$cur_pw" == "$PLACEHOLDER_PW" ]]; then
  if [[ -t 0 ]]; then
    read -rs -p "Set admin password (blank = generate random): " pw; echo
  else
    pw=""  # non-interactive: fall through to generated password
  fi
  if [[ -z "$pw" ]]; then
    pw="$(gen_secret | cut -c1-24)"
    log "Generated admin password: $pw"
    log "  (save it now — stored in $ENV_FILE as KVM_ADMIN_PASSWORD)"
  fi
  env_set KVM_ADMIN_PASSWORD "$pw"
else
  log "KVM_ADMIN_PASSWORD already set — keeping it"
fi

# ── Step 3: token signing secret ──────────────────────────────────────────────
if [[ -z "$(env_get KVM_AUTH_SECRET)" ]]; then
  env_set KVM_AUTH_SECRET "$(gen_secret)"
  log "Generated KVM_AUTH_SECRET"
fi

# ── Step 4: libvirt group GID ─────────────────────────────────────────────────
if libvirt_gid="$(getent group libvirt | cut -d: -f3)" && [[ -n "$libvirt_gid" ]]; then
  env_set LIBVIRT_GID "$libvirt_gid"
  log "Detected libvirt GID: $libvirt_gid"
else
  warn "Could not detect the 'libvirt' group GID; leaving LIBVIRT_GID as-is."
  warn "Set it manually in $ENV_FILE (getent group libvirt | cut -d: -f3)."
fi

# ── Step 5: noVNC host (best-effort autodetect) ───────────────────────────────
if [[ -z "$(env_get NOVNC_HOST)" ]]; then
  host_ip="$( (hostname -I 2>/dev/null || true) | awk '{print $1}')"
  if [[ -n "$host_ip" ]]; then
    env_set NOVNC_HOST "$host_ip"
    log "Set NOVNC_HOST to $host_ip (edit $ENV_FILE if the browser reaches it elsewhere)"
  fi
fi

# ── Step 6: sanity checks ─────────────────────────────────────────────────────
SOCK="/var/run/libvirt/libvirt-sock"
[[ -S "$SOCK" ]] || warn "libvirt socket $SOCK not found — is libvirtd running on this host?"

# ── Step 7: build & start ─────────────────────────────────────────────────────
log "Building images..."
"${DC[@]}" build

log "Starting containers..."
"${DC[@]}" up -d

# ── Step 8: wait for kvm-app ──────────────────────────────────────────────────
log "Waiting for kvm-app to come up..."
for _ in $(seq 1 30); do
  if "${DC[@]}" ps kvm-app 2>/dev/null | grep -q "Up"; then
    break
  fi
  sleep 2
done

"${DC[@]}" ps

access_host="$(env_get NOVNC_HOST)"; access_host="${access_host:-localhost}"
log "Done. Access the panel at: http://${access_host}:18080/kvm/"
log "Front it with a reverse proxy (/kvm/ -> 127.0.0.1:18080) before exposing it."
