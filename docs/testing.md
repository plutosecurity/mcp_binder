# Testing

This page is for local development and regression testing. It is not required for a normal deployment.

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

Start the local mock lab:

```sh
npm run mock:lab
```

Then scan:

```text
target: localtest.me
ports: 8080-8092
```

If `8080-8092` is busy:

```sh
MOCK_MCP_BASE_PORT=18080 npm run mock:lab
```

Then scan:

```text
target: localtest.me
ports: 18080-18092
```

The mock lab includes Streamable HTTP, SSE-wrapped JSON-RPC, legacy SSE, strict Origin behavior, protocol fallback, session-based MCP, auth-required MCP, broken MCP, authenticated-context exposure, and root-path Streamable MCP.

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
