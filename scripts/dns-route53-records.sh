#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'USAGE'
Usage: scripts/dns-route53-records.sh MODE --config FILE [options]
       scripts/dns-route53-records.sh MODE --dashboard-domain FQDN --rebind-domain FQDN --public-ip IP [options]

Creates Route53-ready DNS records for a MCP Binder operator VM.

Modes:
  plan          Write both Route53 output files into --out-dir.
  zone-file      Write a BIND-style zone file fragment.
  change-batch  Write an AWS Route53 change-resource-record-sets JSON batch.

Required:
  --config FILE            MCP Binder framework config JSON.
                           Derives operator.public_ip, dns.dashboard_fqdn,
                           dns.rebind_domain, and optional dns.ttl.

Manual field mode:
  --dashboard-domain FQDN  Static dashboard domain.
  --rebind-domain FQDN     Delegated DNS rebinding domain.
  --public-ip IP           Public operator VM IP.

Options:
  --ttl SECONDS            Record TTL. Default: 60.
  --ns-host FQDN           Nameserver host for the rebind domain.
                           Default: ns1.<rebind-domain>.
  --out FILE               Output file. Default: stdout.
  --out-dir DIR            Output directory for plan mode.
  --help                   Show this help.

The generated records are intended for the parent hosted zone:
  dashboard-domain. A public-ip
  ns1.rebind-domain. A public-ip
  rebind-domain. NS ns1.rebind-domain.
USAGE
}

mode="${1:-}"
if [ "$mode" = "--help" ] || [ "$mode" = "-h" ]; then
  usage
  exit 0
fi

case "$mode" in
  plan|zone-file|change-batch)
    shift
    ;;
  *)
    echo "mode must be plan, zone-file, or change-batch" >&2
    usage >&2
    exit 2
    ;;
esac

DASHBOARD_DOMAIN=""
REBIND_DOMAIN=""
PUBLIC_IP=""
TTL="60"
NS_HOST=""
OUT_FILE=""
OUT_DIR=""
CONFIG_FILE=""
OUTPUT_LABEL="out"

while [ "$#" -gt 0 ]; do
  case "$1" in
    --config)
      CONFIG_FILE="${2:-}"
      shift 2
      ;;
    --dashboard-domain)
      DASHBOARD_DOMAIN="${2:-}"
      shift 2
      ;;
    --rebind-domain)
      REBIND_DOMAIN="${2:-}"
      shift 2
      ;;
    --public-ip)
      PUBLIC_IP="${2:-}"
      shift 2
      ;;
    --ttl)
      TTL="${2:-}"
      shift 2
      ;;
    --ns-host)
      NS_HOST="${2:-}"
      shift 2
      ;;
    --out)
      OUT_FILE="${2:-}"
      shift 2
      ;;
    --out-dir)
      OUT_DIR="${2:-}"
      shift 2
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

require_value() {
  local value="$1"
  local message="$2"
  if [ -z "$value" ]; then
    echo "$message" >&2
    usage >&2
    exit 2
  fi
}

fqdn() {
  local value="${1%.}"
  printf '%s.' "$value"
}

json_escape() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

json_config_value() {
  local file="$1"
  local path="$2"
  node -e '
const fs = require("fs");
const file = process.argv[1];
const path = process.argv[2].split(".");
const data = JSON.parse(fs.readFileSync(file, "utf8"));
let value = data;
for (const key of path) value = value?.[key];
if (value !== undefined && value !== null) process.stdout.write(String(value));
' "$file" "$path"
}

load_config() {
  if [ -z "$CONFIG_FILE" ]; then
    return
  fi
  if [ ! -f "$CONFIG_FILE" ]; then
    echo "--config file does not exist: $CONFIG_FILE" >&2
    exit 2
  fi

  DASHBOARD_DOMAIN="${DASHBOARD_DOMAIN:-$(json_config_value "$CONFIG_FILE" "dns.dashboard_fqdn")}"
  DASHBOARD_DOMAIN="${DASHBOARD_DOMAIN:-$(json_config_value "$CONFIG_FILE" "dns.dashboardFqdn")}"
  REBIND_DOMAIN="${REBIND_DOMAIN:-$(json_config_value "$CONFIG_FILE" "dns.rebind_domain")}"
  REBIND_DOMAIN="${REBIND_DOMAIN:-$(json_config_value "$CONFIG_FILE" "dns.rebindDomain")}"
  PUBLIC_IP="${PUBLIC_IP:-$(json_config_value "$CONFIG_FILE" "operator.public_ip")}"
  PUBLIC_IP="${PUBLIC_IP:-$(json_config_value "$CONFIG_FILE" "operator.publicIp")}"
  if [ -z "$PUBLIC_IP" ]; then
    PUBLIC_IP="$(json_config_value "$CONFIG_FILE" "operator.publicIp")"
  fi
  local config_ttl
  config_ttl="$(json_config_value "$CONFIG_FILE" "dns.ttl")"
  if [ "$TTL" = "60" ] && [ -n "$config_ttl" ]; then
    TTL="$config_ttl"
  fi
}

write_output() {
  if [ -n "$OUT_FILE" ]; then
    mkdir -p "$(dirname "$OUT_FILE")"
    cat > "$OUT_FILE"
    echo "✓ ${OUTPUT_LABEL}=$OUT_FILE"
  else
    cat
  fi
}

validate_inputs() {
  require_value "$DASHBOARD_DOMAIN" "--dashboard-domain is required"
  require_value "$REBIND_DOMAIN" "--rebind-domain is required"
  require_value "$PUBLIC_IP" "--public-ip is required"
  if ! [[ "$TTL" =~ ^[0-9]+$ ]]; then
    echo "--ttl must be an integer" >&2
    exit 2
  fi
  if [ -z "$NS_HOST" ]; then
    NS_HOST="ns1.${REBIND_DOMAIN%.}"
  fi
}

emit_zone_file() {
  local dashboard rebind ns
  dashboard="$(fqdn "$DASHBOARD_DOMAIN")"
  rebind="$(fqdn "$REBIND_DOMAIN")"
  ns="$(fqdn "$NS_HOST")"
  {
    printf '%s %s IN A %s\n' "$dashboard" "$TTL" "$PUBLIC_IP"
    printf '%s %s IN A %s\n' "$ns" "$TTL" "$PUBLIC_IP"
    printf '%s %s IN NS %s\n' "$rebind" "$TTL" "$ns"
  } | write_output
}

emit_change_batch() {
  local dashboard rebind ns
  dashboard="$(fqdn "$DASHBOARD_DOMAIN")"
  rebind="$(fqdn "$REBIND_DOMAIN")"
  ns="$(fqdn "$NS_HOST")"
  cat <<JSON | write_output
{
  "Comment": "MCP Binder operator DNS records",
  "Changes": [
    {
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "$(json_escape "$dashboard")",
        "Type": "A",
        "TTL": $TTL,
        "ResourceRecords": [{ "Value": "$(json_escape "$PUBLIC_IP")" }]
      }
    },
    {
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "$(json_escape "$ns")",
        "Type": "A",
        "TTL": $TTL,
        "ResourceRecords": [{ "Value": "$(json_escape "$PUBLIC_IP")" }]
      }
    },
    {
      "Action": "UPSERT",
      "ResourceRecordSet": {
        "Name": "$(json_escape "$rebind")",
        "Type": "NS",
        "TTL": $TTL,
        "ResourceRecords": [{ "Value": "$(json_escape "$ns")" }]
      }
    }
  ]
}
JSON
}

load_config
validate_inputs

case "$mode" in
  plan)
    require_value "$OUT_DIR" "--out-dir is required for plan mode"
    mkdir -p "$OUT_DIR"
    OUT_FILE="$OUT_DIR/route53.zone"
    OUTPUT_LABEL="zone_file"
    emit_zone_file
    OUT_FILE="$OUT_DIR/route53-change-batch.json"
    OUTPUT_LABEL="change_batch"
    emit_change_batch
    echo "✓ route53_plan=$OUT_DIR"
    ;;
  zone-file)
    OUTPUT_LABEL="zone_file"
    emit_zone_file
    ;;
  change-batch)
    OUTPUT_LABEL="change_batch"
    emit_change_batch
    ;;
esac
