# Architecture

MCP Binder is split into small modules so the same workflow can run against different MCP servers, VM providers, and DNS providers.

## Components

| Component | Path | Responsibility |
| --- | --- | --- |
| Chrome extension | `src/`, `ui/`, `manifest.json` | Scans browser-reachable MCP endpoints, launches the rebinding bridge, and opens the operator dashboard. |
| Framework CLI | `scripts/framework-cli.js` | Reads the framework config, derives runtime settings, verifies DNS, deploys the VM runtime, and packs the extension. |
| Operator VM scripts | `scripts/deploy-operator-ssh.sh`, `scripts/setup-operator-vm.sh` | Install Singularity, payloads, dashboard service, systemd units, and lab tokens on a Linux VM over SSH. |
| Dashboard service | `services/dashboard-server.js` | Tracks victims, MCP sessions, queued operations, results, telemetry, and `/ops` operator views. |
| DNS rebinding engine | Singularity of Origin | Serves one-time rebinding payloads and flips selected hostnames from the VM IP to loopback. |
| DNS helpers | `scripts/dns-route53-records.sh` | Generates provider-specific DNS records. Route53 is optional and does not define the core pipeline. |

## Data Flow

1. The operator creates DNS records for the dashboard hostname, delegated rebinding domain, and delegated nameserver host.
2. The CLI deploys the dashboard service and Singularity payloads to the VM over SSH.
3. The CLI packs a Chrome extension with the dashboard URL, rebinding domain, VM IP, dashboard token path, and ingest token.
4. The extension scans an MCP server through an allowed browser origin such as `localtest.me`.
5. The operator starts a rebinding attack from a finding card.
6. The offscreen bridge loads the generated rebinding URL, tracks payload progress, and reports sessions to the dashboard with the ingest token.
7. The dashboard queues MCP operations.
8. The bridge polls queued operations, sends them to the captured MCP server, and returns results to `/ops`.

## Trust Boundaries

| Boundary | Trust Requirement |
| --- | --- |
| Browser extension to dashboard | The packed extension must contain the correct dashboard URL and ingest token. |
| Operator browser to dashboard | The operator token controls `/ops` access and command queueing. |
| Dashboard to public internet | Use TLS for shared or long-lived labs. HTTP is only acceptable for short-lived isolated labs. |
| VM network policy | The operator must expose DNS, dashboard, and selected Singularity ports. MCP Binder does not manage cloud firewalls. |
| DNS provider | The operator owns record creation. Helpers generate records, but provider APIs stay optional. |
