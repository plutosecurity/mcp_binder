import { execFileSync } from "node:child_process";
import fs from "node:fs";

const setupPath = "scripts/setup-attacker-vm.sh";
const cleanPath = "scripts/clean-attacker-vm.sh";
const sshDeployPath = "scripts/deploy-attacker-ssh.sh";
const sshCleanPath = "scripts/clean-attacker-ssh.sh";
const dnsRoute53Path = "scripts/dns-route53-records.sh";

assertFile(setupPath, "setup script");
assertFile(cleanPath, "clean script");
assertFile(sshDeployPath, "ssh deploy script");
assertFile(sshCleanPath, "ssh clean script");
assertFile(dnsRoute53Path, "route53 dns script");

execFileSync("bash", ["-n", setupPath], { stdio: "inherit" });
execFileSync("bash", ["-n", cleanPath], { stdio: "inherit" });
execFileSync("bash", ["-n", sshDeployPath], { stdio: "inherit" });
execFileSync("bash", ["-n", sshCleanPath], { stdio: "inherit" });
execFileSync("bash", ["-n", dnsRoute53Path], { stdio: "inherit" });

const setup = fs.readFileSync(setupPath, "utf8");
const clean = fs.readFileSync(cleanPath, "utf8");
const sshDeploy = fs.readFileSync(sshDeployPath, "utf8");
const sshClean = fs.readFileSync(sshCleanPath, "utf8");
const dnsRoute53 = fs.readFileSync(dnsRoute53Path, "utf8");

for (const flag of [
  "--public-ip",
  "--rebind-domain",
  "--dashboard-domain",
  "--dashboard-port",
  "--http-ports",
  "--clear-existing"
]) {
  assert(setup.includes(flag), `setup script exposes ${flag}`);
}

for (const expected of [
  "singularity.service",
  "mcp-binder-dashboard.service",
  "MCP_BINDER_REBIND_DOMAIN",
  "MCP_BINDER_DASHBOARD_FQDN",
  "MCP_BINDER_PUBLIC_IP",
  "services/dashboard-server.js",
  "payloads/victim-launcher.html",
  "DASHBOARD_SERVER_GZ_B64",
  "DASHBOARD_TOKEN_FILE",
  "Token file:",
  "progress 1 \"Installing system packages\"",
  "progress 2 \"Building Singularity runtime\"",
  "progress 3 \"Installing dashboard and payload services\"",
  "progress 4 \"Starting services\"",
  "command -v apt-get",
  "command -v dnf",
  "command -v yum",
  "missing_packages",
  "install_missing_packages dnf",
  "install_missing_packages yum",
  "no supported package manager found"
]) {
  assert(setup.includes(expected), `setup script contains ${expected}`);
}
assert(!setup.includes("dnf install -y -q ca-certificates curl git gzip nodejs npm python3 tar"), "dnf install does not force full curl over curl-minimal");
assert(!setup.includes("yum install -y -q ca-certificates curl git gzip nodejs npm python3 tar"), "yum install does not force full curl over curl-minimal");

for (const flag of [
  "--purge-backups",
  "--keep-token",
  "--yes"
]) {
  assert(clean.includes(flag), `clean script exposes ${flag}`);
}

for (const expected of [
  "singularity.service",
  "mcp-binder-dashboard.service",
  "/opt/mcp_binder",
  "/var/lib/mcp_binder",
  "/opt/singularity-payloads",
  "/opt/singularity",
  "/etc/mcp_binder",
  "/usr/local/bin/singularity-server",
  "/opt/mcp-binder-backups",
  "systemctl disable",
  "systemctl stop"
]) {
  assert(clean.includes(expected), `clean script contains ${expected}`);
}

for (const flag of [
  "--host",
  "--user",
  "--identity-file",
  "--public-ip",
  "--rebind-domain",
  "--dashboard-domain",
  "--dashboard-token-file",
  "--clear-existing"
]) {
  assert(sshDeploy.includes(flag), `ssh deploy script exposes ${flag}`);
}

for (const expected of [
  "ssh",
  "scp",
  "mk_remote_dir",
  "validate_remote_path",
  "ensure_dashboard_token",
  "dist/mcp-binder-dashboard-token",
  "DASHBOARD_SERVER_GZ_B64",
  "UI_ARCHIVE_B64",
  "MCP_BINDER_PROGRESS_OFFSET=2",
  "MCP_BINDER_PROGRESS_TOTAL=6",
  "stage 1 \"Preparing VM workspace\"",
  "stage 2 \"Uploading MCP Binder runtime\"",
  "sudo -E bash"
]) {
  assert(sshDeploy.includes(expected), `ssh deploy script contains ${expected}`);
}
assert(!sshDeploy.includes("$SSH_TARGET:$(shell_quote"), "ssh deploy script does not pass shell-quoted paths to scp");

for (const flag of [
  "--host",
  "--user",
  "--identity-file",
  "--port",
  "--purge-backups",
  "--keep-token",
  "--yes"
]) {
  assert(sshClean.includes(flag), `ssh clean script exposes ${flag}`);
}

for (const expected of [
  "ssh",
  "scp",
  "clean-attacker-vm.sh",
  "validate_remote_path",
  "sudo bash",
  "--yes"
]) {
  assert(sshClean.includes(expected), `ssh clean script contains ${expected}`);
}
assert(!sshClean.includes("$SSH_TARGET:$(shell_quote"), "ssh clean script does not pass shell-quoted paths to scp");

for (const flag of [
  "plan",
  "zone-file",
  "change-batch",
  "--config",
  "--out-dir",
  "--dashboard-domain",
  "--rebind-domain",
  "--public-ip",
  "--ttl",
  "--out"
]) {
  assert(dnsRoute53.includes(flag), `route53 dns script exposes ${flag}`);
}

for (const expected of [
  "IN A",
  "IN NS",
  "ns1.",
  "UPSERT",
  "ResourceRecordSet"
]) {
  assert(dnsRoute53.includes(expected), `route53 dns script contains ${expected}`);
}

const setupHelp = execFileSync("bash", [setupPath, "--help"], { encoding: "utf8" });
assert(setupHelp.includes("Usage:"), "setup help renders usage");
assert(setupHelp.includes("--clear-existing"), "setup help documents clear mode");
assert(setupHelp.includes("dashboard token file path"), "setup help documents remote token output");

const cleanHelp = execFileSync("bash", [cleanPath, "--help"], { encoding: "utf8" });
assert(cleanHelp.includes("Usage:"), "clean help renders usage");
assert(cleanHelp.includes("--purge-backups"), "clean help documents backup purge");
assert(cleanHelp.includes("--keep-token"), "clean help documents token preservation");

const sshDeployHelp = execFileSync("bash", [sshDeployPath, "--help"], { encoding: "utf8" });
assert(sshDeployHelp.includes("Usage:"), "ssh deploy help renders usage");
assert(sshDeployHelp.includes("--host"), "ssh deploy help documents ssh host");
assert(sshDeployHelp.includes("--identity-file"), "ssh deploy help documents identity file");

const sshCleanHelp = execFileSync("bash", [sshCleanPath, "--help"], { encoding: "utf8" });
assert(sshCleanHelp.includes("Usage:"), "ssh clean help renders usage");
assert(sshCleanHelp.includes("--host"), "ssh clean help documents ssh host");
assert(sshCleanHelp.includes("--purge-backups"), "ssh clean help documents backup purge");

const dnsRoute53Help = execFileSync("bash", [dnsRoute53Path, "--help"], { encoding: "utf8" });
assert(dnsRoute53Help.includes("Usage:"), "route53 dns help renders usage");
assert(dnsRoute53Help.includes("zone-file"), "route53 dns help documents zone-file mode");
assert(dnsRoute53Help.includes("change-batch"), "route53 dns help documents change-batch mode");

const tempDir = fs.mkdtempSync("/tmp/mcp-binder-dns-");
const zoneFile = `${tempDir}/records.zone`;
const changeBatch = `${tempDir}/change-batch.json`;
const configZoneFile = `${tempDir}/records-from-config.zone`;
const configChangeBatch = `${tempDir}/change-batch-from-config.json`;
const route53PlanDir = `${tempDir}/route53-plan`;
const frameworkConfig = `${tempDir}/deployment.framework-config.json`;
fs.writeFileSync(frameworkConfig, JSON.stringify({
  operator: {
    publicIp: "203.0.113.10",
    sshHost: "203.0.113.10",
    sshUser: "ubuntu",
    sshKeyPath: "~/.ssh/mcp-binder-example.pem"
  },
  dns: {
    rebindDomain: "rebind.example.com",
    dashboardFqdn: "dashboard.example.com",
    ttl: 60
  }
}, null, 2));
execFileSync("bash", [
  dnsRoute53Path,
  "zone-file",
  "--dashboard-domain", "dashboard.example.com",
  "--rebind-domain", "rebind.example.com",
  "--public-ip", "203.0.113.10",
  "--ttl", "60",
  "--out", zoneFile
], { stdio: "inherit" });
const zone = fs.readFileSync(zoneFile, "utf8");
assert(zone.includes("dashboard.example.com. 60 IN A 203.0.113.10"), "zone file contains dashboard A record");
assert(zone.includes("ns1.rebind.example.com. 60 IN A 203.0.113.10"), "zone file contains rebind nameserver A record");
assert(zone.includes("rebind.example.com. 60 IN NS ns1.rebind.example.com."), "zone file contains rebind NS delegation");

execFileSync("bash", [
  dnsRoute53Path,
  "zone-file",
  "--config", frameworkConfig,
  "--out", configZoneFile
], { stdio: "inherit" });
const configZone = fs.readFileSync(configZoneFile, "utf8");
assert(configZone.includes("dashboard.example.com. 60 IN A 203.0.113.10"), "zone file from config contains dashboard A record");
assert(configZone.includes("ns1.rebind.example.com. 60 IN A 203.0.113.10"), "zone file from config contains rebind nameserver A record");
assert(configZone.includes("rebind.example.com. 60 IN NS ns1.rebind.example.com."), "zone file from config contains rebind NS delegation");

execFileSync("bash", [
  dnsRoute53Path,
  "change-batch",
  "--dashboard-domain", "dashboard.example.com",
  "--rebind-domain", "rebind.example.com",
  "--public-ip", "203.0.113.10",
  "--ttl", "60",
  "--out", changeBatch
], { stdio: "inherit" });
const batch = JSON.parse(fs.readFileSync(changeBatch, "utf8"));
assert(batch.Changes.length === 3, "route53 change batch contains three upserts");
assert(batch.Changes.every(change => change.Action === "UPSERT"), "route53 change batch uses upsert actions");

execFileSync("bash", [
  dnsRoute53Path,
  "change-batch",
  "--config", frameworkConfig,
  "--out", configChangeBatch
], { stdio: "inherit" });
const configBatch = JSON.parse(fs.readFileSync(configChangeBatch, "utf8"));
assert(configBatch.Changes.length === 3, "route53 change batch from config contains three upserts");
assert(configBatch.Changes.some(change => change.ResourceRecordSet.Name === "dashboard.example.com."), "route53 change batch from config contains dashboard record");

const route53PlanOutput = execFileSync("bash", [
  dnsRoute53Path,
  "plan",
  "--config", frameworkConfig,
  "--out-dir", route53PlanDir
], { encoding: "utf8" });
assert(route53PlanOutput.includes(`zone_file=${route53PlanDir}/route53.zone`), "route53 plan prints zone file path");
assert(route53PlanOutput.includes(`change_batch=${route53PlanDir}/route53-change-batch.json`), "route53 plan prints change batch path");
assert(fs.existsSync(`${route53PlanDir}/route53.zone`), "route53 plan writes zone file");
assert(fs.existsSync(`${route53PlanDir}/route53-change-batch.json`), "route53 plan writes change batch");

console.log("attacker vm installer validation ok");

function assertFile(file, label) {
  assert(fs.existsSync(file), `${label} exists`);
  const mode = fs.statSync(file).mode;
  assert((mode & 0o111) !== 0, `${label} is executable`);
}

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}
