# Security Policy

MCP Binder is a security research framework. Treat reports about the framework itself differently from reports produced with the framework.

## Reporting A Vulnerability In MCP Binder

Report vulnerabilities in MCP Binder privately through GitHub Security Advisories for this repository.

If private advisories are unavailable, contact the maintainers privately before publishing technical details. Do not open a public issue that includes an exploit path, dashboard token handling issue, command injection path, or deployment secret exposure.

Include:

- affected version or commit;
- affected component;
- reproduction steps;
- expected impact;
- suggested fix, if known.

## Scope

In scope:

- command injection in deployment or cleanup scripts;
- unsafe dashboard authentication behavior;
- unintended exposure of dashboard tokens;
- unsafe generated extension permissions;
- evidence or telemetry leaks caused by MCP Binder itself;
- unsafe defaults that expose more network surface than documented.

Out of scope:

- vulnerabilities in third-party MCP servers found with MCP Binder;
- cloud firewall misconfiguration on operator-owned infrastructure;
- DNS provider configuration mistakes outside the generated MCP Binder records;
- issues caused by publishing local deployment config files or private keys.

## Safe Use

Run MCP Binder only against systems and MCP servers you are authorized to test. The framework can queue MCP JSON-RPC calls through a captured browser session. That capability is intended for controlled security validation, product security testing, and defensive regression checks.

