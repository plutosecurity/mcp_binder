#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/deploy-attacker-ssh.sh --host HOST --public-ip IP --rebind-domain DOMAIN --dashboard-domain DOMAIN [options]

Packages this repo's operator VM runtime, uploads it with scp, and executes
scripts/setup-attacker-vm.sh over ssh. This path is provider-neutral and works
for any Linux VM with SSH and sudo access.

Required:
  --host HOST               SSH host or IP.
  --public-ip IP            Public operator VM IP.
  --rebind-domain DOMAIN    Delegated rebinding domain.
  --dashboard-domain DOMAIN Static dashboard domain.

Options:
  --user USER               SSH username. If omitted, use ssh's default user.
  --port PORT               SSH port. Default: 22.
  --identity-file FILE      SSH private key.
  --remote-dir DIR          Remote staging directory. Default: /tmp/mcp-binder-deploy.
  --dashboard-port PORT     Dashboard API port. Default: 8090.
  --http-ports RANGE        Singularity HTTP ports. Default: 8080-8089.
  --rebound-ip IP           IP returned after DNS flip. Default: 127.0.0.1.
  --dashboard-token TOKEN   Dashboard bearer token.
  --dashboard-token-file F  Read or create dashboard bearer token file. Default: dist/mcp-binder-dashboard-token.
  --clear-existing          Move existing VM runtime to backup before reinstalling.
  --help                    Show this help.
USAGE
}

done_msg() {
  printf '✓ %s\n' "$1"
}

stage() {
  printf '• [%s/6] %s\n' "$1" "$2"
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

clear_arg() {
  if [ "$CLEAR_EXISTING" = "true" ]; then
    printf '%s' "--clear-existing"
  fi
}

ensure_dashboard_token() {
  if [ -n "$DASHBOARD_TOKEN" ]; then
    mkdir -p "$(dirname "$DASHBOARD_TOKEN_FILE")"
    if [ ! -f "$DASHBOARD_TOKEN_FILE" ]; then
      printf '%s\n' "$DASHBOARD_TOKEN" > "$DASHBOARD_TOKEN_FILE"
      chmod 0600 "$DASHBOARD_TOKEN_FILE"
    fi
    return
  fi

  if [ -f "$DASHBOARD_TOKEN_FILE" ]; then
    DASHBOARD_TOKEN="$(tr -d '\n' < "$DASHBOARD_TOKEN_FILE")"
    return
  fi

  mkdir -p "$(dirname "$DASHBOARD_TOKEN_FILE")"
  if command -v openssl >/dev/null 2>&1; then
    DASHBOARD_TOKEN="$(openssl rand -hex 24)"
  else
    DASHBOARD_TOKEN="token-$(date -u +%s)"
  fi
  printf '%s\n' "$DASHBOARD_TOKEN" > "$DASHBOARD_TOKEN_FILE"
  chmod 0600 "$DASHBOARD_TOKEN_FILE"
}

mk_remote_dir() {
  ssh "${SSH_ARGS[@]}" "$SSH_TARGET" "mkdir -p $(shell_quote "$REMOTE_DIR")"
}

upload_runtime() {
  scp "${SCP_ARGS[@]}" "$SETUP_FILE" "$DASHBOARD_GZ_FILE" "$UI_ARCHIVE_FILE" "$SSH_TARGET:$REMOTE_DIR/"
}

run_remote_setup() {
  local remote_setup remote_dashboard remote_ui remote_script
  remote_setup="$(shell_quote "$REMOTE_DIR/setup-attacker-vm.sh")"
  remote_dashboard="$(shell_quote "$REMOTE_DIR/dashboard-server.js.gz")"
  remote_ui="$(shell_quote "$REMOTE_DIR/ui-runtime.tar.gz")"

  remote_script="$TMP_ROOT/remote-setup.sh"

  cat > "$remote_script" <<REMOTE
set -eu
chmod 0755 $remote_setup
DASHBOARD_SERVER_GZ_B64="\$(base64 < $remote_dashboard | tr -d '\\n')"
UI_ARCHIVE_B64="\$(base64 < $remote_ui | tr -d '\\n')"
export DASHBOARD_SERVER_GZ_B64 UI_ARCHIVE_B64
export MCP_BINDER_PROGRESS_OFFSET=2
export MCP_BINDER_PROGRESS_TOTAL=6
sudo -E bash $remote_setup \\
  --public-ip $(shell_quote "$PUBLIC_IP") \\
  --rebind-domain $(shell_quote "$REBIND_DOMAIN") \\
  --dashboard-domain $(shell_quote "$DASHBOARD_DOMAIN") \\
  --dashboard-port $(shell_quote "$DASHBOARD_PORT") \\
  --http-ports $(shell_quote "$HTTP_PORTS") \\
  --rebound-ip $(shell_quote "$REBOUND_IP") \\
  --dashboard-token $(shell_quote "$DASHBOARD_TOKEN") \\
  --quiet $(clear_arg)
rm -rf $(shell_quote "$REMOTE_DIR")
REMOTE

  ssh "${SSH_ARGS[@]}" "$SSH_TARGET" "bash -s" < "$remote_script"
}

HOST=""
USER_NAME=""
SSH_PORT="22"
IDENTITY_FILE=""
REMOTE_DIR="/tmp/mcp-binder-deploy"
PUBLIC_IP=""
REBIND_DOMAIN=""
DASHBOARD_DOMAIN=""
DASHBOARD_PORT="8090"
HTTP_PORTS="8080-8089"
REBOUND_IP="127.0.0.1"
DASHBOARD_TOKEN=""
DASHBOARD_TOKEN_FILE="dist/mcp-binder-dashboard-token"
CLEAR_EXISTING="false"

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
    --public-ip)
      PUBLIC_IP="${2:-}"
      shift 2
      ;;
    --rebind-domain)
      REBIND_DOMAIN="${2:-}"
      shift 2
      ;;
    --dashboard-domain|--dashboard-domain)
      DASHBOARD_DOMAIN="${2:-}"
      shift 2
      ;;
    --dashboard-port)
      DASHBOARD_PORT="${2:-}"
      shift 2
      ;;
    --http-ports)
      HTTP_PORTS="${2:-}"
      shift 2
      ;;
    --rebound-ip)
      REBOUND_IP="${2:-}"
      shift 2
      ;;
    --dashboard-token)
      DASHBOARD_TOKEN="${2:-}"
      shift 2
      ;;
    --dashboard-token-file)
      DASHBOARD_TOKEN_FILE="${2:-}"
      shift 2
      ;;
    --clear-existing)
      CLEAR_EXISTING="true"
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
require_value "$PUBLIC_IP" "--public-ip is required"
require_value "$REBIND_DOMAIN" "--rebind-domain is required"
require_value "$DASHBOARD_DOMAIN" "--dashboard-domain is required"
require_value "$DASHBOARD_TOKEN_FILE" "--dashboard-token-file cannot be empty"
validate_remote_path "$REMOTE_DIR" "--remote-dir"

require_command ssh
require_command scp
require_command base64
require_command gzip
require_command tar

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

ensure_dashboard_token

TMP_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/mcp-binder-ssh.XXXXXX")"
SETUP_FILE="$TMP_ROOT/setup-attacker-vm.sh"
DASHBOARD_GZ_FILE="$TMP_ROOT/dashboard-server.js.gz"
UI_ARCHIVE_FILE="$TMP_ROOT/ui-runtime.tar.gz"
trap 'rm -rf "$TMP_ROOT"' EXIT

cp scripts/setup-attacker-vm.sh "$SETUP_FILE"
gzip -c services/dashboard-server.js > "$DASHBOARD_GZ_FILE"
COPYFILE_DISABLE=1 tar --format ustar -czf "$UI_ARCHIVE_FILE" manifest.json package.json src ui

stage 1 "Preparing VM workspace"
mk_remote_dir
stage 2 "Uploading MCP Binder runtime"
upload_runtime
run_remote_setup

done_msg "VM runtime installed"
echo "  Dashboard: http://$DASHBOARD_DOMAIN:$DASHBOARD_PORT"
echo "  Rebind domain: $REBIND_DOMAIN"
echo "  Token file: $DASHBOARD_TOKEN_FILE"
