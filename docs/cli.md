# CLI Reference

Use `scripts/framework-cli.js` as the supported operator entry point.

Add `--json` to any command when automation needs machine-readable output. Default output is designed for humans and hides low-level script paths.

## Validate Config

```sh
node scripts/framework-cli.js validate-config deployment.framework-config.json
```

Checks the deployment config and prints the derived VM, DNS, runtime, and extension settings.

## Preflight

```sh
node scripts/framework-cli.js preflight deployment.framework-config.json --offline
```

Shows what MCP Binder will use without touching the VM or DNS provider.

## DNS

Verify DNS records:

```sh
node scripts/framework-cli.js dns verify \
  --config deployment.framework-config.json \
  --stage records
```

Generate Route53 helper files:

```sh
node scripts/framework-cli.js dns plan \
  --config deployment.framework-config.json \
  --out dist/route53
```

Route53 is optional. The official pipeline needs DNS records, not a specific DNS provider.

## Build The Lab

```sh
node scripts/framework-cli.js bootstrap \
  --config deployment.framework-config.json \
  --out dist/mcp-binder-lab \
  --deploy \
  --clear-existing
```

This deploys the VM runtime over SSH and packs the Chrome extension into:

```text
dist/mcp-binder-lab/extension
```

The local dashboard token file is:

```text
dist/mcp-binder-dashboard-token
```

The packed extension also receives an ingest token from:

```text
dist/mcp-binder-ingest-token
```

The ingest token is used automatically by the bridge when it reports sessions and results to the dashboard, and when it polls queued operations for a captured MCP session.

## VM Deploy

Preview:

```sh
node scripts/framework-cli.js vm deploy \
  --config deployment.framework-config.json
```

Run:

```sh
node scripts/framework-cli.js vm deploy \
  --config deployment.framework-config.json \
  --execute \
  --clear-existing
```

`--clear-existing` moves an existing runtime to a backup before reinstalling.

## VM Verify

```sh
node scripts/framework-cli.js vm verify \
  --config deployment.framework-config.json
```

Checks dashboard health and the Singularity launcher payload.

## VM Clean

Preview:

```sh
node scripts/framework-cli.js vm clean \
  --config deployment.framework-config.json
```

Run:

```sh
node scripts/framework-cli.js vm clean \
  --config deployment.framework-config.json \
  --execute
```

Options:

| Option | Effect |
| --- | --- |
| `--keep-token` | Preserve `/etc/mcp_binder/dashboard-token` on the VM. |
| `--purge-backups` | Remove `/opt/mcp-binder-backups`. |

## Pack Extension Only

```sh
node scripts/framework-cli.js extension pack \
  --config deployment.framework-config.json \
  --out dist/mcp-binder-extension
```

Use this when the VM and DNS already exist and you only need a deployment-specific extension build.

## Compatibility Aliases

`attacker deploy`, `attacker verify`, and `attacker clean` still exist for older automation. New docs and examples use `vm`.
