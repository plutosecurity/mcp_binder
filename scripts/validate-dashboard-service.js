import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

const token = "dashboard-test-token";
const ingestToken = "dashboard-ingest-test-token";
const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "mcp-binder-dashboard-"));
const missingIngestStartup = await expectDashboardStartupFailure(["services/dashboard-server.js", "--host", "127.0.0.1", "--port", "0", "--token", token, "--evidence-dir", tempDir]);
assert(missingIngestStartup.includes("ingest token is required"), "dashboard fails closed when ingest token is missing");
const child = spawn("node", ["services/dashboard-server.js", "--host", "127.0.0.1", "--port", "0", "--token", token, "--ingest-token", ingestToken, "--evidence-dir", tempDir], {
  cwd: process.cwd(),
  stdio: ["ignore", "pipe", "pipe"]
});

let stderr = "";
child.stderr.on("data", (chunk) => {
  stderr += chunk.toString();
});

try {
  const ready = await waitForReady(child);
  const baseUrl = ready.baseUrl;

  const dashboard = await fetchText(`${baseUrl}/`);
  assertEqual(dashboard.status, 200, "dashboard root status");
  assertCspNonce(dashboard, "dashboard root");
  assert(dashboard.body.includes("MCP Binder Dashboard"), "dashboard root has reference title");
  assert(dashboard.body.includes("DNS Rebinding Control"), "dashboard root uses reference control rail");
  assert(dashboard.body.includes("Attack Surface"), "dashboard root uses reference attack surface panel");
  assert(!dashboard.body.includes("Fresh victim URL"), "dashboard root does not expose the old lab victim URL generator");
  assert(!dashboard.body.includes("scanPorts"), "dashboard root does not expose old scan port controls");
  assert(!dashboard.body.includes("probeTransport"), "dashboard root does not expose old probe transport controls");
  assert(dashboard.body.includes("probe sessions"), "dashboard root shows probe sessions");
  assert(dashboard.body.includes("Raw evidence"), "dashboard root shows raw evidence");
  assert(dashboard.body.includes("/ops?session="), "dashboard root links operations console");

  const ops = await fetchText(`${baseUrl}/ops`);
  assertEqual(ops.status, 200, "ops status");
  assertCspNonce(ops, "ops page");
  assert(ops.body.includes("MCP Operations"), "ops uses the compact operations shell");
  assert(ops.body.includes("Captured MCP"), "ops has captured MCP title");
  assert(ops.body.includes("Control Channel"), "ops shows control channel status");
  assert(ops.body.includes("MCP Tool Console"), "ops has tool console");
  assert(ops.body.includes("Run operation"), "ops can run selected operations");
  assert(ops.body.includes("Queue raw RPC"), "ops can queue raw JSON-RPC");
  assert(ops.body.includes("Saved Requests"), "ops has saved request slots");
  assert(ops.body.includes("Quick Actions"), "ops has quick action list");
  assert(ops.body.includes("class=\"readiness\""), "ops has readiness strip");
  assert(ops.body.includes("Evidence Summary"), "ops summarizes evidence");
  assert(ops.body.includes("Discovered MCP Tools"), "ops lists discovered tools");
  assert(ops.body.includes("Generated target profile"), "ops generates target profile");
  assert(ops.body.includes("Operation Timeline"), "ops shows operation timeline");
  assert(!dashboard.body.includes("&token="), "dashboard does not put operator tokens in ops URLs");
  assert(!dashboard.body.includes("token=\" + encodeURIComponent"), "dashboard does not build query-token ops links");
  assert(!ops.body.includes("<pre>${pretty("), "ops does not inject unescaped pretty JSON into pre tags");
  assert(!ops.body.includes("innerHTML = `${pretty("), "ops does not inject unescaped pretty JSON through innerHTML");

  const unauthorized = await fetchJson(`${baseUrl}/api/state`);
  assertEqual(unauthorized.status, 401, "unauthorized state status");

  let state = await fetchJson(`${baseUrl}/api/state`, { token });
  assertEqual(state.status, 200, "authorized state status");
  assert(Array.isArray(state.body.events), "state has events array");
  assertEqual(Object.keys(state.body.victims).length, 0, "initial victims empty");

  const unauthenticatedVictim = await fetchJson(`${baseUrl}/api/victims`, {
    method: "POST",
    body: { id: "blocked-victim" }
  });
  assertEqual(unauthenticatedVictim.status, 401, "unauthenticated ingest is rejected when ingest token is configured");

  const wrongIngestVictim = await fetchJson(`${baseUrl}/api/victims`, {
    method: "POST",
    ingestToken: "wrong-ingest-token",
    body: { id: "blocked-victim" }
  });
  assertEqual(wrongIngestVictim.status, 401, "wrong ingest token is rejected");

  const victim = await fetchJson(`${baseUrl}/api/victims`, {
    method: "POST",
    ingestToken,
    body: {
      id: "victim-1",
      displayName: "chrome-extension",
      ports: [8082]
    }
  });
  assertEqual(victim.status, 200, "victim registration status");
  assertEqual(victim.body.id, "victim-1", "victim id");

  const session = await fetchJson(`${baseUrl}/api/sessions`, {
    method: "POST",
    ingestToken,
    body: {
      id: "session-1",
      victimId: "victim-1",
      campaignId: "campaign-1",
      transport: "streamable",
      status: "started"
    }
  });
  assertEqual(session.status, 200, "session registration status");
  assertEqual(session.body.id, "session-1", "session id");

  const event = await fetchJson(`${baseUrl}/api/events`, {
    method: "POST",
    ingestToken,
    body: {
      kind: "bridge.started",
      session: "session-1",
      payload: { port: 8082 }
    }
  });
  assertEqual(event.status, 200, "event status");
  assertEqual(event.body.kind, "bridge.started", "event kind");

  const queued = await fetchJson(`${baseUrl}/api/tasks/session-1`, {
    method: "POST",
    token,
    body: {
      kind: "tools/list"
    }
  });
  assertEqual(queued.status, 200, "queue task status");
  assertEqual(queued.body.task.kind, "tools/list", "queued task kind");

  const unauthenticatedTaskPoll = await fetchJson(`${baseUrl}/api/tasks/session-1`);
  assertEqual(unauthenticatedTaskPoll.status, 401, "unauthenticated task polling is rejected when ingest token is configured");

  const wrongIngestTaskPoll = await fetchJson(`${baseUrl}/api/tasks/session-1`, {
    ingestToken: "wrong-ingest-token"
  });
  assertEqual(wrongIngestTaskPoll.status, 401, "wrong ingest token cannot poll tasks");

  const task = await fetchJson(`${baseUrl}/api/tasks/session-1`, { ingestToken });
  assertEqual(task.status, 200, "take task status");
  assertEqual(task.body.task.kind, "tools/list", "taken task kind");
  assert(Boolean(task.body.task.claimedAt), "taken task is marked claimed");

  const emptyTask = await fetchJson(`${baseUrl}/api/tasks/session-1`, { ingestToken });
  assertEqual(emptyTask.status, 200, "empty task status");
  assertEqual(emptyTask.body.task, null, "only unclaimed task is returned");

  const result = await fetchJson(`${baseUrl}/api/results`, {
    method: "POST",
    ingestToken,
    body: {
      session: "session-1",
      kind: "tools/list",
      data: {
        jsonrpc: "2.0",
        id: 1,
        result: {
          tools: [{ name: "list_devices" }]
        }
      }
    }
  });
  assertEqual(result.status, 200, "result status");
  assertEqual(result.body.session, "session-1", "result session");

  state = await fetchJson(`${baseUrl}/api/state`, { token });
  assertEqual(state.status, 200, "state after ingest status");
  assertEqual(Object.keys(state.body.victims).length, 1, "state has victim");
  assertEqual(Object.keys(state.body.sessions).length, 1, "state has session");
  assertEqual(state.body.results.length, 1, "state has result");

  const evidence = await fetchJson(`${baseUrl}/api/export`, { token });
  assertEqual(evidence.status, 200, "evidence export status");
  assertEqual(evidence.body.frameworkVersion, "0.1.0", "evidence framework version");
  assertEqual(evidence.body.verdict, "vulnerable", "evidence verdict");
  assertEqual(evidence.body.proof.campaignId, "campaign-1", "evidence campaign");
  assert(evidence.body.proof.sessions.includes("session-1"), "evidence includes session");
  assert(evidence.body.proof.tools.some((tool) => tool.name === "list_devices"), "evidence includes tool");

  const clear = await fetchJson(`${baseUrl}/api/clear`, { method: "POST", token });
  assertEqual(clear.status, 200, "clear status");
  assertEqual(Object.keys(clear.body.victims).length, 0, "clear removes victims");

  for (let i = 0; i < 205; i += 1) {
    await fetchJson(`${baseUrl}/api/events`, {
      method: "POST",
      ingestToken,
      body: {
        kind: "flood",
        payload: { i }
      }
    });
  }
  state = await fetchJson(`${baseUrl}/api/state`, { token });
  assert(state.body.events.length <= 200, "event state is capped");

  console.log("dashboard service ok");
} finally {
  child.kill("SIGTERM");
}

function waitForReady(processHandle) {
  return new Promise((resolve, reject) => {
    let stdout = "";
    const timeout = setTimeout(() => {
      reject(new Error(`dashboard did not become ready: ${stderr}`));
    }, 5000);

    processHandle.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
      for (const line of stdout.split("\n")) {
        if (!line.trim()) {
          continue;
        }
        try {
          const parsed = JSON.parse(line);
          if (parsed.ready) {
            clearTimeout(timeout);
            resolve(parsed);
          }
        } catch {
          continue;
        }
      }
    });

    processHandle.on("exit", (code) => {
      clearTimeout(timeout);
      reject(new Error(`dashboard exited before ready with ${code}: ${stderr}`));
    });
  });
}

async function fetchText(url, options = {}) {
  const response = await fetch(url, {
    method: options.method || "GET",
    headers: {
      accept: "text/html"
    }
  });
  return {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: await response.text()
  };
}

function expectDashboardStartupFailure(args) {
  return new Promise((resolve) => {
    const processHandle = spawn("node", args, {
      cwd: process.cwd(),
      stdio: ["ignore", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      processHandle.kill("SIGTERM");
      resolve(`${stdout}${stderr}dashboard stayed running`);
    }, 1000);
    processHandle.stdout.on("data", (chunk) => {
      stdout += chunk.toString();
    });
    processHandle.stderr.on("data", (chunk) => {
      stderr += chunk.toString();
    });
    processHandle.on("exit", () => {
      clearTimeout(timeout);
      resolve(`${stdout}${stderr}`);
    });
  });
}

function assertCspNonce(response, label) {
  const csp = response.headers["content-security-policy"] || "";
  const scriptNonces = [...response.body.matchAll(/<script nonce="([^"]+)">/g)].map((match) => match[1]);
  assert(csp.includes("default-src 'self'"), `${label} CSP sets default-src`);
  assert(csp.includes("object-src 'none'"), `${label} CSP blocks object embedding`);
  assert(csp.includes("frame-ancestors 'none'"), `${label} CSP blocks framing`);
  assert(csp.includes("script-src 'self' 'nonce-"), `${label} CSP uses script nonce`);
  assert(!csp.includes("script-src 'self' 'unsafe-inline'"), `${label} CSP does not allow unsafe inline scripts`);
  assert(scriptNonces.length > 0, `${label} has nonce-bearing scripts`);
  assert(!/<script(?![^>]*\bnonce=)/.test(response.body), `${label} has no inline script without nonce`);
  for (const nonce of scriptNonces) {
    assert(csp.includes(`'nonce-${nonce}'`), `${label} CSP contains script nonce`);
  }
}

async function fetchJson(url, options = {}) {
  const headers = {
    accept: "application/json"
  };

  if (options.token) {
    headers.authorization = `Bearer ${options.token}`;
  }

  if (options.ingestToken) {
    headers["x-mcp-binder-ingest-token"] = options.ingestToken;
  }

  if (options.body !== undefined) {
    headers["content-type"] = "application/json";
  }

  const response = await fetch(url, {
    method: options.method || "GET",
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body)
  });

  const text = await response.text();
  const body = text ? JSON.parse(text) : null;
  return {
    status: response.status,
    body
  };
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
