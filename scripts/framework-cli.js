import fs from "node:fs";
import dns from "node:dns/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const rawArgs = process.argv.slice(2);
const outputJson = rawArgs.includes("--json");
const args = rawArgs.filter((arg) => arg !== "--json");
const ICON = {
  ok: "✓",
  info: "•",
  warn: "!",
  key: "🔑"
};

try {
  const result = await main(args);
  process.stdout.write(outputJson ? `${JSON.stringify(result, null, 2)}\n` : ensureTrailingNewline(formatResult(result)));
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}

async function main(argv) {
  const [command, ...rest] = argv;

  if (command === "validate-config") {
    const config = readFrameworkConfig(rest[0]);
    return {
      ok: true,
      command,
      config: summarizeFrameworkConfig(config),
      warnings: buildConfigWarnings(config)
    };
  }

  if (command === "derive-extension-config") {
    const configPath = rest[0];
    const outPath = getOption(rest, "--out");
    assert(configPath, "derive-extension-config requires a framework config path");
    assert(outPath, "derive-extension-config requires --out");

    const config = readFrameworkConfig(configPath);
    const extensionConfig = deriveExtensionConfig(config);
    writeJson(outPath, extensionConfig);

    return {
      ok: true,
      command,
      out: outPath,
      config: extensionConfig
    };
  }

  if (command === "preflight") {
    const configPath = rest[0];
    assert(configPath, "preflight requires a framework config path");
    const offline = rest.includes("--offline");
    const config = readFrameworkConfig(configPath);

    return buildPreflight(config, { offline });
  }

  if (command === "plan-vm-setup") {
    const configPath = rest[0];
    const outDir = getOption(rest, "--out");
    assert(configPath, "plan-vm-setup requires a framework config path");
    assert(outDir, "plan-vm-setup requires --out");

    const config = readFrameworkConfig(configPath);
    return writeVmSetupPlan(config, outDir);
  }

  if (command === "dns") {
    return dnsCommand(rest);
  }

  if (command === "attacker" || command === "vm") {
    return attackerCommand(rest, { namespace: command });
  }

  if (command === "extension") {
    return extensionCommand(rest);
  }

  if (command === "bootstrap") {
    return bootstrapCommand(rest);
  }

  if (command === "pack-extension") {
    const configPath = getOption(rest, "--config");
    const outDir = getOption(rest, "--out");
    assert(configPath, "pack-extension requires --config");
    assert(outDir, "pack-extension requires --out");

    const extensionConfig = readJson(configPath);
    validateExtensionConfig(extensionConfig);

    return packExtension(extensionConfig, outDir);
  }

  throw new Error(`unknown command: ${command || "(missing)"}`);
}

async function dnsCommand(argv) {
  const [subcommand, ...rest] = argv;
  const configPath = getOption(rest, "--config");
  assert(configPath, "dns command requires --config");
  const config = readFrameworkConfig(configPath);

  if (subcommand === "plan") {
    const outDir = getOption(rest, "--out");
    assert(outDir, "dns plan requires --out");
    return writeDnsPlan(config, outDir);
  }

  if (subcommand === "apply") {
    const outDir = getOption(rest, "--out") || path.join("dist", "dns-plan");
    const plan = writeDnsPlan(config, outDir);
    const hostedZoneId = getOption(rest, "--hosted-zone-id") || config.dns.hostedZoneId || "";
    const apply = rest.includes("--apply");
    const changeBatchPath = path.join(outDir, "route53-change-batch.json");
    const nextCommand = route53ApplyCommand(hostedZoneId || "<parent-hosted-zone-id>", changeBatchPath);

    if (!apply) {
      return {
        ok: true,
        command: "dns apply",
        provider: dnsProvider(config),
        dryRun: true,
        out: outDir,
        plan,
        nextCommand
      };
    }

    assert(hostedZoneId, "dns apply --apply requires --hosted-zone-id or dns.hostedZoneId");
    const output = execFileSync("aws", [
      "route53",
      "change-resource-record-sets",
      "--hosted-zone-id",
      hostedZoneId,
      "--change-batch",
      `file://${changeBatchPath}`
    ], { encoding: "utf8" });

    return {
      ok: true,
      command: "dns apply",
      provider: dnsProvider(config),
      dryRun: false,
      out: outDir,
      aws: parseJsonOutput(output)
    };
  }

  if (subcommand === "verify") {
    const offline = rest.includes("--offline");
    const stage = getOption(rest, "--stage") || "records";
    assert(stage === "records", "dns verify currently supports only --stage records");
    return verifyDns(config, { offline, stage });
  }

  throw new Error(`unknown dns command: ${subcommand || "(missing)"}`);
}

async function attackerCommand(argv, options = {}) {
  const [subcommand, ...rest] = argv;
  const configPath = getOption(rest, "--config");
  assert(configPath, "vm command requires --config");
  const config = readFrameworkConfig(configPath);

  if (subcommand === "deploy") {
    return runOrDescribeAttackerScript(config, {
      action: "deploy",
      namespace: options.namespace,
      execute: rest.includes("--execute"),
      extraArgs: rest.includes("--clear-existing") ? ["--clear-existing"] : []
    });
  }

  if (subcommand === "clean") {
    return runOrDescribeAttackerScript(config, {
      action: "clean",
      namespace: options.namespace,
      execute: rest.includes("--execute"),
      extraArgs: [
        "--yes",
        ...(rest.includes("--purge-backups") ? ["--purge-backups"] : []),
        ...(rest.includes("--keep-token") ? ["--keep-token"] : [])
      ]
    });
  }

  if (subcommand === "verify") {
    const offline = rest.includes("--offline");
    return verifyAttacker(config, { offline, namespace: options.namespace });
  }

  throw new Error(`unknown attacker command: ${subcommand || "(missing)"}`);
}

function extensionCommand(argv) {
  const [subcommand, ...rest] = argv;
  if (subcommand !== "pack") {
    throw new Error(`unknown extension command: ${subcommand || "(missing)"}`);
  }
  const configPath = getOption(rest, "--config");
  const outDir = getOption(rest, "--out");
  assert(configPath, "extension pack requires --config");
  assert(outDir, "extension pack requires --out");
  const config = readFrameworkConfig(configPath);
  const extensionConfig = deriveExtensionConfig(config);
  const result = packExtension(extensionConfig, outDir);
  return {
    ...result,
    command: "extension pack"
  };
}

async function bootstrapCommand(argv) {
  const configPath = getOption(argv, "--config");
  const outDir = getOption(argv, "--out") || path.join("dist", "mcp-binder-lab");
  assert(configPath, "bootstrap requires --config");
  const config = readFrameworkConfig(configPath);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const dnsPlan = dnsProvider(config) === "route53"
    ? writeDnsPlan(config, path.join(outDir, "dns"))
    : {
        ok: true,
        command: "dns prerequisite",
        provider: dnsProvider(config),
        out: null,
        records: route53RecordSummary(config)
      };
  const attackerDeploy = runOrDescribeAttackerScript(config, {
    action: "deploy",
    namespace: "vm",
    execute: argv.includes("--deploy"),
    extraArgs: argv.includes("--clear-existing") ? ["--clear-existing"] : []
  });
  const extensionPack = extensionCommand([
    "pack",
    "--config",
    configPath,
    "--out",
    path.join(outDir, "extension")
  ]);

  const steps = [
    dnsProvider(config) === "route53"
      ? {
          name: "dns.plan",
          status: "done",
          out: dnsPlan.out
        }
      : {
          name: "dns.prerequisite",
          status: "operator-owned",
          records: dnsPlan.records
        },
    {
      name: "vm.deploy",
      status: attackerDeploy.dryRun ? "dry-run" : "done",
      commandLine: attackerDeploy.commandLine
    },
    {
      name: "extension.pack",
      status: "done",
      out: extensionPack.out
    }
  ];

  writeJson(path.join(outDir, "bootstrap-summary.json"), {
    generatedAt: new Date().toISOString(),
    dryRun: !argv.includes("--deploy"),
    tokenFile: config.dashboard.auth.tokenFile || "dist/mcp-binder-dashboard-token",
    steps
  });

  return {
    ok: true,
    command: "bootstrap",
    dryRun: !argv.includes("--deploy"),
    out: outDir,
    tokenFile: config.dashboard.auth.tokenFile || "dist/mcp-binder-dashboard-token",
    steps
  };
}

function readFrameworkConfig(file) {
  assert(file, "framework config path is required");
  const config = normalizeFrameworkConfig(readJson(file));
  validateFrameworkConfig(config, file);
  return config;
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file}: ${error.message}`);
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

function validateFrameworkConfig(config, label) {
  for (const requiredPath of [
    "frameworkVersion",
    "attacker.publicIp",
    "attacker.sshHost",
    "attacker.sshUser",
    "attacker.sshKeyPath",
    "dns.rebindDomain",
    "dns.dashboardFqdn",
    "dashboard.baseUrl",
    "dashboard.port",
    "dashboard.auth.mode",
    "singularity.launcherPort",
    "singularity.httpPorts",
    "extension.name",
    "extension.defaultProvider",
    "extension.dashboardMode",
    "extension.hostPermissions"
  ]) {
    assert(getPath(config, requiredPath) !== undefined, `${label} missing ${requiredPath}`);
  }

  assert(Array.isArray(config.singularity.httpPorts), `${label} singularity.httpPorts must be an array`);
  assert(config.singularity.httpPorts.length > 0, `${label} singularity.httpPorts must not be empty`);
  assert(Array.isArray(config.extension.hostPermissions), `${label} extension.hostPermissions must be an array`);
  assert(config.extension.hostPermissions.length > 0, `${label} extension.hostPermissions must not be empty`);
  assert(
    config.extension.hostPermissions.some((pattern) => pattern.includes(config.dns.rebindDomain)),
    `${label} extension.hostPermissions must include the rebind domain`
  );
  assert(
    !config.dns.dashboardFqdn.endsWith(`.${config.dns.rebindDomain}`),
    `${label} dashboard FQDN must be outside the delegated rebind domain`
  );
}

function normalizeFrameworkConfig(raw) {
  const frameworkVersion = firstDefined(raw.frameworkVersion, raw.framework_version, "0.1.0");
  const vmAccess = normalizeVmAccess(raw.attacker || raw.operator || {});
  const attacker = { ...vmAccess };
  const rawDns = raw.dns || {};
  const dns = {
    provider: "manual",
    ttl: 60,
    ...rawDns,
    rebindDomain: firstDefined(rawDns.rebindDomain, rawDns.rebind_domain),
    dashboardFqdn: firstDefined(rawDns.dashboardFqdn, rawDns.dashboard_fqdn),
    hostedZoneId: firstDefined(rawDns.hostedZoneId, rawDns.hosted_zone_id)
  };
  const rawDashboard = raw.dashboard || {};
  const rawDashboardAuth = rawDashboard.auth || {};
  const rawSingularity = raw.singularity || {};
  const rawExtension = raw.extension || {};
  const dashboardPort = rawDashboard.port || raw.ports?.dashboard || 8090;
  const dashboardBaseUrl = firstDefined(rawDashboard.baseUrl, rawDashboard.base_url) || `http://${dns.dashboardFqdn}:${dashboardPort}`;
  const launcherPort = firstDefined(rawSingularity.launcherPort, rawSingularity.launcher_port, raw.ports?.launcher, 8080);
  const httpPorts = firstDefined(rawSingularity.httpPorts, rawSingularity.http_ports, raw.ports?.http, range(8080, 8089));
  const extraHttpPorts = firstDefined(rawSingularity.extraHttpPorts, rawSingularity.extra_http_ports, raw.ports?.extraHttp, raw.ports?.extra_http, []);
  const dashboardHostPermission = originPermission(dashboardBaseUrl);
  const hostPermissions = firstDefined(rawExtension.hostPermissions, rawExtension.host_permissions, [
    `http://*.${dns.rebindDomain}/*`,
    dashboardHostPermission
  ]);

  return {
    ...raw,
    frameworkVersion,
    attacker,
    dns: {
      ...dns,
      records: dns.records || derivedDnsRecords({ dns, attacker })
    },
    dashboard: {
      ...rawDashboard,
      baseUrl: dashboardBaseUrl,
      port: dashboardPort,
      evidenceDir: firstDefined(rawDashboard.evidenceDir, rawDashboard.evidence_dir, "/var/lib/mcp_binder/evidence"),
      healthPath: firstDefined(rawDashboard.healthPath, rawDashboard.health_path, "/healthz"),
      auth: {
        mode: "bearer-token",
        tokenEnv: "MCP_BINDER_DASHBOARD_TOKEN",
        tokenFile: "dist/mcp-binder-dashboard-token",
        ...rawDashboardAuth,
        tokenEnv: firstDefined(rawDashboardAuth.tokenEnv, rawDashboardAuth.token_env, "MCP_BINDER_DASHBOARD_TOKEN"),
        tokenFile: firstDefined(rawDashboardAuth.tokenFile, rawDashboardAuth.token_file, "dist/mcp-binder-dashboard-token")
      }
    },
    singularity: {
      launcherPort,
      httpPorts,
      extraHttpPorts,
      strategy: "fs",
      responseReboundIp: "127.0.0.1",
      payloadRoot: "/opt/singularity-payloads/html",
      ...rawSingularity,
      launcherPort,
      httpPorts,
      extraHttpPorts,
      responseReboundIp: firstDefined(rawSingularity.responseReboundIp, rawSingularity.response_rebound_ip, "127.0.0.1"),
      payloadRoot: firstDefined(rawSingularity.payloadRoot, rawSingularity.payload_root, "/opt/singularity-payloads/html")
    },
    extension: {
      name: "MCP Binder",
      defaultProvider: "singularity-compatible",
      dashboardMode: "remote-http",
      hostPermissions,
      buildOutput: "dist/mcp_binder",
      injectToken: false,
      ...rawExtension,
      defaultProvider: firstDefined(rawExtension.defaultProvider, rawExtension.default_provider, "singularity-compatible"),
      dashboardMode: firstDefined(rawExtension.dashboardMode, rawExtension.dashboard_mode, "remote-http"),
      hostPermissions,
      buildOutput: firstDefined(rawExtension.buildOutput, rawExtension.build_output, "dist/mcp_binder"),
      injectToken: firstDefined(rawExtension.injectToken, rawExtension.inject_token, false)
    },
    protectedDomains: firstDefined(raw.protectedDomains, raw.protected_domains, [])
  };
}

function normalizeVmAccess(value = {}) {
  return {
    ...value,
    publicIp: firstDefined(value.publicIp, value.public_ip),
    sshHost: firstDefined(value.sshHost, value.ssh_host),
    sshUser: firstDefined(value.sshUser, value.ssh_user),
    sshKeyPath: firstDefined(value.sshKeyPath, value.ssh_key_path),
    cloud: value.cloud,
    vmName: firstDefined(value.vmName, value.vm_name),
    resourceGroup: firstDefined(value.resourceGroup, value.resource_group)
  };
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function derivedDnsRecords({ dns, attacker }) {
  const ttl = dns.ttl || 60;
  const nsHost = `ns1.${dns.rebindDomain}`;
  return [
    {
      type: "A",
      name: dns.dashboardFqdn,
      value: attacker.publicIp,
      ttl
    },
    {
      type: "A",
      name: nsHost,
      value: attacker.publicIp,
      ttl
    },
    {
      type: "NS",
      name: dns.rebindDomain,
      value: `${nsHost}.`,
      ttl
    }
  ];
}

function originPermission(value) {
  try {
    const url = new URL(value);
    return `${url.protocol}//${url.hostname}/*`;
  } catch {
    return `http://${value}/*`;
  }
}

function range(start, end) {
  const values = [];
  for (let value = start; value <= end; value += 1) {
    values.push(value);
  }
  return values;
}

function validateExtensionConfig(config) {
  for (const requiredPath of [
    "name",
    "version",
    "dashboardUrl",
    "dashboardBaseUrl",
    "dashboardMode",
    "rebindDomain",
    "attackerIp",
    "hostPermissions",
    "defaultProvider",
    "launcherPort"
  ]) {
    assert(getPath(config, requiredPath) !== undefined, `extension build config missing ${requiredPath}`);
  }

  assert(Array.isArray(config.hostPermissions), "extension build config hostPermissions must be an array");
  assert(config.hostPermissions.length > 0, "extension build config hostPermissions must not be empty");
}

function deriveExtensionConfig(config) {
  return {
    name: config.extension.name,
    version: config.frameworkVersion,
    dashboardUrl: config.dashboard.baseUrl,
    dashboardBaseUrl: config.dashboard.baseUrl,
    dashboardMode: config.extension.dashboardMode,
    rebindDomain: config.dns.rebindDomain,
    attackerIp: config.attacker.publicIp,
    defaultProvider: config.extension.defaultProvider,
    launcherPort: config.singularity.launcherPort,
    hostPermissions: [...config.extension.hostPermissions],
    tokenPolicy: config.dashboard.auth.mode === "bearer-token" ? "operator-input" : "none",
    dashboardTokenFile: config.dashboard.auth.tokenFile || "",
    protectedDomains: [...(config.protectedDomains || [])]
  };
}

async function buildPreflight(config, options) {
  const keyPathExpanded = expandHome(config.attacker.sshKeyPath);
  const checks = options.offline ? buildOfflineChecks(config) : await buildOnlineChecks(config);

  return {
    ok: true,
    command: "preflight",
    mode: options.offline ? "offline" : "online",
    attacker: {
      publicIp: config.attacker.publicIp,
      sshHost: config.attacker.sshHost,
      sshUser: config.attacker.sshUser
    },
    ssh: {
      keyPath: config.attacker.sshKeyPath,
      keyPathExpanded,
      keyExists: pathExists(keyPathExpanded)
    },
    dns: {
      provider: config.dns.provider || "manual",
      rebindDomain: config.dns.rebindDomain,
      dashboardFqdn: config.dns.dashboardFqdn,
      records: config.dns.records || []
    },
    dashboard: {
      baseUrl: config.dashboard.baseUrl,
      port: config.dashboard.port,
      healthPath: config.dashboard.healthPath || "/healthz"
    },
    singularity: {
      launcherPort: config.singularity.launcherPort,
      httpPorts: config.singularity.httpPorts,
      extraHttpPorts: config.singularity.extraHttpPorts || [],
      strategy: config.singularity.strategy,
      responseReboundIp: config.singularity.responseReboundIp
    },
    checks,
    warnings: buildConfigWarnings(config)
  };
}

function buildOfflineChecks(config) {
  return [
    {
      name: "dns.rebindDomain",
      status: "skipped",
      target: config.dns.rebindDomain,
      reason: "offline preflight"
    },
    {
      name: "dns.dashboardFqdn",
      status: "skipped",
      target: config.dns.dashboardFqdn,
      reason: "offline preflight"
    },
    {
      name: "dashboard.health",
      status: "skipped",
      target: dashboardHealthUrl(config),
      reason: "offline preflight"
    },
    {
      name: "ports.expected",
      status: "info",
      target: config.attacker.publicIp,
      ports: expectedPorts(config),
      reason: "reported only"
    }
  ];
}

async function buildOnlineChecks(config) {
  const [rebindCheck, dashboardDnsCheck, dashboardHealthCheck] = await Promise.all([
    resolveCheck("dns.rebindDomain", config.dns.rebindDomain),
    resolveCheck("dns.dashboardFqdn", config.dns.dashboardFqdn),
    dashboardHealthCheckFor(config)
  ]);

  return [
    rebindCheck,
    dashboardDnsCheck,
    dashboardHealthCheck,
    {
      name: "ports.expected",
      status: "info",
      target: config.attacker.publicIp,
      ports: expectedPorts(config),
      reason: "reported only"
    }
  ];
}

async function resolveCheck(name, hostname) {
  try {
    const records = await retryDnsLookup(() => withTimeout(dns.lookup(hostname, { family: 4, all: true }), 2500, "DNS lookup timed out"));
    const addresses = records.map((record) => record.address);
    return {
      name,
      status: addresses.length > 0 ? "passed" : "failed",
      target: hostname,
      addresses
    };
  } catch (error) {
    return {
      name,
      status: "failed",
      target: hostname,
      error: describeError(error)
    };
  }
}

async function dashboardHealthCheckFor(config) {
  const url = dashboardHealthUrl(config);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);

  try {
    const response = await fetch(url, {
      method: "GET",
      signal: controller.signal
    });
    return {
      name: "dashboard.health",
      status: response.ok ? "passed" : "failed",
      target: url,
      httpStatus: response.status
    };
  } catch (error) {
    return {
      name: "dashboard.health",
      status: "failed",
      target: url,
      error: describeError(error)
    };
  } finally {
    clearTimeout(timeout);
  }
}

function packExtension(extensionConfig, outDir) {
  const startedAt = new Date().toISOString();
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  let copiedFiles = 0;
  copiedFiles += copyPath("manifest.json", path.join(outDir, "manifest.json"));
  copiedFiles += copyPath("README.md", path.join(outDir, "README.md"));
  copiedFiles += copyPath("icons", path.join(outDir, "icons"));
  copiedFiles += copyPath("src", path.join(outDir, "src"));
  copiedFiles += copyPath("ui", path.join(outDir, "ui"));

  const generatedDir = path.join(outDir, "generated");
  fs.mkdirSync(generatedDir, { recursive: true });
  writeJson(path.join(generatedDir, "extension-build-config.json"), extensionConfig);
  writeJson(path.join(generatedDir, "runtime-config.json"), buildRuntimeConfig(extensionConfig));
  writeJson(path.join(outDir, "manifest.json"), buildPackedManifest(extensionConfig));

  const buildSummary = {
    generatedAt: startedAt,
    name: extensionConfig.name,
    version: extensionConfig.version,
    dashboardMode: extensionConfig.dashboardMode,
    rebindDomain: extensionConfig.rebindDomain,
    dashboardUrl: extensionConfig.dashboardUrl,
    dashboardTokenFile: extensionConfig.dashboardTokenFile || "",
    copiedFiles
  };
  writeJson(path.join(generatedDir, "build-summary.json"), buildSummary);

  return {
    ok: true,
    command: "pack-extension",
    out: outDir,
    summary: buildSummary
  };
}

function writeDnsPlan(config, outDir) {
  assert(dnsProvider(config) === "route53", `unsupported DNS provider: ${dnsProvider(config)}`);
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const zoneFile = path.join(outDir, "route53.zone");
  const changeBatch = path.join(outDir, "route53-change-batch.json");
  const baseArgs = route53DnsArgs(config);

  execFileSync("bash", [
    "scripts/dns-route53-records.sh",
    "zone-file",
    ...baseArgs,
    "--out",
    zoneFile
  ], { stdio: "pipe" });

  execFileSync("bash", [
    "scripts/dns-route53-records.sh",
    "change-batch",
    ...baseArgs,
    "--out",
    changeBatch
  ], { stdio: "pipe" });

  return {
    ok: true,
    command: "dns plan",
    provider: dnsProvider(config),
    out: outDir,
    files: {
      zoneFile,
      changeBatch
    },
    records: route53RecordSummary(config)
  };
}

function route53DnsArgs(config) {
  return [
    "--dashboard-domain",
    config.dns.dashboardFqdn,
    "--rebind-domain",
    config.dns.rebindDomain,
    "--public-ip",
    config.attacker.publicIp,
    "--ttl",
    String(config.dns.ttl || 60)
  ];
}

function route53RecordSummary(config) {
  const nsHost = `ns1.${config.dns.rebindDomain}`;
  return [
    {
      type: "A",
      name: config.dns.dashboardFqdn,
      value: config.attacker.publicIp,
      ttl: config.dns.ttl || 60
    },
    {
      type: "A",
      name: nsHost,
      value: config.attacker.publicIp,
      ttl: config.dns.ttl || 60
    },
    {
      type: "NS",
      name: config.dns.rebindDomain,
      value: `${nsHost}.`,
      ttl: config.dns.ttl || 60
    }
  ];
}

function route53ApplyCommand(hostedZoneId, changeBatchPath) {
  return [
    "aws",
    "route53",
    "change-resource-record-sets",
    "--hosted-zone-id",
    hostedZoneId,
    "--change-batch",
    `file://${changeBatchPath}`
  ].map(shellArg).join(" ");
}

async function verifyDns(config, options) {
  const nsHost = `ns1.${config.dns.rebindDomain}`;
  const expectedNs = `${nsHost}.`;
  if (options.offline) {
    return {
      ok: true,
      command: "dns verify",
      mode: "offline",
      stage: options.stage,
      provider: dnsProvider(config),
      checks: [
        {
          name: "dashboard.a",
          status: "info",
          target: config.dns.dashboardFqdn,
          expected: config.attacker.publicIp
        },
        {
          name: "nameserver.a",
          status: "info",
          target: nsHost,
          expected: config.attacker.publicIp
        },
        {
          name: "rebind.ns",
          status: "info",
          target: config.dns.rebindDomain,
          expected: expectedNs
        }
      ]
    };
  }

  const dashboardParentZone = parentDomain(config.dns.dashboardFqdn);
  const rebindParentZone = parentDomain(config.dns.rebindDomain);
  const dashboardAuthority = await authoritativeResolverForZone(dashboardParentZone);
  const rebindResolver = dashboardParentZone === rebindParentZone
    ? dashboardAuthority
    : await authoritativeResolverForZone(rebindParentZone);

  const [dashboard, nameserver, ns] = await Promise.all([
    resolveARecordCheck("dashboard.a", config.dns.dashboardFqdn, config.attacker.publicIp, dashboardAuthority.resolver, dashboardParentZone),
    resolveNameserverAddressCheck("nameserver.a", nsHost, config.attacker.publicIp, config.dns.rebindDomain, rebindResolver, rebindParentZone),
    resolveDelegationNsCheck("rebind.ns", config.dns.rebindDomain, expectedNs, rebindResolver, rebindParentZone)
  ]);

  return {
    ok: true,
    command: "dns verify",
    mode: "online",
    stage: options.stage,
    provider: dnsProvider(config),
    checks: [dashboard, nameserver, ns]
  };
}

async function resolveARecordCheck(name, hostname, expected, resolver = dns, zone = "") {
  try {
    const addresses = await retryDnsLookup(() => withTimeout(resolver.resolve4(hostname), 2500, "A lookup timed out"));
    return {
      name,
      status: addresses.includes(expected) ? "passed" : "failed",
      target: hostname,
      expected,
      zone,
      addresses
    };
  } catch (error) {
    return {
      name,
      status: "failed",
      target: hostname,
      expected,
      zone,
      error: describeError(error)
    };
  }
}

async function resolveNsCheck(name, hostname, expected, resolver = dns, zone = "") {
  try {
    const records = await retryDnsLookup(() => withTimeout(resolver.resolveNs(hostname), 2500, "NS lookup timed out"));
    const normalizedExpected = normalizeDnsName(expected);
    const normalizedRecords = records.map(normalizeDnsName);
    return {
      name,
      status: normalizedRecords.includes(normalizedExpected) ? "passed" : "failed",
      target: hostname,
      expected,
      zone,
      records
    };
  } catch (error) {
    return {
      name,
      status: "failed",
      target: hostname,
      expected,
      zone,
      error: describeError(error)
    };
  }
}

async function authoritativeResolverForZone(zone) {
  const nameservers = await retryDnsLookup(() => withTimeout(dns.resolveNs(zone), 2500, `NS lookup timed out for ${zone}`));
  const addresses = [];
  for (const nameserver of nameservers) {
    try {
      addresses.push(...await retryDnsLookup(() => withTimeout(dns.resolve4(nameserver), 2500, `A lookup timed out for ${nameserver}`)));
    } catch {
      // Keep trying the remaining authoritative nameservers.
    }
  }
  assert(addresses.length > 0, `could not resolve authoritative nameservers for ${zone}`);
  const resolver = new dns.Resolver();
  resolver.setServers(addresses);
  return {
    resolver,
    nameservers
  };
}

async function resolveNameserverAddressCheck(name, hostname, expected, delegatedZone, authority, zone = "") {
  try {
    const addresses = await resolveGlueAWithDig(hostname, delegatedZone, authority.nameservers);
    return {
      name,
      status: addresses.includes(expected) ? "passed" : "failed",
      target: hostname,
      expected,
      zone,
      addresses
    };
  } catch {
    return resolveARecordCheck(name, hostname, expected, authority.resolver, zone);
  }
}

async function resolveGlueAWithDig(hostname, delegatedZone, nameservers) {
  const addresses = [];
  for (const nameserver of nameservers) {
    try {
      const output = execFileSync("dig", [
        `@${nameserver}`,
        hostname,
        "A",
        "+norecurse",
        "+noall",
        "+answer",
        "+authority",
        "+additional"
      ], { encoding: "utf8", timeout: 3000 });
      addresses.push(...parseARecords(output, hostname));
    } catch {
      // Try the next authoritative nameserver.
    }
  }
  assert(addresses.length > 0, `no glue A record returned for ${hostname} under ${delegatedZone}`);
  return unique(addresses);
}

async function resolveDelegationNsCheck(name, hostname, expected, authority, zone = "") {
  try {
    const records = await resolveDelegationNsWithDig(hostname, authority.nameservers);
    const normalizedExpected = normalizeDnsName(expected);
    const normalizedRecords = records.map(normalizeDnsName);
    return {
      name,
      status: normalizedRecords.includes(normalizedExpected) ? "passed" : "failed",
      target: hostname,
      expected,
      zone,
      records
    };
  } catch {
    return resolveNsCheck(name, hostname, expected, authority.resolver, zone);
  }
}

async function resolveDelegationNsWithDig(hostname, nameservers) {
  const records = [];
  for (const nameserver of nameservers) {
    try {
      const output = execFileSync("dig", [
        `@${nameserver}`,
        hostname,
        "NS",
        "+norecurse",
        "+noall",
        "+answer",
        "+authority"
      ], { encoding: "utf8", timeout: 3000 });
      records.push(...parseNsRecords(output, hostname));
    } catch {
      // Try the next authoritative nameserver.
    }
  }
  assert(records.length > 0, `no NS delegation returned for ${hostname}`);
  return unique(records);
}

function parseARecords(output, hostname) {
  const normalizedHost = normalizeDnsName(hostname);
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/))
    .filter((parts) => normalizeDnsName(parts[0] || "") === normalizedHost && String(parts[3] || "").toUpperCase() === "A" && parts[4])
    .map((parts) => parts[4]);
}

function parseNsRecords(output, hostname) {
  const normalizedHost = normalizeDnsName(hostname);
  return output
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => line.split(/\s+/))
    .filter((parts) => normalizeDnsName(parts[0] || "") === normalizedHost && String(parts[3] || "").toUpperCase() === "NS" && parts[4])
    .map((parts) => normalizeDnsName(parts[4]));
}

function runOrDescribeAttackerScript(config, options) {
  const namespace = options.namespace || "vm";
  const args = options.action === "deploy"
    ? attackerDeployArgs(config, options.extraArgs)
    : attackerCleanArgs(config, options.extraArgs);
  const script = options.action === "deploy"
    ? "scripts/deploy-attacker-ssh.sh"
    : "scripts/clean-attacker-ssh.sh";
  const commandLine = [script, ...args].map(shellArg).join(" ");

  if (!options.execute) {
    return {
      ok: true,
      command: `${namespace} ${options.action}`,
      provider: "ssh",
      dryRun: true,
      script,
      args,
      commandLine
    };
  }

  execFileSync("bash", [script, ...args], { stdio: "inherit" });
  return {
    ok: true,
    command: `${namespace} ${options.action}`,
    provider: "ssh",
    dryRun: false,
    script,
    args,
    commandLine
  };
}

function attackerDeployArgs(config, extraArgs = []) {
  return compact([
    "--host",
    config.attacker.sshHost,
    "--user",
    config.attacker.sshUser,
    "--identity-file",
    config.attacker.sshKeyPath,
    "--public-ip",
    config.attacker.publicIp,
    "--rebind-domain",
    config.dns.rebindDomain,
    "--dashboard-domain",
    config.dns.dashboardFqdn,
    "--dashboard-port",
    String(config.dashboard.port),
    "--http-ports",
    httpPortsSpec(config),
    "--rebound-ip",
    config.singularity.responseReboundIp || "127.0.0.1",
    "--dashboard-token-file",
    config.dashboard.auth.tokenFile || "dist/mcp-binder-dashboard-token",
    ...extraArgs
  ]);
}

function attackerCleanArgs(config, extraArgs = []) {
  return compact([
    "--host",
    config.attacker.sshHost,
    "--user",
    config.attacker.sshUser,
    "--identity-file",
    config.attacker.sshKeyPath,
    ...extraArgs
  ]);
}

async function verifyAttacker(config, options) {
  const namespace = options.namespace || "vm";
  if (options.offline) {
    return {
      ok: true,
      command: `${namespace} verify`,
      mode: "offline",
      checks: [
        {
          name: "ssh.target",
          status: "info",
          target: `${config.attacker.sshUser}@${config.attacker.sshHost}`,
          keyPath: config.attacker.sshKeyPath
        },
        {
          name: "dashboard.health",
          status: "skipped",
          target: dashboardHealthUrl(config),
          reason: "offline verification"
        },
        {
          name: "singularity.launcher",
          status: "skipped",
          target: `http://${config.attacker.publicIp}:${config.singularity.launcherPort}/payloads/victim-launcher.html`,
          reason: "offline verification"
        }
      ]
    };
  }

  const [dashboard, launcher] = await Promise.all([
    dashboardHealthCheckFor(config),
    httpCheck("singularity.launcher", `http://${config.attacker.publicIp}:${config.singularity.launcherPort}/payloads/victim-launcher.html`)
  ]);

  return {
    ok: true,
    command: `${namespace} verify`,
    mode: "online",
    checks: [dashboard, launcher]
  };
}

async function httpCheck(name, url) {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 2500);
  try {
    const response = await fetch(url, { method: "GET", signal: controller.signal });
    return {
      name,
      status: response.ok ? "passed" : "failed",
      target: url,
      httpStatus: response.status
    };
  } catch (error) {
    return {
      name,
      status: "failed",
      target: url,
      error: describeError(error)
    };
  } finally {
    clearTimeout(timeout);
  }
}

function buildRuntimeConfig(extensionConfig) {
  return {
    name: extensionConfig.name,
    version: extensionConfig.version,
    dashboardMode: extensionConfig.dashboardMode,
    dashboardBaseUrl: extensionConfig.dashboardBaseUrl || extensionConfig.dashboardUrl,
    dashboardUrl: extensionConfig.dashboardUrl,
    rebindDomain: extensionConfig.rebindDomain,
    attackerIp: extensionConfig.attackerIp,
    defaultProvider: extensionConfig.defaultProvider,
    launcherPort: extensionConfig.launcherPort,
    hostPermissions: extensionConfig.hostPermissions,
    scannerHostPermissions: scannerHostPermissions(),
    tokenPolicy: extensionConfig.tokenPolicy || "none"
  };
}

function buildPackedManifest(extensionConfig) {
  const manifest = readJson("manifest.json");
  return {
    ...manifest,
    name: extensionConfig.name,
    version: extensionConfig.version,
    host_permissions: unique([
      ...scannerHostPermissions(manifest),
      ...extensionConfig.hostPermissions
    ])
  };
}

function scannerHostPermissions(manifest = readJson("manifest.json")) {
  return (manifest.host_permissions || []).filter((permission) =>
    permission.startsWith("http://localtest.me:") ||
    permission.startsWith("http://*.localtest.me:")
  );
}

function writeVmSetupPlan(config, outDir) {
  fs.rmSync(outDir, { recursive: true, force: true });
  fs.mkdirSync(outDir, { recursive: true });

  const deploymentPlan = {
    generatedAt: new Date().toISOString(),
    mode: "dry-run",
    frameworkVersion: config.frameworkVersion,
    attacker: {
      publicIp: config.attacker.publicIp,
      sshHost: config.attacker.sshHost,
      sshUser: config.attacker.sshUser,
      cloud: config.attacker.cloud || "other",
      vmName: config.attacker.vmName || "",
      resourceGroup: config.attacker.resourceGroup || ""
    },
    dns: {
      provider: config.dns.provider || "manual",
      rebindDomain: config.dns.rebindDomain,
      dashboardFqdn: config.dns.dashboardFqdn,
      records: config.dns.records || []
    },
    dashboard: {
      baseUrl: config.dashboard.baseUrl,
      port: config.dashboard.port,
      healthPath: config.dashboard.healthPath || "/healthz",
      evidenceDir: config.dashboard.evidenceDir || "/var/lib/mcp_binder/evidence",
      authMode: config.dashboard.auth.mode
    },
    singularity: {
      launcherPort: config.singularity.launcherPort,
      httpPorts: config.singularity.httpPorts,
      extraHttpPorts: config.singularity.extraHttpPorts || [],
      strategy: config.singularity.strategy,
      responseReboundIp: config.singularity.responseReboundIp,
      payloadRoot: config.singularity.payloadRoot || "/opt/singularity-payloads/html"
    },
    operations: [
      {
        name: "install-system-packages",
        mutates: false,
        description: "Would install Go, Python runtime, reverse proxy dependencies, and service prerequisites."
      },
      {
        name: "write-dashboard-service",
        mutates: false,
        description: "Would write dashboard systemd unit and environment file."
      },
      {
        name: "write-singularity-service",
        mutates: false,
        description: "Would write Singularity-compatible DNS rebinding service unit."
      },
      {
        name: "open-required-ports",
        mutates: false,
        description: "Would verify cloud and host firewall rules for dashboard, launcher, and payload ports."
      }
    ]
  };

  writeJson(path.join(outDir, "deployment-plan.json"), deploymentPlan);
  writeText(path.join(outDir, "env.example"), renderEnvExample(config));
  writeText(path.join(outDir, "services", "dashboard.service"), renderDashboardService(config));
  writeText(path.join(outDir, "services", "singularity.service"), renderSingularityService(config));
  writeText(path.join(outDir, "scripts", "bootstrap-dry-run.sh"), renderBootstrapDryRun(config));
  fs.chmodSync(path.join(outDir, "scripts", "bootstrap-dry-run.sh"), 0o755);

  return {
    ok: true,
    command: "plan-vm-setup",
    out: outDir,
    files: [
      "deployment-plan.json",
      "env.example",
      "services/dashboard.service",
      "services/singularity.service",
      "scripts/bootstrap-dry-run.sh"
    ]
  };
}

function copyPath(source, target) {
  const stat = fs.statSync(source);

  if (stat.isDirectory()) {
    fs.mkdirSync(target, { recursive: true });
    let count = 0;
    for (const entry of fs.readdirSync(source)) {
      count += copyPath(path.join(source, entry), path.join(target, entry));
    }
    return count;
  }

  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.copyFileSync(source, target);
  return 1;
}

function summarizeFrameworkConfig(config) {
  return {
    frameworkVersion: config.frameworkVersion,
    attacker: {
      publicIp: config.attacker.publicIp,
      sshHost: config.attacker.sshHost,
      sshUser: config.attacker.sshUser
    },
    dns: {
      rebindDomain: config.dns.rebindDomain,
      dashboardFqdn: config.dns.dashboardFqdn,
      records: config.dns.records || []
    },
    dashboard: {
      baseUrl: config.dashboard.baseUrl,
      port: config.dashboard.port,
      healthPath: config.dashboard.healthPath,
      authMode: config.dashboard.auth.mode,
      tokenFile: config.dashboard.auth.tokenFile
    },
    singularity: {
      launcherPort: config.singularity.launcherPort,
      httpPorts: config.singularity.httpPorts
    },
    extension: {
      name: config.extension.name,
      dashboardMode: config.extension.dashboardMode,
      defaultProvider: config.extension.defaultProvider,
      hostPermissions: config.extension.hostPermissions
    }
  };
}

function buildConfigWarnings(config) {
  const warnings = [];

  if (config.dashboard.auth.mode === "bearer-token" && !config.dashboard.auth.tokenEnv && !config.dashboard.auth.tokenFile) {
    warnings.push("dashboard bearer-token mode should reference tokenEnv or tokenFile");
  }

  if (!config.dns.records?.some((record) => record.name === config.dns.dashboardFqdn)) {
    warnings.push("dns.records does not include dashboard FQDN");
  }

  return warnings;
}

function dashboardHealthUrl(config) {
  return `${config.dashboard.baseUrl.replace(/\/+$/, "")}${config.dashboard.healthPath || "/healthz"}`;
}

function describeError(error) {
  if (!(error instanceof Error)) {
    return String(error);
  }

  const cause = error.cause;
  if (cause && typeof cause === "object") {
    const code = "code" in cause ? cause.code : "";
    const message = "message" in cause ? cause.message : "";
    if (code || message) {
      return [code, message].filter(Boolean).join(": ");
    }
  }

  return error.message;
}

function normalizeDnsName(name) {
  return `${String(name).replace(/\.+$/, "")}.`.toLowerCase();
}

function parentDomain(hostname) {
  const labels = String(hostname).replace(/\.+$/, "").split(".");
  assert(labels.length > 1, `hostname has no parent domain: ${hostname}`);
  return labels.slice(1).join(".");
}

function expectedPorts(config) {
  return [
    config.dashboard.port,
    config.singularity.launcherPort,
    ...config.singularity.httpPorts,
    ...(config.singularity.extraHttpPorts || [])
  ].filter((port, index, ports) => Number.isInteger(port) && ports.indexOf(port) === index);
}

function dnsProvider(config) {
  return config.dns.provider || "manual";
}

function httpPortsSpec(config) {
  return config.singularity.httpPorts.join(",");
}

function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

function compact(values) {
  return values.filter((value) => value !== undefined && value !== null && value !== "");
}

function shellArg(value) {
  const text = String(value);
  if (/^[A-Za-z0-9_~./:@=,+-]+$/.test(text)) {
    return text;
  }
  return `'${text.replace(/'/g, "'\\''")}'`;
}

function parseJsonOutput(output) {
  try {
    return JSON.parse(output);
  } catch {
    return { raw: output };
  }
}

function ensureTrailingNewline(text) {
  return text.endsWith("\n") ? text : `${text}\n`;
}

function formatResult(result) {
  switch (result.command) {
    case "validate-config":
      return formatValidateConfig(result);
    case "preflight":
      return [
        `${ICON.info} MCP Binder preflight (${result.mode})`,
        "",
        `VM: ${result.attacker.sshUser}@${result.attacker.sshHost}`,
        `Dashboard: ${result.dashboard.baseUrl}`,
        `Rebind domain: ${result.dns.rebindDomain}`,
        "",
        formatChecks(result.checks),
        formatWarnings(result.warnings)
      ].filter(Boolean).join("\n").replace(/\n+$/, "\n");
    case "attacker deploy":
    case "attacker clean":
    case "vm deploy":
    case "vm clean":
      return formatAttackerCommand(result);
    case "attacker verify":
    case "vm verify":
    case "dns verify":
      return [
        result.stage
          ? `${ICON.info} MCP Binder ${result.command} ${result.stage} (${result.mode})`
          : `${ICON.info} MCP Binder ${result.command} (${result.mode})`,
        "",
        formatChecks(result.checks)
      ].filter(Boolean).join("\n").replace(/\n+$/, "\n");
    case "dns plan":
      return [
        `${ICON.ok} MCP Binder DNS plan written`,
        "",
        `Provider: ${result.provider}`,
        `Zone file: ${result.files.zoneFile}`,
        `Change batch: ${result.files.changeBatch}`,
        "",
        formatRecords(result.records)
      ].join("\n").replace(/\n+$/, "\n");
    case "dns apply":
      return [
        result.dryRun ? `${ICON.info} MCP Binder DNS apply preview` : `${ICON.ok} MCP Binder DNS apply complete`,
        "",
        `Provider: ${result.provider}`,
        `Output: ${result.out}`,
        result.nextCommand ? `Next command: ${result.nextCommand}` : ""
      ].filter(Boolean).join("\n").replace(/\n+$/, "\n");
    case "extension pack":
    case "pack-extension":
      return [
        `${ICON.ok} MCP Binder extension packed`,
        "",
        `Output: ${result.out}`,
        result.summary ? `Name: ${result.summary.name}` : "",
        result.summary ? `Rebind domain: ${result.summary.rebindDomain}` : "",
        result.summary ? `Dashboard: ${result.summary.dashboardUrl}` : "",
        result.summary?.dashboardTokenFile ? `${ICON.key} Token file: ${result.summary.dashboardTokenFile}` : ""
      ].filter(Boolean).join("\n").replace(/\n+$/, "\n");
    case "derive-extension-config":
      return `${ICON.ok} MCP Binder extension config written\n\nOutput: ${result.out}\n`;
    case "bootstrap":
      return formatBootstrap(result);
    case "plan-vm-setup":
      return `${ICON.ok} MCP Binder VM setup plan written\n\nOutput: ${result.out}\n`;
    default:
      return `${JSON.stringify(result, null, 2)}\n`;
  }
}

function formatValidateConfig(result) {
  const config = result.config;
  return [
    `${ICON.ok} MCP Binder config ready`,
    "",
    "VM",
    `  ${ICON.info} SSH: ${config.attacker.sshUser}@${config.attacker.sshHost}`,
    `  ${ICON.info} Public IP: ${config.attacker.publicIp}`,
    "",
    "DNS records to create",
    indent(formatRecords(config.dns.records), "  "),
    "",
    "Runtime",
    `  ${ICON.info} Dashboard: ${config.dashboard.baseUrl}`,
    `  ${ICON.info} Launcher: http://${config.attacker.publicIp}:${config.singularity.launcherPort}/payloads/victim-launcher.html`,
    `  ${ICON.info} Rebind ports: ${formatPorts(config.singularity.httpPorts)}`,
    "",
    "Extension",
    `  ${ICON.info} Name: ${config.extension.name}`,
    `  ${ICON.info} Host permissions: ${config.extension.hostPermissions.join(", ")}`,
    formatWarnings(result.warnings)
  ].filter(Boolean).join("\n").replace(/\n+$/, "\n");
}

function formatAttackerCommand(result) {
  const title = result.dryRun
    ? `${ICON.info} MCP Binder ${result.command} preview`
    : `${ICON.ok} MCP Binder ${result.command} complete`;
  return [
    title,
    "",
    `Provider: ${result.provider}`,
    `Script: ${result.script}`,
    result.commandLine ? "Command" : "",
    result.commandLine ? `  ${result.commandLine}` : ""
  ].filter(Boolean).join("\n").replace(/\n+$/, "\n");
}

function formatBootstrap(result) {
  const lines = [
    result.dryRun ? `${ICON.info} MCP Binder lab preview` : `${ICON.ok} MCP Binder lab built`,
    "",
    `Output: ${result.out}`,
    result.tokenFile ? `${ICON.key} Dashboard token: ${result.tokenFile}` : "",
    "",
    "Steps"
  ].filter(Boolean);
  for (const step of result.steps || []) {
    lines.push(`  ${statusIcon(step.status)} ${step.name} (${step.status})`);
    if (step.out) lines.push(`    output: ${step.out}`);
    if (step.records) lines.push(indent(formatRecords(step.records), "    "));
  }
  return `${lines.join("\n")}\n`;
}

function formatChecks(checks = []) {
  return checks.map((check) => {
    const status = check.status || "info";
    const target = check.target ? ` ${check.target}` : "";
    const reason = check.reason ? ` (${check.reason})` : "";
    const error = check.error ? `: ${check.error}` : "";
    const expected = check.status === "failed" && check.expected ? ` expected ${check.expected}` : "";
    return `${statusIcon(status)} ${check.name}${target}${expected}${reason}${error}`;
  }).join("\n");
}

function formatRecords(records = []) {
  return records.map((record) => `${fqdn(record.name)} ${record.ttl || 60} IN ${record.type} ${record.value}`).join("\n");
}

function fqdn(value) {
  return String(value || "").endsWith(".") ? String(value) : `${value}.`;
}

function formatWarnings(warnings = []) {
  if (!warnings.length) return "";
  return ["", "Warnings", ...warnings.map((warning) => `  ${ICON.warn} ${warning}`)].join("\n");
}

function statusIcon(status) {
  if (["done", "passed", "ok"].includes(status)) return ICON.ok;
  if (["failed", "error"].includes(status)) return ICON.warn;
  return ICON.info;
}

function formatPorts(ports = []) {
  if (!ports.length) return "-";
  const sorted = [...ports].sort((a, b) => a - b);
  const ranges = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (const port of sorted.slice(1)) {
    if (port === prev + 1) {
      prev = port;
      continue;
    }
    ranges.push(start === prev ? String(start) : `${start}-${prev}`);
    start = port;
    prev = port;
  }
  ranges.push(start === prev ? String(start) : `${start}-${prev}`);
  return ranges.join(", ");
}

function indent(text, prefix) {
  return String(text || "").split("\n").map((line) => `${prefix}${line}`).join("\n");
}

function renderEnvExample(config) {
  return [
    `MCP_BINDER_FRAMEWORK_VERSION=${config.frameworkVersion}`,
    `MCP_BINDER_PUBLIC_IP=${config.attacker.publicIp}`,
    `MCP_BINDER_REBIND_DOMAIN=${config.dns.rebindDomain}`,
    `MCP_BINDER_DASHBOARD_FQDN=${config.dns.dashboardFqdn}`,
    `MCP_BINDER_DASHBOARD_PORT=${config.dashboard.port}`,
    `MCP_BINDER_DASHBOARD_BASE_URL=${config.dashboard.baseUrl}`,
    `MCP_BINDER_EVIDENCE_DIR=${config.dashboard.evidenceDir || "/var/lib/mcp_binder/evidence"}`,
    `MCP_BINDER_LAUNCHER_PORT=${config.singularity.launcherPort}`,
    `MCP_BINDER_HTTP_PORTS=${config.singularity.httpPorts.join(",")}`,
    `MCP_BINDER_EXTRA_HTTP_PORTS=${(config.singularity.extraHttpPorts || []).join(",")}`,
    `MCP_BINDER_STRATEGY=${config.singularity.strategy}`,
    `MCP_BINDER_RESPONSE_REBOUND_IP=${config.singularity.responseReboundIp}`,
    `MCP_BINDER_DASHBOARD_TOKEN=replace-with-operator-token`,
    ""
  ].join("\n");
}

function renderDashboardService(config) {
  return [
    "[Unit]",
    "Description=MCP Binder dashboard",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    "EnvironmentFile=/etc/mcp_binder/env",
    "WorkingDirectory=/opt/mcp_binder",
    "ExecStart=/usr/bin/env node /opt/mcp_binder/services/dashboard-server.js --host 0.0.0.0 --port ${MCP_BINDER_DASHBOARD_PORT} --evidence-dir ${MCP_BINDER_EVIDENCE_DIR}",
    "Restart=on-failure",
    "RestartSec=3",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    ""
  ].join("\n");
}

function renderSingularityService(config) {
  return [
    "[Unit]",
    "Description=MCP Binder Singularity-Compatible Service",
    "After=network-online.target",
    "Wants=network-online.target",
    "",
    "[Service]",
    "Type=simple",
    "EnvironmentFile=/etc/mcp_binder/env",
    `WorkingDirectory=${config.singularity.payloadRoot || "/opt/singularity-payloads/html"}`,
    "ExecStart=/usr/local/bin/singularity-server",
    "Restart=on-failure",
    "RestartSec=3",
    "",
    "[Install]",
    "WantedBy=multi-user.target",
    ""
  ].join("\n");
}

function renderBootstrapDryRun(config) {
  return [
    "#!/usr/bin/env bash",
    "set -eu",
    "",
    "echo 'MCP Binder VM bootstrap dry-run only. No system changes will be applied.'",
    `echo 'Target VM: ${config.attacker.sshUser}@${config.attacker.sshHost}'`,
    `echo 'Dashboard: ${config.dashboard.baseUrl}'`,
    `echo 'Rebind domain: ${config.dns.rebindDomain}'`,
    `echo 'Expected ports: ${expectedPorts(config).join(",")}'`,
    "echo 'Review deployment-plan.json and service templates before applying any live setup.'",
    ""
  ].join("\n");
}

function writeText(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}

async function withTimeout(promise, ms, message) {
  let timeout;
  const timeoutPromise = new Promise((_resolve, reject) => {
    timeout = setTimeout(() => reject(new Error(message)), ms);
  });

  try {
    return await Promise.race([promise, timeoutPromise]);
  } finally {
    clearTimeout(timeout);
  }
}

async function retryDnsLookup(operation, options = {}) {
  const attempts = Number(options.attempts || 3);
  const delayMs = Number(options.delayMs || 450);
  let lastError;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === attempts) {
        break;
      }
      await sleep(delayMs * attempt);
    }
  }

  const message = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`${message} after ${attempts} attempts`);
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function getOption(argv, option) {
  const index = argv.indexOf(option);
  if (index === -1) {
    return undefined;
  }
  return argv[index + 1];
}

function getPath(value, propertyPath) {
  return propertyPath.split(".").reduce((current, key) => current?.[key], value);
}

function expandHome(filePath) {
  if (filePath === "~") {
    return os.homedir();
  }
  if (filePath.startsWith("~/")) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

function pathExists(filePath) {
  try {
    return fs.existsSync(filePath);
  } catch {
    return false;
  }
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
