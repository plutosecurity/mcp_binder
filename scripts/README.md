# Scripts

Use `scripts/framework-cli.js` as the supported operator entry point.

## Main CLI

```sh
node scripts/framework-cli.js validate-config deployment.framework-config.json
node scripts/framework-cli.js preflight deployment.framework-config.json --offline
node scripts/framework-cli.js dns verify --config deployment.framework-config.json --stage records
node scripts/framework-cli.js attacker deploy --config deployment.framework-config.json --execute --clear-existing
node scripts/framework-cli.js attacker verify --config deployment.framework-config.json
node scripts/framework-cli.js extension pack --config deployment.framework-config.json --out dist/mcp_binder
node scripts/framework-cli.js attacker clean --config deployment.framework-config.json --execute
```

Output is human-readable by default. Add `--json` to any `framework-cli.js`
command when you need machine-readable output.

## Low-Level Helpers

These scripts are implementation details. Use them directly only when debugging or building custom automation.

| Script | Purpose |
| --- | --- |
| `scripts/deploy-attacker-ssh.sh` | Uploads runtime files over SSH and runs the VM installer with `sudo`. |
| `scripts/setup-attacker-vm.sh` | VM-local installer for Singularity, payload files, dashboard service, and systemd units. |
| `scripts/clean-attacker-ssh.sh` | Uploads and runs the VM cleanup script over SSH. |
| `scripts/clean-attacker-vm.sh` | VM-local cleanup script for MCP Binder runtime files and services. |
| `scripts/dns-route53-records.sh` | Optional Route53 helper that writes zone-file and change-batch records. |
| `scripts/mock-mcp-lab.js` | Local MCP target lab for scanner and attack regression testing. |

## Provider Boundary

MCP Binder does not manage cloud network policy. Open inbound rules in your VM provider before deployment:

```text
TCP 22
TCP dashboard port, default 8090
TCP Singularity HTTP attack ports, default 8080-8089
UDP/TCP 53
```
