# Configuration

The framework config is the source of truth for one lab. The CLI derives dashboard settings, Singularity defaults, Chrome host permissions, and DNS summaries from it.

## Minimal Config

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

Field guide:

| Field | Meaning |
| --- | --- |
| `operator.public_ip` | Public IP of the VM hosting the dashboard and rebinding runtime. |
| `operator.ssh_host` | SSH host for deployment. Usually the same value as `operator.public_ip`. |
| `operator.ssh_user` | SSH user with `sudo` access. |
| `operator.ssh_key_path` | Private key used for SSH deployment. |
| `dns.rebind_domain` | Delegated domain used for rebinding payload hosts. |
| `dns.dashboard_fqdn` | Dashboard hostname. Keep it outside the rebinding zone. |
| `dashboard.port` | Optional dashboard port. Default: `8090`. |
| `singularity.launcher_port` | Optional Singularity launcher port. Default: `8080`. |
| `singularity.http_ports` | Optional rebinding HTTP ports. Default: `8080-8089`. Include the launcher port and intended MCP attack ports only. |
| `extension.host_permissions` | Optional Chrome host permission override. Defaults to the rebinding wildcard and dashboard origin. |

Full schema:

```text
schemas/framework-config.schema.json
```

## DNS Records

Create these records in the parent hosted zone:

```text
dashboard.example.com.      A   <vm-public-ip>
ns1.rebind.example.com.     A   <vm-public-ip>
rebind.example.com.         NS  ns1.rebind.example.com.
```

The dashboard hostname must not be a subdomain of the rebinding domain. Keep the control plane separate from rebound payload hosts.

Verify records:

```sh
node scripts/framework-cli.js dns verify \
  --config deployment.framework-config.json \
  --stage records
```

## Route53 Helper

MCP Binder does not require Route53. If you use it, the helper generates reviewable record files:

```sh
scripts/dns-route53-records.sh plan \
  --config deployment.framework-config.json \
  --out-dir dist/route53
```

The plan output writes:

```text
dist/route53/route53.zone
dist/route53/route53-change-batch.json
```

Apply the change batch with the AWS CLI or create the same records in the Route53 UI.

## Network Rules

MCP Binder does not create cloud firewall rules. The operator owns network exposure because every provider has different controls.

Required inbound rules:

| Purpose | Protocol | Port | Source |
| --- | --- | ---: | --- |
| SSH deployment | TCP | 22 | Operator IP |
| Dashboard | TCP | 8090 | Operator IP or approved dashboard users |
| Singularity HTTP | TCP | 8080-8089 | Operator browser and approved test clients |
| Rebinding DNS | UDP | 53 | Public internet |
| Rebinding DNS fallback | TCP | 53 | Public internet |

Open only the Singularity HTTP ports needed for the launcher and intended MCP attack ports. Do not expose every port by default.

For deeper provider-neutral guidance and optional provider examples, read [Infrastructure Guide](infrastructure.md).
