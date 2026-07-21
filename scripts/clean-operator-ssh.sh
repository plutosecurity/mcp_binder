#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/clean-operator-ssh.sh --host HOST --yes [options]

Uploads scripts/clean-operator-vm.sh with scp and runs it over ssh with sudo.
This is provider-neutral and works for any Linux VM with SSH and sudo access.

Required:
  --host HOST           SSH host or IP.
  --yes                 Required confirmation for destructive cleanup.

Options:
  --user USER           SSH username. If omitted, use ssh's default user.
  --port PORT           SSH port. Default: 22.
  --identity-file FILE  SSH private key.
  --remote-dir DIR      Remote staging directory. Default: /tmp/mcp-binder-clean.
  --purge-backups       Also remove /opt/mcp-binder-backups.
  --keep-token          Keep /etc/mcp_binder/dashboard-token on the VM.
  --help                Show this help.
USAGE
}

done_msg() {
  printf '✓ %s\n' "$1"
}

stage() {
  printf '• [%s/3] %s\n' "$1" "$2"
}

require_command() {
  if ! command -v "$1" >/dev/null 2>&1; then
    echo "missing required command: $1" >&2
    exit 1
  fi
}

require_value() {
  local value="$1"
  local message="$2"
  if [ -z "$value" ]; then
    echo "$message" >&2
    usage >&2
    exit 2
  fi
}

shell_quote() {
  printf "'%s'" "$(printf '%s' "$1" | sed "s/'/'\\\\''/g")"
}

validate_remote_path() {
  local value="$1"
  local label="$2"
  if [[ "$value" != /* || "$value" =~ [[:space:]] ]]; then
    echo "$label must be an absolute remote path without whitespace" >&2
    exit 2
  fi
}

flag_arg() {
  local enabled="$1"
  local flag="$2"
  if [ "$enabled" = "true" ]; then
    printf '%s' "$flag"
  fi
}

HOST=""
USER_NAME=""
SSH_PORT="22"
IDENTITY_FILE=""
REMOTE_DIR="/tmp/mcp-binder-clean"
PURGE_BACKUPS="false"
KEEP_TOKEN="false"
YES="false"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --host)
      HOST="${2:-}"
      shift 2
      ;;
    --user)
      USER_NAME="${2:-}"
      shift 2
      ;;
    --port)
      SSH_PORT="${2:-}"
      shift 2
      ;;
    --identity-file)
      IDENTITY_FILE="${2:-}"
      shift 2
      ;;
    --remote-dir)
      REMOTE_DIR="${2:-}"
      shift 2
      ;;
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

require_value "$HOST" "--host is required"
validate_remote_path "$REMOTE_DIR" "--remote-dir"

if [ "$YES" != "true" ]; then
  echo "cleanup is destructive; rerun with --yes" >&2
  exit 2
fi

require_command ssh
require_command scp

SSH_TARGET="$HOST"
if [ -n "$USER_NAME" ]; then
  SSH_TARGET="$USER_NAME@$HOST"
fi

SSH_ARGS=(-p "$SSH_PORT")
SCP_ARGS=(-q -P "$SSH_PORT")
if [ -n "$IDENTITY_FILE" ]; then
  SSH_ARGS+=(-i "$IDENTITY_FILE")
  SCP_ARGS+=(-i "$IDENTITY_FILE")
fi

REMOTE_SCRIPT="$REMOTE_DIR/clean-operator-vm.sh"

stage 1 "Preparing VM cleanup workspace"
ssh "${SSH_ARGS[@]}" "$SSH_TARGET" "mkdir -p $(shell_quote "$REMOTE_DIR")"
stage 2 "Uploading cleanup runtime"
scp "${SCP_ARGS[@]}" scripts/clean-operator-vm.sh "$SSH_TARGET:$REMOTE_SCRIPT"

stage 3 "Running VM cleanup"
ssh "${SSH_ARGS[@]}" "$SSH_TARGET" "chmod 0755 $(shell_quote "$REMOTE_SCRIPT") && sudo bash $(shell_quote "$REMOTE_SCRIPT") --yes $(flag_arg "$PURGE_BACKUPS" "--purge-backups") $(flag_arg "$KEEP_TOKEN" "--keep-token"); rm -rf $(shell_quote "$REMOTE_DIR")"

done_msg "VM runtime cleaned"
echo "  VM: $SSH_TARGET"
