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

## Pack Extension Only

Use this when the VM and DNS infrastructure already exist and you only need a Chrome extension build for a specific deployment config:

```sh
node scripts/framework-cli.js extension pack \
  --config deployment.framework-config.json \
  --out dist/mcp-binder-extension
```

Load `dist/mcp-binder-extension` from `chrome://extensions`.

The packed extension includes the dashboard URL, rebinding domain, VM IP, Chrome host permissions, and runtime bridge settings derived from `deployment.framework-config.json`. It does not deploy or change the VM.

The command also prints the dashboard token file path. The default is:

```text
dist/mcp-binder-dashboard-token
```

The extension packer also creates `dist/mcp-binder-ingest-token`. The packed extension uses it to report victim sessions and MCP results to the dashboard. Operators normally do not paste this token.

Use the older `pack-extension` alias only for compatibility. The supported command is `extension pack`.

## Choosing Singularity Ports

The scanner port range and the Singularity HTTP ports are different controls.

Scanner ports are local browser targets. They tell the extension where to look for MCP servers on the operator machine, for example `8000-9000`.

Singularity HTTP ports are public VM listener ports used by the DNS-rebinding runtime. They must include the launcher port and the MCP ports you intend to prove through rebinding. The default is intentionally small, usually `8080-8089`.

Do not expose every TCP port through Singularity by default. A wide range creates too many public listeners, makes cloud inbound rules harder to review, increases noise during demos, and expands the VM surface area beyond the proof you are trying to run. Keep the lab focused on the launcher and the MCP services selected for the assessment.

If your scan finds an MCP server outside the default window, add that port before deploying:

```json
{
  "singularity": {
    "launcher_port": 8080,
    "http_ports": [8080, 8081, 8082, 8083, 8091, 8123]
  }
}
```

The VM inbound rules must match the same ports. If `http_ports` includes `8123`, the VM firewall or cloud security group must allow TCP `8123` from the operator network. MCP Binder does not create cloud firewall rules because each VM provider handles network policy differently.

After changing `singularity.http_ports`, rerun the deployment:

```sh
node scripts/framework-cli.js bootstrap \
  --config deployment.framework-config.json \
  --out dist/mcp-binder-lab \
  --deploy \
  --clear-existing
```

Common symptoms of a port mismatch:

- the scanner finds an MCP server, but the DNS rebind attack never reaches it;
- the activity panel keeps retrying a generated rebind hostname;
- the dashboard gets a victim session, but no MCP initialization completes;
- direct checks to the VM public IP work on `8080`, but fail on the selected MCP port.

In that case, check both `singularity.http_ports` and the VM inbound rules before debugging the MCP target.

## Dashboard Token

The dashboard token is stored at `dist/mcp-binder-dashboard-token` unless the config overrides it. The token protects the dashboard and operator console. Anyone with dashboard access but no token cannot queue MCP commands or inspect captured sessions through the operator API.

The ingest token is stored at `dist/mcp-binder-ingest-token`. It protects dashboard ingestion endpoints used by the packed extension. Treat it as internal lab material, not an operator login token.

The dashboard fails closed when the ingest token is missing. Normal deployment commands generate it automatically, pass it to the VM, and pack it into the extension runtime config.

The VM installer also writes the runtime copy to:

```text
/etc/mcp_binder/dashboard-token
```

## Runtime Pinning

The VM installer pins the DNS-rebinding runtime inputs used during setup:

- Go `1.22.4` is downloaded from `dl.google.com` and verified with a hardcoded SHA-256 checksum before extraction.
- Singularity is checked out at commit `142daa66dca250edfac8ed06f4d6773af0f90ecc` before building `singularity-server`.

This keeps fresh VM setup reproducible and prevents accidental drift to a changed upstream runtime.

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

Add `--purge-backups` when you also want to remove `/opt/mcp-binder-backups`. Add `--keep-token` when you want to preserve `/etc/mcp_binder/dashboard-token` on the VM.

The CLI calls two lower-level scripts during cleanup. `clean-operator-ssh.sh` runs on your machine and handles SSH, SCP, and remote staging. `clean-operator-vm.sh` runs on the VM with `sudo` and removes systemd units plus MCP Binder runtime files. Normal users should call `framework-cli.js vm clean`; the split exists so other transport providers can reuse the same VM-local cleanup script later.
