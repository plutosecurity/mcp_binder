# Target Profiles

Target profiles describe known MCP server shapes. They let researchers keep transport details, expected evidence, and safe default operations in a reviewable JSON file.

Profiles are optional. The scanner can find MCP servers without them. A profile becomes useful when a server needs a specific path, transport, retry budget, or non-destructive validation task.

## Schema

The schema is:

```text
schemas/target-profile.schema.json
```

Required fields:

| Field | Meaning |
| --- | --- |
| `name` | Stable profile id used by operators and docs. |
| `targetName` | Human-readable MCP server or product name. |
| `transport` | MCP transport mode: `streamable`, `streamable-control`, `sse`, or `ws-control`. |
| `port` | Expected local MCP port. |
| `path` | HTTP or WebSocket path, always starting with `/`. |
| `strategy` | Singularity strategy: `fs`, `ma`, `rr`, or `rd`. |
| `impact` | Summary, vulnerable condition, and evidence goal. |
| `tasks` | Safe MCP operations to queue from `/ops`. |

Optional fields:

| Field | Use |
| --- | --- |
| `pollMs` | Delay between bridge polls. Increase for slow MCP servers. |
| `maxTries` | Maximum bridge attempts before declaring inconclusive. |
| `out` | Generated payload filename under `payloads/`. |

## Example

```json
{
  "name": "sample-streamable-8081",
  "targetName": "sample-vuln-mcp",
  "transport": "streamable-control",
  "port": 8081,
  "path": "/mcp",
  "strategy": "fs",
  "pollMs": 800,
  "maxTries": 40,
  "out": "payloads/sample-streamable-8081.html",
  "impact": {
    "summary": "Browser-originated control of a loopback MCP server that accepts rebound Host and Origin.",
    "vulnerableCondition": "The MCP server binds to 127.0.0.1 and does not enforce Host or Origin allowlists.",
    "evidenceGoal": "Show tools/list and tools/call responses read by the operator dashboard through the browser session."
  },
  "tasks": [
    {
      "name": "Enumerate tools",
      "kind": "tools/list"
    },
    {
      "name": "Call echo",
      "kind": "tools/call",
      "tool": "echo",
      "args": {
        "message": "rebind-ok"
      }
    }
  ]
}
```

## Task Types

| Kind | Required Fields | Behavior |
| --- | --- | --- |
| `tools/list` | `name`, `kind` | Queues a standard MCP `tools/list` request. |
| `tools/call` | `name`, `kind`, `tool`, `args` | Queues a non-destructive MCP tool call. |
| `rpc` | `name`, `kind`, `rpc` | Queues raw JSON-RPC for edge cases. |

Keep default tasks non-destructive. A public profile should enumerate tools, read metadata, or call harmless discovery operations. Do not ship tasks that mutate external services, change devices, delete files, or exfiltrate secrets.

## Workflow

1. Scan the target origin and identify the MCP transport, path, and port.
2. Confirm the server accepts browser-originated requests after DNS rebinding.
3. Create a profile under `examples/framework/` using reserved example values and safe tasks.
4. Validate:

```sh
npm run validate
```

5. Add the profile to docs only after the behavior is repeatable.

## Existing Examples

| File | Purpose |
| --- | --- |
| `examples/framework/streamable-mcp-target.json` | Generic Streamable HTTP MCP profile. |
| `examples/framework/tapo-root-target.json` | Root-path Streamable HTTP profile with a safe discovery task. |
