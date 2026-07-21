# Infrastructure Guide

MCP Binder does not care whether the VM runs on EC2, Azure, GCP, a VPS provider, or an internal lab host. The framework needs reachable infrastructure, not a specific cloud.

## Required Assets

| Asset | Requirement |
| --- | --- |
| Linux VM | Public IP, SSH access, and a user that can run `sudo`. |
| SSH key | Private key on the operator machine. The CLI uses it to upload and run the VM installer. |
| Dashboard hostname | Static hostname that points to the VM. Keep it outside the rebinding zone. |
| Rebinding domain | Delegated subdomain controlled by the Singularity runtime. |
| Nameserver hostname | `ns1.<rebind-domain>` or another host that points to the VM and is used by the NS record. |
| Inbound rules | SSH, dashboard HTTP, selected Singularity HTTP ports, and DNS. |

## DNS Contract

Create these records in the parent zone:

```text
dashboard.example.com.      A   <vm-public-ip>
ns1.rebind.example.com.     A   <vm-public-ip>
rebind.example.com.         NS  ns1.rebind.example.com.
```

The dashboard domain is the control plane. The rebinding domain is the payload plane. Keep them separate so rebound payload hosts cannot collide with dashboard sessions, tokens, or operator pages.

Verify DNS before deploying:

```sh
node scripts/framework-cli.js dns verify \
  --config deployment.framework-config.json \
  --stage records
```

The verifier checks the dashboard A record, the delegated nameserver A record, and the rebinding NS delegation.

## Network Contract

Open only the ports needed by the lab.

| Purpose | Protocol | Port | Source |
| --- | --- | ---: | --- |
| SSH deployment | TCP | 22 | Operator IP |
| Dashboard | TCP | 8090 by default | Operator IP or approved dashboard users |
| Singularity launcher | TCP | 8080 by default | Operator browser and approved test clients |
| Singularity MCP proof ports | TCP | `singularity.http_ports` | Operator browser and approved test clients |
| Rebinding DNS | UDP | 53 | Public internet |
| Rebinding DNS fallback | TCP | 53 | Public internet |

Do not expose every TCP port through Singularity. Each extra port creates another public listener and another cloud firewall rule to review. Keep the range aligned with the launcher and the MCP ports selected for the assessment.

## Provider Notes

### EC2

- Create a dedicated Security Group for the lab VM.
- Attach it to the instance before deployment.
- Add inbound TCP `22`, dashboard port, selected Singularity ports, UDP `53`, and TCP `53`.
- Restrict SSH and dashboard sources to the operator IP when possible.
- Amazon Linux 2023 is supported by the installer through `dnf` and `curl-minimal` detection.

### Azure VM

- Use the VM public IP as `operator.public_ip`.
- Confirm the Network Security Group allows the same network contract.
- The SSH user must have passwordless or promptless `sudo` for the deploy command to finish without manual interaction.

### GCP Compute Engine

- Use the external IP as `operator.public_ip`.
- Add VPC firewall rules for SSH, dashboard, selected Singularity ports, UDP `53`, and TCP `53`.
- Confirm the instance OS has `sudo`, `bash`, and one supported package manager.

## Optional Route53 Helper

Route53 is only a helper path, not a core requirement:

```sh
node scripts/framework-cli.js dns plan \
  --config deployment.framework-config.json \
  --out dist/route53
```

This writes reviewable files under `dist/route53/`. Apply them with the AWS CLI or recreate the same records in the provider UI.

## Troubleshooting Order

When deployment fails, isolate the layer:

1. `node scripts/framework-cli.js validate-config deployment.framework-config.json`
2. `node scripts/framework-cli.js dns verify --config deployment.framework-config.json --stage records`
3. `ssh -i <key> <user>@<vm>`
4. `node scripts/framework-cli.js vm verify --config deployment.framework-config.json`
5. Repack the extension after changing DNS, ports, or dashboard URL.

Use [Troubleshooting](troubleshooting.md) for the full module-by-module checklist.
