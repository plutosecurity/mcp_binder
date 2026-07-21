# Deployment

This is the normal path for a researcher setting up a fresh MCP Binder lab on a VM they control.

## Inputs

Prepare three things before running the CLI:

| Input | Description |
| --- | --- |
| Operator VM | Linux VM reachable over SSH. The SSH user must be able to run `sudo`. |
| DNS records | Dashboard A record, nameserver A record, and delegated rebinding NS record. |
| Inbound rules | SSH, dashboard HTTP, Singularity HTTP ports, and DNS. See [Configuration](configuration.md#network-rules). |

## Config

Create a deployment config:

```sh
cp framework-config.template.json deployment.framework-config.json
```

Edit the small set of VM and DNS values:

```json
{
  "operator": {
    "public_ip": "203.0.113.10",
    "ssh_host": "203.0.113.10",
    "ssh_user": "ubuntu",
    "ssh_key_path": "~/.ssh/mcp-binder.pem"
  },
  "dns": {
    "rebind_domain": "rebind.example.com",
    "dashboard_fqdn": "dashboard.example.com"
  }
}
```

## Build The Lab

Run the full build:

```sh
node scripts/framework-cli.js bootstrap \
  --config deployment.framework-config.json \
  --out dist/mcp-binder-lab \
  --deploy \
  --clear-existing
```

This command deploys the VM runtime over SSH and packs the Chrome extension into `dist/mcp-binder-lab/extension`.

If this step fails, use [Troubleshooting](troubleshooting.md) to test the config, DNS, SSH, VM services, and extension pack separately.

## Dashboard Token

The dashboard token is stored at `dist/mcp-binder-dashboard-token` unless the config overrides it. The token protects the dashboard and operator console. Anyone with dashboard access but no token cannot queue MCP commands or inspect captured sessions through the operator API.

The VM installer also writes the runtime copy to:

```text
/etc/mcp_binder/dashboard-token
```

## Load The Extension

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select `dist/mcp-binder-lab/extension`.
5. Open the extension dashboard.

## Verify Runtime

```sh
node scripts/framework-cli.js vm verify \
  --config deployment.framework-config.json
```

Direct checks:

```sh
curl http://<public-ip>:8080/payloads/victim-launcher.html
curl http://<dashboard-domain>:8090/healthz
```

## Cleanup

```sh
node scripts/framework-cli.js vm clean \
  --config deployment.framework-config.json \
  --execute
```

Add `--purge-backups` when using the lower-level cleanup script and you also want to remove `/opt/mcp-binder-backups`. Add `--keep-token` when you want to preserve `/etc/mcp_binder/dashboard-token` on the VM.
