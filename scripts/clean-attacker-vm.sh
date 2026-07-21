#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: sudo scripts/clean-attacker-vm.sh --yes [options]

Removes the MCP Binder attacker VM runtime from a Linux VM. This stops and
disables the systemd services, removes runtime directories, removes systemd unit
files, removes the Singularity binary built by the installer, and reloads
systemd.

Options:
  --purge-backups    Also remove /opt/mcp-binder-backups.
  --keep-token       Keep /etc/mcp_binder/dashboard-token while removing the env file.
  --yes              Required confirmation for destructive cleanup.
  --help             Show this help.

The script does not uninstall OS packages, Go, Node.js, git, or other shared VM
dependencies.
USAGE
}

PURGE_BACKUPS="false"
KEEP_TOKEN="false"
YES="false"

APP_ROOT="/opt/mcp_binder"
DASHBOARD_ROOT="/var/lib/mcp_binder"
PAYLOAD_BASE="/opt/singularity-payloads"
SINGULARITY_ROOT="/opt/singularity"
ENV_DIR="/etc/mcp_binder"
DASHBOARD_TOKEN_FILE="$ENV_DIR/dashboard-token"
BACKUP_ROOT="/opt/mcp-binder-backups"
SINGULARITY_BIN="/usr/local/bin/singularity-server"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --purge-backups)
      PURGE_BACKUPS="true"
      shift
      ;;
    --keep-token)
      KEEP_TOKEN="true"
      shift
      ;;
    --yes)
      YES="true"
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      echo "unknown option: $1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

if [ "$YES" != "true" ]; then
  echo "cleanup is destructive; rerun with --yes" >&2
  exit 2
fi

if [ "$(id -u)" -ne 0 ]; then
  echo "clean-attacker-vm.sh must run as root" >&2
  exit 1
fi

stop_services() {
  systemctl stop singularity.service mcp-binder-dashboard.service 2>/dev/null || true
  systemctl disable singularity.service mcp-binder-dashboard.service 2>/dev/null || true
}

remove_path() {
  local path="$1"
  if [ -e "$path" ] || [ -L "$path" ]; then
    rm -rf "$path"
    echo "removed=$path"
  fi
}

clean_env_dir() {
  if [ "$KEEP_TOKEN" = "true" ] && [ -f "$DASHBOARD_TOKEN_FILE" ]; then
    local tmp_token
    tmp_token="$(mktemp /tmp/mcp-binder-token.XXXXXX)"
    cp "$DASHBOARD_TOKEN_FILE" "$tmp_token"
    chmod 0600 "$tmp_token"
    remove_path "$ENV_DIR"
    mkdir -p "$ENV_DIR"
    mv "$tmp_token" "$DASHBOARD_TOKEN_FILE"
    chmod 0600 "$DASHBOARD_TOKEN_FILE"
    echo "kept=$DASHBOARD_TOKEN_FILE"
  else
    remove_path "$ENV_DIR"
  fi
}

main() {
  stop_services

  remove_path /etc/systemd/system/singularity.service
  remove_path /etc/systemd/system/mcp-binder-dashboard.service
  systemctl daemon-reload
  systemctl reset-failed singularity.service mcp-binder-dashboard.service 2>/dev/null || true

  remove_path "$APP_ROOT"
  remove_path "$DASHBOARD_ROOT"
  remove_path "$PAYLOAD_BASE"
  remove_path "$SINGULARITY_ROOT"
  remove_path "$SINGULARITY_BIN"
  clean_env_dir

  if [ "$PURGE_BACKUPS" = "true" ]; then
    remove_path "$BACKUP_ROOT"
  fi

  echo "MCP Binder attacker VM runtime cleaned"
}

main
