# Operation

This page describes the live workflow after the lab is deployed and the packed extension is loaded.

## Scanner

The scanner runs from the Chrome extension. It discovers MCP-like services reachable from the browser origin granted to the extension.

Typical local target:

```text
target: localtest.me
ports: 8000-9000
```

Chrome Site access still controls what the extension can fetch. If a target is blocked, the dashboard shows the active allowed origins and asks you to grant Site access or repack with explicit host permissions.

## DNS Rebinding Attack Flow

1. Scan for MCP services.
2. Select an MCP server from the findings list.
3. Click **DNS Rebind**.
4. The offscreen bridge starts the attack through the configured Singularity provider.
5. Open the operator console.
6. Watch captured sessions and bridge telemetry.
7. Queue `tools/list`, `tools/call`, or raw JSON-RPC against the captured MCP session.

The extension supports one active DNS-rebind bridge at a time. If a bridge is already running, starting another one asks whether to stop the current bridge and start the selected MCP server.

## Dashboard

The dashboard stores:

- victims,
- captured MCP sessions,
- telemetry events,
- queued operator tasks,
- task results,
- evidence exports.

Operator endpoints require the dashboard bearer token when `MCP_BINDER_DASHBOARD_TOKEN` is set.

## Operator Console

The operator console is part of the packed extension:

```text
ui/operator.html
```

The console can:

- list victims and captured MCP sessions,
- queue `tools/list`,
- queue `tools/call`,
- queue raw JSON-RPC,
- show task results,
- save repeated requests,
- export evidence,
- clear live dashboard state.

Only use `tools/call` in an authorized demo. Passive scanning never calls tools.

## Evidence

Dashboard export returns normalized evidence shaped by:

```text
schemas/evidence.schema.json
```

Expected attack outcomes include:

- `rebind_confirmed`
- `blocked_by_host_validation`
- `blocked_by_lna`
- `blocked_by_cors`
- `dns_not_rebound`
- `mcp_not_detected`
- `inconclusive`
- `stopped`

Evidence exports can contain sensitive hostnames, target ports, campaign IDs, server metadata, MCP session IDs, and tool output. Treat exports as private research artifacts unless redacted.
