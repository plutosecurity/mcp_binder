# Security Hardening

This page documents the security controls built into MCP Binder itself and the deployment risks that remain operator-owned.

## Implemented Controls

### Dashboard Authentication

MCP Binder uses two tokens:

- `dist/mcp-binder-dashboard-token` protects the dashboard and operator API.
- `dist/mcp-binder-ingest-token` protects extension-to-dashboard ingestion and task polling.

The dashboard fails closed when the ingest token is missing in normal runtime mode. The standard deploy and extension pack commands create this token, pass it to the VM runtime, and embed it into the packed extension runtime config.

### Task Polling Protection

Queued MCP operations are no longer exposed by session id alone. The victim bridge must present the ingest token when polling `/api/tasks/:session`.

### Content Security Policy

Generated dashboard pages include a Content Security Policy with per-response script nonces:

- `default-src 'self'`
- `script-src 'self' 'nonce-...'`
- `object-src 'none'`
- `frame-ancestors 'none'`

Inline scripts are nonce-bearing. The policy does not allow `unsafe-inline` for scripts.

### Runtime Pinning

The VM installer pins runtime inputs used during setup:

- Go `1.22.4` is downloaded from `dl.google.com` and verified with a hardcoded SHA-256 checksum before extraction.
- Singularity is checked out at commit `142daa66dca250edfac8ed06f4d6773af0f90ecc` before building `singularity-server`.

This prevents silent drift to a changed upstream DNS-rebinding runtime.

### Installer Input Validation

The VM installer rejects control characters in operator-supplied values before writing `/etc/mcp_binder/env`. This blocks newline-based environment injection in direct script usage.

### State Limits

The dashboard caps live state arrays for victims, sessions, results, events, and queued tasks. This keeps accidental telemetry floods from growing memory without bound.

## Remaining Deployment Risks

### Dashboard HTTP

The default deployment serves the dashboard over HTTP on the configured dashboard port. This keeps first-time setup provider-neutral and avoids certificate automation as a hard requirement.

HTTP means the dashboard token is visible to anyone who can observe traffic between the operator browser and the VM. For private demos on a restricted network this may be acceptable. For shared infrastructure, public Wi-Fi, conference networks, or long-lived labs, put the dashboard behind TLS.

Recommended mitigations:

- restrict dashboard inbound access to the operator IP range;
- use a short-lived VM and rotate generated tokens between demos;
- add a TLS reverse proxy such as Caddy or Nginx in front of the dashboard;
- avoid sharing the packed extension directory because it contains deployment-specific runtime material.

TLS is not automatic yet because it adds certificate issuance, DNS propagation timing, port `80/443` requirements, proxy configuration, renewal state, and cloud firewall rules. The project should add an optional TLS mode later, not make it part of the first working path.

### Wildcard CORS

The dashboard currently allows wildcard CORS for API requests. Bearer and ingest tokens still gate sensitive operations, but stricter deployments should move toward configurable allowed origins.

Target design:

- same-origin dashboard access by default;
- optional configured Chrome extension origins;
- no wildcard CORS when the operator knows the deployment origin set.

### Browser Token Storage

The dashboard stores the operator token in browser `localStorage` after the operator saves it. This is convenient for live demos, but it increases impact if future dashboard XSS appears.

Current mitigations:

- CSP nonces reduce the chance that injected script executes;
- known unsafe rendering paths escape JSON and metadata before inserting into HTML;
- operator tokens are no longer placed in `/ops` URLs.

Future option:

- switch to session-only token storage or an explicit "remember token" control.

## Operator Checklist

Before running a public or shared demo:

1. Restrict VM inbound rules to the smallest operator IP range possible.
2. Expose only the Singularity ports required for the launcher and selected MCP proofs.
3. Confirm `dist/mcp-binder-dashboard-token` and `dist/mcp-binder-ingest-token` are not committed or shared.
4. Use TLS for the dashboard if the network is not fully trusted.
5. Clean or rebuild the VM after the demo.
