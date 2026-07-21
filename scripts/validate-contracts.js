import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const requiredJsonFiles = [
  "schemas/framework-config.schema.json",
  "schemas/dashboard-state.schema.json",
  "schemas/provider-descriptor.schema.json",
  "schemas/extension-build-config.schema.json",
  "schemas/target-profile.schema.json",
  "schemas/evidence.schema.json",
  "framework-config.template.json",
  "examples/framework/minimal.framework-config.json",
  "examples/framework/generic.framework-config.json",
  "examples/framework/route53-example.framework-config.json",
  "examples/framework/tapo-root-target.json",
  "examples/framework/streamable-mcp-target.json"
];

for (const file of requiredJsonFiles) {
  assert(fs.existsSync(file), `missing required contract file: ${file}`);
}

const schemas = Object.fromEntries(
  requiredJsonFiles
    .filter((file) => file.startsWith("schemas/"))
    .map((file) => [file, readJson(file)])
);

for (const [file, schema] of Object.entries(schemas)) {
  assertEqual(schema.$schema, "https://json-schema.org/draft/2020-12/schema", `${file} $schema`);
  assert(schema.title, `${file} title is required`);
  assert(schema.type === "object", `${file} must describe a JSON object`);
}

const generic = readJson("examples/framework/generic.framework-config.json");
const publicTemplate = readJson("framework-config.template.json");
const minimal = readJson("examples/framework/minimal.framework-config.json");
const route53Example = readJson("examples/framework/route53-example.framework-config.json");
  const route53 = normalizeFrameworkFixture(route53Example);
  const tapo = readJson("examples/framework/tapo-root-target.json");
  const streamable = readJson("examples/framework/streamable-mcp-target.json");

assert(fs.existsSync("SECURITY.md"), "security policy exists");
assert(fs.existsSync("CONTRIBUTING.md"), "contributing guide exists");
assert(fs.existsSync("docs/cli.md"), "CLI reference exists");

validateFrameworkConfig(generic, "generic fixture");
validateFrameworkConfig(publicTemplate, "public framework template");
validateFrameworkConfig(route53Example, "route53 example fixture");
validateTargetProfile(tapo, "tapo target fixture");
validateTargetProfile(streamable, "streamable target fixture");
assert(!Object.prototype.hasOwnProperty.call(tapo, "exfil"), "tapo target fixture does not use legacy exfil endpoint");
assert(!Object.prototype.hasOwnProperty.call(streamable, "exfil"), "streamable target fixture does not use legacy exfil endpoint");

assertEqual(route53.dns.rebindDomain, "rebind.example.com", "route53 example rebind domain");
assertEqual(route53.dns.dashboardFqdn, "dashboard.example.com", "route53 example dashboard fqdn");
assertEqual(route53.operator.publicIp, "203.0.113.10", "route53 example public IP");
assertEqual(route53.extension.name, "MCP Binder Example", "route53 example extension name");
assert(Array.isArray(route53.protectedDomains) && route53.protectedDomains.length === 0, "route53 example has no private protected domains");

assertEqual(tapo.path, "/", "tapo root path");
assertEqual(tapo.transport, "streamable", "tapo transport");
assert(tapo.tasks.some((task) => task.kind === "tools/list"), "tapo target includes tools/list task");

validateFrameworkCli();

console.log("contracts ok");

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(`${file}: ${error.message}`);
  }
}

function validateFrameworkConfig(config, label) {
  const vmConfig = config.operator || {};
  const rebindDomain = pick(config.dns?.rebindDomain, config.dns?.rebind_domain);
  const dashboardFqdn = pick(config.dns?.dashboardFqdn, config.dns?.dashboard_fqdn);
  assert(rebindDomain !== undefined, `${label} missing dns.rebind_domain`);
  assert(dashboardFqdn !== undefined, `${label} missing dns.dashboard_fqdn`);
  assert(pick(vmConfig.publicIp, vmConfig.public_ip) !== undefined, `${label} missing VM public_ip`);
  assert(pick(vmConfig.sshHost, vmConfig.ssh_host) !== undefined, `${label} missing VM ssh_host`);
  assert(pick(vmConfig.sshUser, vmConfig.ssh_user) !== undefined, `${label} missing VM ssh_user`);
  assert(pick(vmConfig.sshKeyPath, vmConfig.ssh_key_path) !== undefined, `${label} missing VM ssh_key_path`);

  const httpPorts = pick(config.singularity?.httpPorts, config.singularity?.http_ports);
  if (httpPorts) {
    assert(Array.isArray(httpPorts), `${label} singularity.http_ports must be an array`);
    assert(httpPorts.length > 0, `${label} singularity.http_ports must not be empty`);
  }

  const hostPermissions = pick(config.extension?.hostPermissions, config.extension?.host_permissions);
  if (hostPermissions) {
    assert(Array.isArray(hostPermissions), `${label} extension.host_permissions must be an array`);
    assert(hostPermissions.some((pattern) => pattern.includes(rebindDomain)), `${label} extension host permissions must include rebind domain`);
    assert(hostPermissions.some((pattern) => pattern.includes(dashboardFqdn)), `${label} extension host permissions must include dashboard domain`);
  }

  assert(!dashboardFqdn.endsWith(`.${rebindDomain}`), `${label} dashboard fqdn must be outside rebind domain`);
}

function normalizeFrameworkFixture(config) {
  const vmConfig = config.operator || {};
  return {
    frameworkVersion: pick(config.frameworkVersion, config.framework_version, "0.1.0"),
    operator: {
      publicIp: pick(vmConfig.publicIp, vmConfig.public_ip),
      sshHost: pick(vmConfig.sshHost, vmConfig.ssh_host),
      sshUser: pick(vmConfig.sshUser, vmConfig.ssh_user),
      sshKeyPath: pick(vmConfig.sshKeyPath, vmConfig.ssh_key_path)
    },
    dns: {
      rebindDomain: pick(config.dns?.rebindDomain, config.dns?.rebind_domain),
      dashboardFqdn: pick(config.dns?.dashboardFqdn, config.dns?.dashboard_fqdn)
    },
    dashboard: {
      baseUrl: pick(config.dashboard?.baseUrl, config.dashboard?.base_url),
      port: config.dashboard?.port,
      auth: {
        tokenFile: pick(config.dashboard?.auth?.tokenFile, config.dashboard?.auth?.token_file)
      }
    },
    singularity: {
      launcherPort: pick(config.singularity?.launcherPort, config.singularity?.launcher_port)
    },
    extension: {
      name: config.extension?.name,
      dashboardMode: pick(config.extension?.dashboardMode, config.extension?.dashboard_mode),
      defaultProvider: pick(config.extension?.defaultProvider, config.extension?.default_provider),
      hostPermissions: pick(config.extension?.hostPermissions, config.extension?.host_permissions)
    },
    protectedDomains: pick(config.protectedDomains, config.protected_domains, [])
  };
}

function pick(...values) {
  return values.find((value) => value !== undefined && value !== null);
}

function validateTargetProfile(profile, label) {
  for (const path of ["name", "targetName", "transport", "port", "path", "strategy", "impact.summary", "tasks"]) {
    assert(getPath(profile, path) !== undefined, `${label} missing ${path}`);
  }

  assert(["streamable", "streamable-control", "sse", "ws-control"].includes(profile.transport), `${label} has unsupported transport`);
  assert(Number.isInteger(profile.port) && profile.port > 0 && profile.port < 65536, `${label} port must be valid`);
  assert(Array.isArray(profile.tasks) && profile.tasks.length > 0, `${label} tasks must not be empty`);
}

function getPath(value, path) {
  return path.split(".").reduce((current, key) => current?.[key], value);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

function assertEqual(actual, expected, message) {
  if (actual !== expected) {
    throw new Error(`${message}: expected ${expected}, got ${actual}`);
  }
}

function validateFrameworkCli() {
  const frameworkSource = fs.readFileSync("scripts/framework-cli.js", "utf8");
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-binder-framework-"));
  const extensionConfigPath = path.join(tempDir, "extension-build-config.json");
  const packOutputDir = path.join(tempDir, "packed-extension");
  const cliIngestTokenFile = path.join(tempDir, "mcp-binder-ingest-token");
  const route53CliConfigPath = path.join(tempDir, "route53-example.framework-config.json");
  const genericCliConfigPath = path.join(tempDir, "generic.framework-config.json");
  fs.writeFileSync(route53CliConfigPath, `${JSON.stringify({
    ...route53Example,
    dashboard: {
      ...(route53Example.dashboard || {}),
      auth: {
        ...(route53Example.dashboard?.auth || {}),
        ingest_token_file: cliIngestTokenFile
      }
    }
  }, null, 2)}\n`);
  fs.writeFileSync(genericCliConfigPath, `${JSON.stringify({
    ...generic,
    dashboard: {
      ...(generic.dashboard || {}),
      auth: {
        ...(generic.dashboard?.auth || {}),
        ingest_token_file: path.join(tempDir, "generic-ingest-token")
      }
    }
  }, null, 2)}\n`);

  const validateOutput = runCli(["validate-config", "examples/framework/route53-example.framework-config.json"]);
  assert(validateOutput.ok, "framework CLI validate-config returns ok");
  assertEqual(validateOutput.config.dns.rebindDomain, route53.dns.rebindDomain, "framework CLI validates rebind domain");
  const validateText = runTextCli(["validate-config", "examples/framework/minimal.framework-config.json"]);
  assert(validateText.includes("✓ MCP Binder config ready"), "framework CLI default validate output is human-readable");
  assert(validateText.includes("DNS records to create"), "framework CLI default validate output shows DNS records");
  assert(validateText.includes("dashboard.example.com. 60 IN A 203.0.113.10"), "framework CLI DNS summary uses zone-file-safe A record syntax");
  assert(validateText.includes("rebind.example.com. 60 IN NS ns1.rebind.example.com."), "framework CLI DNS summary uses zone-file-safe NS record syntax");
  assert(!validateText.includes("ttl=60"), "framework CLI DNS summary does not append non-zone ttl syntax");
  assert(!validateText.trimStart().startsWith("{"), "framework CLI default output is not raw JSON");

  const minimalValidateOutput = runCli(["validate-config", "examples/framework/minimal.framework-config.json"]);
  assert(minimalValidateOutput.ok, "framework CLI validates minimal provider-neutral config");
  assertEqual(minimalValidateOutput.config.dashboard.baseUrl, "http://dashboard.example.com:8090", "minimal config derives dashboard URL");
  assertEqual(minimalValidateOutput.config.dashboard.port, 8090, "minimal config derives dashboard port");
  assertEqual(minimalValidateOutput.config.dashboard.healthPath, "/healthz", "minimal config derives unauthenticated dashboard health path");
  assertEqual(minimalValidateOutput.config.dashboard.tokenFile, "dist/mcp-binder-dashboard-token", "minimal config derives dashboard token file");
  assert(minimalValidateOutput.config.dns.records.some((record) => record.name === "dashboard.example.com" && record.value === "203.0.113.10"), "minimal config derives dashboard A record");
  assert(minimalValidateOutput.config.dns.records.some((record) => record.name === "rebind.example.com" && record.type === "NS"), "minimal config derives rebind NS record");
  assertEqual(minimalValidateOutput.config.singularity.launcherPort, 8080, "minimal config derives launcher port");
  assert(minimalValidateOutput.config.singularity.httpPorts.includes(8089), "minimal config derives default Singularity HTTP ports");
  assertEqual(minimalValidateOutput.config.extension.name, "MCP Binder", "minimal config derives extension name");
  assert(minimalValidateOutput.config.extension.hostPermissions.includes("http://*.rebind.example.com/*"), "minimal config derives rebind host permission");
  assert(minimalValidateOutput.config.extension.hostPermissions.includes("http://dashboard.example.com/*"), "minimal config derives dashboard host permission");

  const deriveOutput = runCli([
    "derive-extension-config",
    route53CliConfigPath,
    "--out",
    extensionConfigPath
  ]);
  assert(deriveOutput.ok, "framework CLI derive-extension-config returns ok");
  assert(fs.existsSync(extensionConfigPath), "framework CLI writes extension build config");

  const extensionConfig = readJson(extensionConfigPath);
  assertEqual(extensionConfig.name, route53.extension.name, "extension config name");
  assertEqual(extensionConfig.version, route53.frameworkVersion, "extension config version");
  assertEqual(extensionConfig.dashboardUrl, route53.dashboard.baseUrl, "extension config dashboard URL");
  assertEqual(extensionConfig.dashboardMode, route53.extension.dashboardMode, "extension config dashboard mode");
  assertEqual(extensionConfig.rebindDomain, route53.dns.rebindDomain, "extension config rebind domain");
  assertEqual(extensionConfig.operatorIp, route53.operator.publicIp, "extension configoperator IP");
  assertEqual(extensionConfig.defaultProvider, route53.extension.defaultProvider, "extension config provider");
  assertEqual(extensionConfig.launcherPort, route53.singularity.launcherPort, "extension config launcher port");
  assertEqual(extensionConfig.tokenPolicy, "operator-input", "extension config token policy");
  assertEqual(extensionConfig.dashboardTokenFile, route53.dashboard.auth.tokenFile, "extension config token file");
  assertEqual(extensionConfig.ingestTokenFile, cliIngestTokenFile, "extension config ingest token file");
  assert(extensionConfig.hostPermissions.includes(`http://*.${route53.dns.rebindDomain}/*`), "extension config includes rebind host permission");
  assertEqual(extensionConfig.dashboardBaseUrl, route53.dashboard.baseUrl, "extension config dashboard base URL");

  const preflightOutput = runCli(["preflight", route53CliConfigPath, "--offline"]);
  assert(preflightOutput.ok, "framework CLI preflight returns ok");
  assertEqual(preflightOutput.mode, "offline", "preflight mode");
  assertEqual(preflightOutput.operator.publicIp, route53.operator.publicIp, "preflight public IP");
  assertEqual(preflightOutput.ssh.keyPath, route53.operator.sshKeyPath, "preflight key path");
  assert(preflightOutput.ssh.keyPathExpanded.endsWith("/.ssh/mcp-binder-example.pem"), "preflight expands key path without reading it");
  assertEqual(preflightOutput.dns.rebindDomain, route53.dns.rebindDomain, "preflight rebind domain");
  assertEqual(preflightOutput.dns.dashboardFqdn, route53.dns.dashboardFqdn, "preflight dashboard fqdn");
  assertEqual(preflightOutput.dashboard.baseUrl, route53.dashboard.baseUrl, "preflight dashboard URL");
  assertEqual(preflightOutput.dashboard.healthPath, "/healthz", "preflight dashboard health path");
  assertEqual(preflightOutput.singularity.launcherPort, route53.singularity.launcherPort, "preflight launcher port");
  assert(Array.isArray(preflightOutput.checks), "preflight returns checks");
  assert(preflightOutput.checks.some((check) => check.name === "dns.rebindDomain" && check.status === "skipped"), "offline preflight skips rebind DNS check");
  assert(preflightOutput.checks.some((check) => check.name === "dashboard.health" && check.status === "skipped"), "offline preflight skips dashboard health check");

  const packOutput = runCli(["pack-extension", "--config", extensionConfigPath, "--out", packOutputDir]);
  assert(packOutput.ok, "framework CLI pack-extension returns ok");
  assert(fs.existsSync(path.join(packOutputDir, "manifest.json")), "packed extension has manifest");
  assert(fs.existsSync(path.join(packOutputDir, "icons", "icon16.png")), "packed extension has 16px icon");
  assert(fs.existsSync(path.join(packOutputDir, "icons", "icon32.png")), "packed extension has 32px icon");
  assert(fs.existsSync(path.join(packOutputDir, "icons", "icon48.png")), "packed extension has 48px icon");
  assert(fs.existsSync(path.join(packOutputDir, "icons", "icon128.png")), "packed extension has 128px icon");
  assert(fs.existsSync(path.join(packOutputDir, "src", "scanner.js")), "packed extension has scanner");
  assert(fs.existsSync(path.join(packOutputDir, "ui", "dashboard.html")), "packed extension has dashboard");
  assert(fs.existsSync(path.join(packOutputDir, "ui", "interactions.js")), "packed extension has shared UI interactions");
  assert(fs.existsSync(path.join(packOutputDir, "generated", "extension-build-config.json")), "packed extension has generated extension config");
  assert(fs.existsSync(path.join(packOutputDir, "generated", "runtime-config.json")), "packed extension has generated runtime config");
  assert(fs.existsSync(path.join(packOutputDir, "generated", "build-summary.json")), "packed extension has build summary");

  const packedManifest = readJson(path.join(packOutputDir, "manifest.json"));
  assert(packedManifest.host_permissions.includes("http://localtest.me:*/*"), "packed manifest keeps localtest.me scanner permission");
  assert(packedManifest.host_permissions.includes("http://*.localtest.me:*/*"), "packed manifest keeps localtest.me subdomain scanner permission");
  assert(!packedManifest.host_permissions.includes("http://127.0.0.1:*/*"), "packed manifest does not include direct 127.0.0.1 permission");
  assert(!packedManifest.host_permissions.includes("http://localhost:*/*"), "packed manifest does not include direct localhost permission");
  assert(packedManifest.host_permissions.includes(`http://*.${route53.dns.rebindDomain}/*`), "packed manifest includes configured rebind permission");
  assert(packedManifest.host_permissions.includes("http://dashboard.example.com/*"), "packed manifest includes configured dashboard permission");

  const runtimeConfig = readJson(path.join(packOutputDir, "generated", "runtime-config.json"));
  assertEqual(runtimeConfig.dashboardMode, "remote-http", "runtime config remote dashboard mode");
  assertEqual(runtimeConfig.dashboardBaseUrl, route53.dashboard.baseUrl, "runtime config dashboard base");
  assertEqual(runtimeConfig.rebindDomain, route53.dns.rebindDomain, "runtime config rebind domain");
  assertEqual(runtimeConfig.operatorIp, route53.operator.publicIp, "runtime configoperator IP");
  assertEqual(runtimeConfig.launcherPort, route53.singularity.launcherPort, "runtime config launcher port");
  assert(typeof runtimeConfig.ingestToken === "string" && runtimeConfig.ingestToken.length >= 32, "runtime config includes generated ingest token");

  const buildSummary = readJson(path.join(packOutputDir, "generated", "build-summary.json"));
  assertEqual(buildSummary.name, extensionConfig.name, "build summary name");
  assertEqual(buildSummary.rebindDomain, extensionConfig.rebindDomain, "build summary rebind domain");
  assertEqual(buildSummary.dashboardTokenFile, extensionConfig.dashboardTokenFile, "build summary token file");
  assertEqual(buildSummary.ingestTokenFile, extensionConfig.ingestTokenFile, "build summary ingest token file");
  assert(!Object.prototype.hasOwnProperty.call(buildSummary, "ingestToken"), "build summary does not expose ingest token value");
  assert(buildSummary.copiedFiles > 5, "build summary copied file count");
  const packTextOutput = runTextCli(["pack-extension", "--config", extensionConfigPath, "--out", path.join(tempDir, "packed-extension-text")]);
  assert(packTextOutput.includes(`Token file: ${extensionConfig.dashboardTokenFile}`), "pack-extension output prints token file path");

  const vmPlanDir = path.join(tempDir, "vm-plan");
  const vmPlanOutput = runCli(["plan-vm-setup", route53CliConfigPath, "--out", vmPlanDir]);
  assert(vmPlanOutput.ok, "framework CLI plan-vm-setup returns ok");
  assert(fs.existsSync(path.join(vmPlanDir, "deployment-plan.json")), "VM plan has deployment-plan.json");
  assert(fs.existsSync(path.join(vmPlanDir, "env.example")), "VM plan has env.example");
  assert(fs.existsSync(path.join(vmPlanDir, "services", "dashboard.service")), "VM plan has dashboard service template");
  assert(fs.existsSync(path.join(vmPlanDir, "services", "singularity.service")), "VM plan has Singularity service template");
  assert(fs.existsSync(path.join(vmPlanDir, "scripts", "bootstrap-dry-run.sh")), "VM plan has bootstrap dry-run script");

  const deploymentPlan = readJson(path.join(vmPlanDir, "deployment-plan.json"));
  assertEqual(deploymentPlan.mode, "dry-run", "VM plan mode");
  assertEqual(deploymentPlan.operator.publicIp, route53.operator.publicIp, "VM plan public IP");
  assertEqual(deploymentPlan.dns.rebindDomain, route53.dns.rebindDomain, "VM plan rebind domain");
  assertEqual(deploymentPlan.dashboard.port, route53.dashboard.port, "VM plan dashboard port");
  assert(deploymentPlan.operations.every((operation) => operation.mutates === false), "VM plan operations are non-mutating");

  const bootstrap = fs.readFileSync(path.join(vmPlanDir, "scripts", "bootstrap-dry-run.sh"), "utf8");
  assert(bootstrap.includes("set -eu"), "VM bootstrap dry-run is shell-safe");
  assert(bootstrap.includes("dry-run only"), "VM bootstrap declares dry-run mode");
  assert(!bootstrap.includes("az "), "VM bootstrap does not call cloud-provider CLIs");
  assert(!bootstrap.includes("aws "), "VM bootstrap does not call AWS CLI");
  assert(!bootstrap.includes("ssh "), "VM bootstrap does not call SSH");

  const dnsPlanDir = path.join(tempDir, "dns-plan");
  const dnsPlanOutput = runCli([
    "dns",
    "plan",
    "--config",
    route53CliConfigPath,
    "--out",
    dnsPlanDir
  ]);
  assert(dnsPlanOutput.ok, "framework CLI dns plan returns ok");
  assertEqual(dnsPlanOutput.provider, "route53", "dns plan provider");
  assert(fs.existsSync(path.join(dnsPlanDir, "route53.zone")), "dns plan writes route53 zone file");
  assert(fs.existsSync(path.join(dnsPlanDir, "route53-change-batch.json")), "dns plan writes route53 change batch");
  const dnsZone = fs.readFileSync(path.join(dnsPlanDir, "route53.zone"), "utf8");
  assert(dnsZone.includes("dashboard.example.com. 60 IN A 203.0.113.10"), "dns plan zone includes dashboard A");
  assert(dnsZone.includes("rebind.example.com. 60 IN NS ns1.rebind.example.com."), "dns plan zone includes rebind NS");

  const dnsApplyDryRun = runCli([
    "dns",
    "apply",
    "--config",
    route53CliConfigPath,
    "--out",
    path.join(tempDir, "dns-apply")
  ]);
  assert(dnsApplyDryRun.ok, "framework CLI dns apply dry-run returns ok");
  assertEqual(dnsApplyDryRun.dryRun, true, "dns apply defaults to dry-run");
  assert(dnsApplyDryRun.nextCommand.includes("aws route53 change-resource-record-sets"), "dns apply dry-run prints aws command");

  const dnsVerifyOffline = runCli([
    "dns",
    "verify",
    "--config",
    route53CliConfigPath,
    "--stage",
    "records",
    "--offline"
  ]);
  assert(dnsVerifyOffline.ok, "framework CLI dns verify returns ok");
  assertEqual(dnsVerifyOffline.stage, "records", "dns verify defaults to record verification");
  assert(dnsVerifyOffline.checks.some((check) => check.name === "dashboard.a" && check.expected === route53.operator.publicIp), "dns verify checks dashboard A target");
  assert(dnsVerifyOffline.checks.some((check) => check.name === "nameserver.a" && check.target === `ns1.${route53.dns.rebindDomain}`), "dns verify checks delegated nameserver A target");
  assert(dnsVerifyOffline.checks.some((check) => check.name === "rebind.ns" && check.expected === `ns1.${route53.dns.rebindDomain}.`), "dns verify checks rebind NS target");
  const dnsVerifyText = runTextCli([
    "dns",
    "verify",
    "--config",
    route53CliConfigPath,
    "--stage",
    "records",
    "--offline"
  ]);
  assert(!dnsVerifyText.includes("Help:"), "dns verify output does not print helper link noise");
  assert(dnsVerifyText.endsWith("\n"), "dns verify human output ends with newline");
  assert(frameworkSource.includes("retryDnsLookup"), "dns verify retries transient DNS resolver failures");
  assert(frameworkSource.includes("retryDnsLookup(() => withTimeout(dns.resolveNs(zone)"), "dns verify retries parent-zone NS lookup");

  const operatorDeployDryRun = runCli(["vm", "deploy", "--config", route53CliConfigPath]);
  assert(operatorDeployDryRun.ok, "framework CLI vm deploy dry-run returns ok");
  assertEqual(operatorDeployDryRun.dryRun, true, "vm deploy defaults to dry-run");
  assert(operatorDeployDryRun.commandLine.includes("scripts/deploy-operator-ssh.sh"), "vm deploy dry-run uses ssh deploy script");
  assert(operatorDeployDryRun.commandLine.includes("--identity-file ~/.ssh/mcp-binder-example.pem"), "vm deploy includes configured ssh key path");
  const vmDeployText = runTextCli(["vm", "deploy", "--config", route53CliConfigPath]);
  assert(vmDeployText.includes("MCP Binder vm deploy preview"), "vm deploy preview has a concise title");
  assert(vmDeployText.includes("Action: Install MCP Binder VM runtime"), "vm deploy preview explains the action");
  assert(vmDeployText.includes("Target: ubuntu@203.0.113.10"), "vm deploy preview shows the SSH target");
  assert(vmDeployText.includes("No changes made. Add --execute to run this operation."), "vm deploy preview states dry-run behavior");
  assert(!vmDeployText.includes("Script:"), "vm deploy preview hides low-level script names");
  assert(!vmDeployText.includes("Command"), "vm deploy preview hides raw shell command");

  const operatorCleanDryRun = runCli(["vm", "clean", "--config", route53CliConfigPath]);
  assert(operatorCleanDryRun.ok, "framework CLI vm clean dry-run returns ok");
  assertEqual(operatorCleanDryRun.dryRun, true, "vm clean defaults to dry-run");
  assert(operatorCleanDryRun.commandLine.includes("scripts/clean-operator-ssh.sh"), "vm clean dry-run uses ssh clean script");
  assert(operatorCleanDryRun.commandLine.includes("--yes"), "vm clean includes required yes flag");
  const vmCleanText = runTextCli(["vm", "clean", "--config", route53CliConfigPath]);
  assert(vmCleanText.includes("MCP Binder vm clean preview"), "vm clean preview has a concise title");
  assert(vmCleanText.includes("Action: Remove MCP Binder VM runtime"), "vm clean preview explains the action");
  assert(vmCleanText.includes("Target: ubuntu@203.0.113.10"), "vm clean preview shows the SSH target");
  assert(!vmCleanText.includes("Script:"), "vm clean preview hides low-level script names");
  assert(!vmCleanText.includes("Command"), "vm clean preview hides raw shell command");

  const operatorVerifyOutput = runCli(["vm", "verify", "--config", route53CliConfigPath, "--offline"]);
  assert(operatorVerifyOutput.ok, "framework CLI vm verify returns ok");
  assertEqual(operatorVerifyOutput.mode, "offline", "vm verify offline mode");
  assert(operatorVerifyOutput.checks.some((check) => check.name === "ssh.target" && check.status === "info"), "vm verify reports ssh target offline");
  assert(operatorVerifyOutput.checks.some((check) => check.name === "singularity.launcher"), "vm verify checks the required launcher payload");
  assert(!operatorVerifyOutput.checks.some((check) => check.name === "singularity.manager"), "vm verify does not require Singularity manager UI");
  const operatorVerifyText = runTextCli(["vm", "verify", "--config", route53CliConfigPath, "--offline"]);
  assert(!operatorVerifyText.includes("Help:"), "vm verify output does not print helper link noise");
  assert(!operatorVerifyText.includes("manager.html"), "vm verify output does not require manager.html");
  assert(operatorVerifyText.endsWith("\n"), "vm verify human output ends with newline");
  const vmVerifyOutput = runCli(["vm", "verify", "--config", "framework-config.template.json", "--offline"]);
  assert(vmVerifyOutput.ok, "framework CLI vm verify alias returns ok");

  const readme = fs.readFileSync("README.md", "utf8");
  assert(readme.includes("bootstrap \\"), "README quickstart uses bootstrap for the public flow");
  assert(readme.includes("cp framework-config.template.json deployment.framework-config.json"), "README starts from the public framework template");
  assert(!readme.includes("examples/framework/generic.framework-config.json"), "README does not use examples as the production config source");
  assert(readme.includes("dist/mcp-binder-dashboard-token"), "README documents the dashboard token path");
  assert(readme.includes("docs/cli.md"), "README links the CLI reference");
  assert(readme.includes("docs/security-hardening.md"), "README links security hardening guidance");
  assert(readme.includes("docs/infrastructure.md"), "README links infrastructure guidance");
  assert(readme.includes("docs/target-profiles.md"), "README links target-profile guidance");
  assert(readme.includes("docs/architecture.md"), "README links architecture docs");
  assert(readme.includes("docs/threat-model.md"), "README links threat model docs");
  assert(readme.includes("Use a TLS reverse proxy"), "README warns about HTTP dashboard deployments");
  assert(readme.includes("SECURITY.md"), "README links the security policy");
  assert(fs.existsSync("docs/security-hardening.md"), "security hardening docs exist");
  const hardeningDoc = fs.readFileSync("docs/security-hardening.md", "utf8");
  assert(hardeningDoc.includes("Implemented Controls"), "security hardening docs list implemented controls");
  assert(hardeningDoc.includes("Dashboard HTTP"), "security hardening docs cover HTTP dashboard risk");
  assert(hardeningDoc.includes("TLS is not automatic yet"), "security hardening docs explain TLS tradeoff");
  assert(hardeningDoc.includes("Wildcard CORS"), "security hardening docs track CORS residual risk");
  assert(hardeningDoc.includes("Browser Token Storage"), "security hardening docs track token storage residual risk");
  const cliDoc = fs.readFileSync("docs/cli.md", "utf8");
  assert(cliDoc.includes("vm clean"), "CLI reference documents VM cleanup");
  assert(cliDoc.includes("--json"), "CLI reference documents JSON output");
  const infrastructureDoc = fs.readFileSync("docs/infrastructure.md", "utf8");
  assert(infrastructureDoc.includes("DNS Contract"), "infrastructure docs explain DNS contract");
  assert(infrastructureDoc.includes("Network Contract"), "infrastructure docs explain network contract");
  assert(infrastructureDoc.includes("Route53 is only a helper path"), "infrastructure docs keep provider helpers optional");
  const targetProfilesDoc = fs.readFileSync("docs/target-profiles.md", "utf8");
  assert(targetProfilesDoc.includes("schemas/target-profile.schema.json"), "target-profile docs link schema");
  assert(targetProfilesDoc.includes("streamable-control"), "target-profile docs explain transports");
  assert(targetProfilesDoc.includes("Keep default tasks non-destructive"), "target-profile docs require safe public tasks");
  const securityDoc = fs.readFileSync("SECURITY.md", "utf8");
  assert(securityDoc.includes("GitHub Security Advisories"), "security policy points to private advisory reporting");
  assert(readme.includes("dist/mcp-binder-lab"), "README uses lab-oriented output naming");
  assert(readme.includes("GHSA-vmp7-252j-cwp7"), "README links the GitLab MCP DNS rebinding example");
  assert(readme.includes("GHSA-fm8p-53ww-hf6w"), "README links the DBHub DNS rebinding example");
  assert(readme.includes("reported by our security team"), "README credits the reporting team");
  assert(readme.includes("docs/deployment.md"), "README links deployment docs");
  assert(readme.includes("docs/configuration.md"), "README links configuration docs");
  assert(!readme.includes("## DNS Rebinding And MCP Impact"), "README does not include the removed impact section");
  assert(!readme.includes("## Advisories And CVEs"), "README does not include a standalone advisory section");

  const genericBootstrapDir = path.join(tempDir, "generic-bootstrap-plan");
  const genericBootstrapOutput = runCli([
    "bootstrap",
    "--config",
    genericCliConfigPath,
    "--out",
    genericBootstrapDir
  ]);
  assert(genericBootstrapOutput.ok, "framework CLI bootstrap works for provider-neutral config");
  assert(genericBootstrapOutput.steps.some((step) => step.name === "dns.prerequisite" && step.status === "operator-owned"), "provider-neutral bootstrap reports DNS asoperator-owned");
  assert(!fs.existsSync(path.join(genericBootstrapDir, "dns", "route53.zone")), "provider-neutral bootstrap does not write Route53 plan");

  const extensionPackDir = path.join(tempDir, "extension-pack-from-framework");
  const extensionPackOutput = runCli([
    "extension",
    "pack",
    "--config",
    route53CliConfigPath,
    "--out",
    extensionPackDir
  ]);
  assert(extensionPackOutput.ok, "framework CLI extension pack returns ok");
  assertEqual(extensionPackOutput.summary.dashboardTokenFile, route53.dashboard.auth.tokenFile, "extension pack wrapper reports token file");
  assertEqual(extensionPackOutput.summary.ingestTokenFile, cliIngestTokenFile, "extension pack wrapper reports ingest token file path");
  assert(fs.existsSync(path.join(extensionPackDir, "manifest.json")), "extension pack wrapper writes manifest");
  assert(fs.existsSync(path.join(extensionPackDir, "generated", "extension-build-config.json")), "extension pack wrapper writes generated config");

  const bootstrapDir = path.join(tempDir, "bootstrap-plan");
  const bootstrapOutput = runCli([
    "bootstrap",
    "--config",
    route53CliConfigPath,
    "--out",
    bootstrapDir
  ]);
  assert(bootstrapOutput.ok, "framework CLI bootstrap returns ok");
  assertEqual(bootstrapOutput.dryRun, true, "bootstrap defaults to dry-run");
  assert(fs.existsSync(path.join(bootstrapDir, "dns", "route53.zone")), "bootstrap writes dns plan");
  assert(fs.existsSync(path.join(bootstrapDir, "extension", "manifest.json")), "bootstrap packs extension");
  assert(bootstrapOutput.steps.some((step) => step.name === "dns.plan"), "bootstrap reports dns step");
  assert(bootstrapOutput.steps.some((step) => step.name === "vm.deploy"), "bootstrap reports VM deploy step");
  assert(bootstrapOutput.steps.some((step) => step.name === "extension.pack"), "bootstrap reports extension pack step");
  assert(!fs.existsSync(path.join("dist", "mcp-binder-ingest-token")), "validation does not create default dist ingest token");

  const sourceManifest = readJson("manifest.json");
  assertEqual(sourceManifest.icons["16"], "icons/icon16.png", "source manifest has 16px icon");
  assertEqual(sourceManifest.icons["32"], "icons/icon32.png", "source manifest has 32px icon");
  assertEqual(sourceManifest.icons["48"], "icons/icon48.png", "source manifest has 48px icon");
  assertEqual(sourceManifest.icons["128"], "icons/icon128.png", "source manifest has 128px icon");
  assertEqual(sourceManifest.action.default_icon["128"], "icons/icon128.png", "source manifest has action icon");
  assert(sourceManifest.permissions.includes("offscreen"), "source manifest includes offscreen permission for rebind proof runner");
  assert(sourceManifest.host_permissions.includes("http://localtest.me:*/*"), "source manifest includes localtest.me scanner permission");
  assert(!sourceManifest.host_permissions.includes("http://127.0.0.1:*/*"), "source manifest avoids direct 127.0.0.1 permission");
  assert(sourceManifest.host_permissions.includes("http://*.rebind.example.com/*"), "source manifest includes current demo rebind domain permission");
  assert(sourceManifest.host_permissions.includes("http://dashboard.example.com/*"), "source manifest includes dashboard permission for offscreen proof events");
  const scannerSource = fs.readFileSync("src/scanner.js", "utf8");
  assert(scannerSource.includes("validateScanTargetAccess"), "scanner exports target access preflight");
  assert(scannerSource.includes("scanTargetPermissionCandidates"), "scanner exports active site-access probe candidates");
  assert(scannerSource.includes("http://localtest.me:*/*"), "scanner policy names localtest.me root permission");
  assert(scannerSource.includes("http://*.localtest.me:*/*"), "scanner policy names localtest.me wildcard permission");
  assert(scannerSource.includes("allowedHostPermissions: payload.allowedHostPermissions"), "scanner accepts runtime granted host permissions");
  const backgroundSource = fs.readFileSync("src/background.js", "utf8");
  assert(backgroundSource.includes("StartRebindBridge"), "background starts the offscreen rebind bridge");
  assert(backgroundSource.includes("chrome.permissions.getAll"), "background checks current Chrome site access before scanning");
  assert(backgroundSource.includes("chrome.permissions.contains"), "background actively checks target Site access before scanning");
  assert(backgroundSource.includes("allowedHostPermissions"), "background passes granted host permissions into scanner");
  assert(backgroundSource.includes("StopRebindBridge"), "background stops the offscreen rebind bridge");
  assert(backgroundSource.includes("chrome.offscreen.createDocument"), "background creates the offscreen bridge document");
  assert(!backgroundSource.includes("createLocalDashboard"), "background no longer creates an extension-local dashboard");
  assert(!backgroundSource.includes("DashboardRegisterVictim"), "background no longer owns dashboard ingestion");
  assert(fs.existsSync("ui/offscreen.html"), "offscreen bridge document exists");
  assert(fs.existsSync("ui/offscreen.js"), "offscreen bridge runner exists");
  const offscreenSource = fs.readFileSync("ui/offscreen.js", "utf8");
  assert(offscreenSource.includes("activeRun.descriptor = result.session?.descriptor || descriptor"), "offscreen stores the successful bridge descriptor");
  assert(offscreenSource.includes("descriptor: activeRun.descriptor"), "offscreen task loop uses the successful bridge descriptor");
  assert(offscreenSource.includes("AbortController"), "offscreen can abort an active rebind bridge");
  assert(offscreenSource.includes("controller.abort()"), "offscreen stop aborts the active bridge retry loop");
  assert(offscreenSource.includes("if (activeRun?.sessionId === session.id)"), "offscreen task loop does not clear a replacement bridge owned by another session");
  assert(offscreenSource.includes("clientRunId"), "offscreen tags rebind progress with dashboard run ids");
  assert(offscreenSource.includes("task.error"), "offscreen task loop records per-task errors");
  assert(offscreenSource.includes("task.pollError"), "offscreen task loop keeps polling errors visible");
  const dashboardClientSource = fs.readFileSync("src/dashboard-client.js", "utf8");
  assert(dashboardClientSource.includes("normalizeTaskResponse"), "dashboard client normalizes task polling responses");
  assert(dashboardClientSource.includes("body?.task"), "dashboard client supports existing lab task response shape");

  const dashboardHtml = fs.readFileSync("ui/dashboard.html", "utf8");
  const dashboardSource = fs.readFileSync("ui/dashboard.js", "utf8");
  const interactionsSource = fs.readFileSync("ui/interactions.js", "utf8");
  const messagesSource = fs.readFileSync("src/messages.js", "utf8");
  assert(!dashboardHtml.includes("generateRebindButton"), "dashboard no longer exposes standalone generate URL control");
  assert(!dashboardHtml.includes("openRebindButton"), "dashboard no longer exposes standalone open URL control");
  assert(!dashboardHtml.includes("operatorConsoleButton"), "dashboard no longer exposesoperator console launch control");
  assert(!dashboardHtml.includes("customRebindUrlInput"), "dashboard does not expose runtime custom URL editing");
  assert(!dashboardHtml.includes("Current bridge URL"), "dashboard does not expose internal bridge URLs asoperator controls");
  assert(!dashboardHtml.includes("operatorIpInput"), "dashboard does not expose runtimeoperator IP editing");
  assert(!dashboardHtml.includes("launcherPortInput"), "dashboard does not expose runtime launcher port editing");
  assert(dashboardHtml.includes("openDashboardButton"), "dashboard exposes dashboard launch control");
  assert(dashboardHtml.includes("stopRebindButton"), "dashboard exposes stop control for the offscreen bridge");
  assert(dashboardSource.includes("openDashboardDashboard"), "dashboard can open the configured dashboard");
  assert(dashboardSource.includes("dashboardDashboardUrl"), "dashboard derives dashboard launch URL from runtime config");
  assert(dashboardSource.includes("activeBridgeMcpName"), "dashboard shows the active bridge MCP name");
  assert(dashboardSource.includes("confirmReplaceBridge"), "dashboard confirms before replacing an active rebind bridge");
  assert(dashboardSource.includes("showDecisionDialog"), "dashboard uses themed in-app confirmation dialogs");
  assert(dashboardSource.includes("replaceActiveBridgeWithFinding"), "dashboard starts the requested proof after replacing an active bridge");
  assert(dashboardSource.includes("replaceConfirmed: true"), "dashboard does not ask twice after replacement is confirmed");
  assert(dashboardSource.includes("Number(progress.clientRunId) !== bridgeRunNonce"), "dashboard ignores stale rebind progress after stop");
  assert(!dashboardSource.includes("window.confirm"), "dashboard does not use native browser confirm dialogs");
  assert(dashboardSource.includes("StartRebindBridge"), "finding action starts rebind proof bridge");
  assert(dashboardSource.includes("StopRebindBridge"), "dashboard can stop the rebind proof bridge");
  assert(messagesSource.includes("ScanProgress"), "message contract includes scan progress events");
  assert(backgroundSource.includes("ScanProgress"), "background forwards scan progress events");
  assert(dashboardSource.includes("RebindBridgeLog"), "dashboard listens for rebind bridge progress events");
  assert(dashboardSource.includes("showActiveBridgeNotice"), "dashboard shows duplicate rebind starts as transient notices");
  assert(dashboardSource.includes("restoreActivity(previousActivity)"), "dashboard preserves activity panel on duplicate rebind start");
  assert(dashboardSource.includes("validateScanTargetAccess"), "dashboard validates scan target before starting scan");
  assert(dashboardSource.includes("chrome.permissions.getAll"), "dashboard reads current Chrome site access before scan");
  assert(dashboardSource.includes("chrome.permissions.contains"), "dashboard actively checks target Site access before blocking");
  assert(dashboardSource.includes("renderBlockedScan"), "dashboard renders blocked scan policy errors as structured UI");
  assert(dashboardSource.includes("activityPanel"), "dashboard renders live activity panel");
  assert(dashboardHtml.includes("activityPanel"), "dashboard includes live activity panel markup");
  assert(dashboardHtml.includes("brandTitle"), "dashboard title uses interactive text treatment");
  assert(!dashboardHtml.includes("binderMark"), "dashboard title does not include a separate icon mark");
  assert(dashboardHtml.includes("statusButton"), "dashboard status is an actionable button");
  assert(dashboardHtml.includes("toggleVmIpButton"), "dashboard exposes VM IP reveal control");
  assert(dashboardHtml.includes("activityDragHandle"), "dashboard exposes an activity panel drag handle");
  assert(dashboardHtml.includes("activityResizeHandle"), "dashboard exposes an activity panel resize handle");
  assert(dashboardSource.includes("enableActivityPanelDrag"), "dashboard wires activity panel dragging");
  assert(dashboardSource.includes("enableActivityPanelResize"), "dashboard wires activity panel resizing");
  assert(dashboardSource.includes("startActivityPanelResize"), "dashboard can start activity panel resizing");
  assert(dashboardSource.includes("setPointerCapture"), "dashboard drag keeps pointer capture while moving");
  assert(dashboardSource.includes("attachSnapBackInteractions"), "dashboard wires shared snap-back interactions");
  assert(dashboardSource.includes("highlightActivityPanel"), "dashboard status button highlights activity panel");
  assert(dashboardSource.includes("toggleVmIpVisibility"), "dashboard can reveal and hide the VM IP");
  assert(dashboardSource.includes("renderVmIpValue"), "dashboard renders masked VM IP by default");
  assert(interactionsSource.includes(".verdict"), "shared snap-back helper targets finding verdict badges");
  assert(interactionsSource.includes(".brandTitle"), "shared snap-back helper targets the dashboard title");
  assert(interactionsSource.includes(".githubLink"), "shared snap-back helper targets the GitHub icon");
  assert(interactionsSource.includes(".statusButton"), "shared snap-back helper targets the status button");
  assert(interactionsSource.includes("finishSnapBackInteraction"), "shared snap-back helper has a single cleanup path");
  assert(interactionsSource.includes("contextmenu"), "shared snap-back helper cancels stuck drags on context menu");
  assert(interactionsSource.includes("visibilitychange"), "shared snap-back helper cancels stuck drags on page visibility changes");
  assert(interactionsSource.includes("addEventListener(\"blur\""), "shared snap-back helper cancels stuck drags on window blur");
  assert(interactionsSource.includes("SNAP_BACK_DRAG_THRESHOLD"), "shared snap-back helper uses a click-safe movement threshold");
  assert(!interactionsSource.includes("SNAP_BACK_MAX_OFFSET"), "shared snap-back dragging is not artificially capped");
  assert(!dashboardSource.includes("maxLeft"), "activity panel dragging is not capped by viewport left bounds");
  assert(!dashboardSource.includes("maxWidth"), "activity panel resizing is not capped by viewport width");
  const dashboardCss = fs.readFileSync("ui/dashboard.css", "utf8");
  assert(dashboardCss.includes(".brandTitle"), "dashboard styles interactive title text");
  assert(dashboardCss.includes(".brandTitle:hover"), "dashboard title highlights on hover");
  assert(dashboardCss.includes(".statusButton"), "dashboard styles actionable status badge");
  assert(dashboardCss.includes(".vmIpSecret"), "dashboard styles masked VM IP");
  assert(dashboardSource.includes("OPEN_EYE_ICON"), "dashboard renders a dedicated open-eye VM IP icon");
  assert(dashboardSource.includes("CLOSED_EYE_ICON"), "dashboard renders a dedicated closed-eye VM IP icon");
  assert(dashboardCss.includes(".eyeIconShell"), "dashboard styles the VM IP eye icon shell");
  assert(dashboardCss.includes(".activityPanel.highlight"), "dashboard styles activity highlight pulse");
  assert(dashboardCss.includes(".activityDragHandle"), "dashboard styles the activity panel drag handle");
  assert(dashboardCss.includes(".activityResizeHandle"), "dashboard styles the activity panel resize handle");
  assert(dashboardCss.includes("cursor: grab"), "dashboard shows draggable cursor on the activity handle");
  assert(dashboardCss.includes("cursor: nwse-resize"), "dashboard shows resize cursor on the activity resize handle");
  assert(dashboardCss.includes(".snapBackInteractive"), "dashboard styles snap-back interactive surfaces");
  assert(dashboardCss.includes(".snapBackDragging"), "dashboard styles active snap-back dragging");
  assert(dashboardCss.includes(".operatorNotice"), "dashboard styles transientoperator notices");
  assert(dashboardCss.includes(".operatorDialog"), "dashboard styles themed decision dialogs");
  assert(dashboardCss.includes(".rebindDeployment dd"), "dashboard compacts rebind deployment values");
  assert(dashboardCss.includes("cursor: not-allowed"), "dashboard disabled buttons do not show a busy cursor");
  assert(dashboardCss.includes(".blockedScan"), "dashboard styles blocked scan policy state");
  assert(dashboardCss.includes(".permissionList"), "dashboard styles allowed permission chips");
  assert(!dashboardSource.includes("rebindUrlInput"), "dashboard does not keep stale bridge URL state");
  assert(dashboardSource.includes("labSettingsFromRuntimeConfig(runtimeConfig)"), "dashboard derives rebind settings from packed runtime config");
  assert(dashboardSource.includes("dashboardLastResult"), "dashboard persists scan results across dashboard refreshes");
  assert(!dashboardSource.includes("customRebindUrlInput"), "dashboard does not persist runtime rebind infrastructure edits");
  assert(!dashboardSource.includes("chrome.tabs.create({ url }"), "dashboard does not launch raw rebind proof URLs in a tab");
  assert(!dashboardSource.includes("searchParams.set(\"token\""), "dashboard does not putoperator tokens into URLs");
  assert(offscreenSource.includes("mcpName"), "offscreen duplicate-bridge payload preserves MCP name");
  assert(offscreenSource.includes("runtimeConfig.ingestToken"), "offscreen bridge reads ingest token from packed runtime config");
  assert(offscreenSource.includes("takeDashboardTasks(baseUrl, sessionId, ingestToken)"), "offscreen bridge uses ingest token when polling tasks");
  assert(!dashboardSource.includes("chrome.tabs.remove(tabId"), "dashboard does not model proof stop as closing a tab");

  const dashboardServerSource = fs.readFileSync("services/dashboard-server.js", "utf8");
  assert(dashboardServerSource.includes("SNAP_BACK_INTERACTION_CSS"), "server dashboard ships shared snap-back CSS");
  assert(!dashboardServerSource.includes("params.get(\"token\")"), "server dashboards do not acceptoperator tokens from URL parameters");
  assert(!dashboardServerSource.includes("searchParams.get(\"token\")"), "server dashboards do not acceptoperator tokens from URL parameters");
  assert(dashboardServerSource.includes("SNAP_BACK_INTERACTION_SCRIPT"), "server dashboard ships shared snap-back JS");
  assert(dashboardServerSource.includes("attachServerSnapBackInteractions"), "server dashboard wires snap-back interactions");
  assert(dashboardServerSource.includes("contextmenu"), "server snap-back helper cancels stuck drags on context menu");
  assert(dashboardServerSource.includes("showTokenSavedHint"), "server dashboard can show contextual token feedback");
  assert(dashboardServerSource.includes("Token saved"), "operator dashboard save token action shows token saved feedback");
  assert(dashboardServerSource.includes(".tokenSavedHint"), "server dashboard styles contextual token feedback");
  assert(dashboardServerSource.includes("@keyframes tokenSavedFloat"), "server token feedback fades near the save button");
  assert(dashboardServerSource.includes(".serverBrandTitle"), "server dashboard titles have draggable highlight treatment");
  assert(dashboardServerSource.includes(".metric"), "operator dashboard snap-back targets attack surface metrics");
  assert(dashboardServerSource.includes(".selectable"), "operator dashboard snap-back targets selectable rows");
  assert(dashboardServerSource.includes(".summary-card"), "ops page snap-back targets summary cards");
  assert(dashboardServerSource.includes(".result-card"), "ops page snap-back targets result cards");
  assert(dashboardServerSource.includes(".tool-card"), "ops page snap-back targets tool cards");
  assert(dashboardServerSource.includes(".ready-step"), "ops page snap-back targets readiness cards");
  assert(dashboardServerSource.includes(".task-grid > *"), "ops page snap-back targets generated tool console tasks");
}

function runCli(args) {
  const stdout = execFileSync("node", ["scripts/framework-cli.js", ...args, "--json"], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
  return JSON.parse(stdout);
}

function runTextCli(args) {
  return execFileSync("node", ["scripts/framework-cli.js", ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"]
  });
}
