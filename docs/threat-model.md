# Threat Model

MCP Binder is a research framework for controlled MCP DNS-rebinding labs. It is not a production multi-tenant control plane.

## Protected Assets

- Dashboard operator token.
- Dashboard ingest token.
- Captured MCP session state.
- Queued MCP operations.
- Research evidence and telemetry.
- VM runtime files under `/opt/mcp_binder`, `/var/lib/mcp_binder`, and `/etc/mcp_binder`.

## Main Threats

| Threat | Current Control | Remaining Risk |
| --- | --- | --- |
| Untrusted clients poisoning dashboard state | Ingest token required for session, event, result, and task polling APIs when configured. | Labs without an ingest token run in compatibility mode and should be treated as unsafe. |
| Unauthorized operator access | `/ops` and command queueing require the operator token. Tokens are no longer placed in generated URLs. | Tokens sent over HTTP can be captured on hostile networks. |
| XSS through MCP-controlled names, tool descriptions, or result bodies | Dashboard rendering escapes JSON and generated HTML uses CSP nonces. | Inline styles still require `style-src 'unsafe-inline'`. |
| Unbounded dashboard state growth | Victims, sessions, events, tasks, and results are capped in memory. | Long-running public labs can still lose old telemetry because the dashboard is intentionally lightweight. |
| Supply-chain drift during VM setup | Go tarball checksum is verified and Singularity is pinned to a commit. | Pins must be reviewed and updated over time. |
| Cloud network overexposure | Docs require only DNS, dashboard, SSH, and selected Singularity ports. | The cloud firewall remains operator-owned. MCP Binder cannot enforce it. |

## Assumptions

- The operator owns the VM, DNS records, extension build, and tested MCP target.
- The lab is short-lived unless the operator adds TLS and stricter network controls.
- The dashboard token and ingest token are secrets.
- The rebinding domain is dedicated to the lab.
- The dashboard domain is separate from the delegated rebinding domain.

## Out Of Scope

- Managing EC2, Azure, GCP, or other cloud firewall rules.
- Acting as a persistent hosted service for multiple operators.
- Protecting dashboard traffic without TLS.
- Proving vulnerability eligibility for bug bounty scope.
- Preventing misuse after an operator deliberately packs an extension for a target origin.
