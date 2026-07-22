# Testing

This page is for local development, regression testing, and demo fallback. It is not required for a normal deployment.

## Demo Mode

Use demo mode when you need a reliable local MCP target for a recording, conference booth, or regression check. It avoids relying on a third-party MCP server while still exercising the scanner, target selection, DNS rebinding launch, dashboard capture, and `/ops` workflow.

Start the mock MCP lab:

```sh
npm run mock:lab
```

Then use the extension scanner:

```text
Target: localtest.me
Ports: 8080-8092
```

Expected flow:

1. The scanner finds several mock MCP services.
2. Select a finding whose port is also exposed by `singularity.http_ports`.
3. Click **DNS Rebind**.
4. Open the dashboard when the finding shows **Open Dashboard**.
5. Queue `tools/list` from `/ops` and confirm a result returns.

If `8080-8092` is busy:

```sh
MOCK_MCP_BASE_PORT=18080 npm run mock:lab
```

Then scan:

```text
Target: localtest.me
Ports: 18080-18092
```

For a full DNS rebinding demo, the selected mock MCP port must also be present in `singularity.http_ports` and allowed by the VM inbound rules. If you only need scanner footage, the deployed VM is not required.

## Source Build

Use the source build only when developing the extension or testing local MCP detection.

1. Open `chrome://extensions`.
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select the repository root.
5. Click the extension action.
6. Target `localtest.me`.
7. Scan `8000-9000`.

The source build grants:

```text
http://localtest.me:*/*
http://*.localtest.me:*/*
http://*.rebind.example.com/*
http://dashboard.example.com/*
```

## Mock MCP Lab

The mock lab is the controlled target set used by Demo Mode. It includes Streamable HTTP, SSE-wrapped JSON-RPC, legacy SSE, strict Origin behavior, protocol fallback, session-based MCP, auth-required MCP, broken MCP, authenticated-context exposure, and root-path Streamable MCP.

## Validation

Run:

```sh
npm run validate
git diff --check
```

Validation checks JavaScript syntax, manifest JSON, evidence handling, framework contracts, dashboard service behavior, and shell script syntax.

## Known Limits

- Operator infrastructure setup is deployment-specific. Review generated plans before applying them to a VM.
- The source build is configured for local testing. Use packed builds for deployment-specific domains and dashboards.
- Chrome Site access can block targets that are not granted to the extension.
- Some MCP servers tolerate only one useful Streamable HTTP session. The scanner avoids extra initialize calls during header probing, but live demos should still be paced carefully.
