import fs from "node:fs";
import http from "node:http";
import { describeDashboardFetchFailure, discoveredToolsForSession, normalizeDashboardBase, summarizeDashboardState, takeDashboardTasks } from "../src/dashboard-client.js";
import { executeBridgeTask, runRebindBridge } from "../src/rebind-bridge-core.js";
import { normalizeRebindEvidence } from "../src/rebind-evidence.js";
import { formatScanStage } from "../src/reporting-labels.js";
import { buildCustomUrlDescriptor, buildRebindLaunch, buildSingularityDescriptor } from "../src/rebind-url.js";
import { dashboardBaseFromRuntimeConfig, labSettingsFromRuntimeConfig, loadRuntimeConfig } from "../src/runtime-config.js";
import { runLocalPortScan, scanTargetPermissionCandidates, validateScanTargetAccess } from "../src/scanner.js";

const confirmed = JSON.parse(fs.readFileSync("scripts/fixtures/rebind-confirmed.json", "utf8"));
const blocked = JSON.parse(fs.readFileSync("scripts/fixtures/rebind-blocked.json", "utf8"));

const confirmedProof = normalizeRebindEvidence(confirmed, { port: 8086 });
const blockedProof = normalizeRebindEvidence(blocked, { port: 8086 });

assertEqual(confirmedProof.result, "rebind_confirmed", "confirmed fixture result");
assertEqual(confirmedProof.targetPort, 8086, "confirmed fixture port");
assertEqual(confirmedProof.mcp.tools[0], "example_tool", "confirmed fixture tool");
assertEqual(blockedProof.result, "blocked_by_host_validation", "blocked fixture result");
assertEqual(
  describeDashboardFetchFailure(new TypeError("Failed to fetch"), "http://dashboard.example.com:8090").includes("host permission"),
  true,
  "dashboard fetch failure explains host permission"
);

const launch = buildRebindLaunch({
  port: 8086,
  fingerprint: {
    transport: "streamable-http",
    endpoint: "http://127.0.0.1:8086/mcp"
  }
}, {
  labDomain: "rebind.example.test",
  attackerIp: "203.0.113.10",
  targetIp: "127.0.0.1",
  launcherPort: "8080",
  campaignId: "c-example"
});
assertEqual(launch.port, 8086, "launch port");
assertEqual(launch.path, "/mcp", "launch path");
assertEqual(launch.transport, "streamable", "launch transport");
assertEqual(new URL(launch.url).port, "8080", "launch URL port");
assertEqual(new URL(launch.url).searchParams.get("ports"), "8086", "launch URL ports");
assertEqual(new URL(launch.url).searchParams.get("payload"), "payloads/auto-streamable.html", "launch URL payload");

const singularityDescriptor = buildSingularityDescriptor({
  port: 8086,
  fingerprint: {
    transport: "streamable-http",
    endpoint: "http://127.0.0.1:8086/mcp"
  }
}, {
  labDomain: "rebind.example.test",
  attackerIp: "203.0.113.10",
  targetIp: "127.0.0.1",
  launcherPort: "8080",
  campaignId: "c-example"
});
assertEqual(singularityDescriptor.provider, "singularity-compatible", "singularity provider");
assertEqual(new URL(singularityDescriptor.launchUrl).searchParams.get("campaign"), "c-example", "singularity launch campaign");
assertEqual(new URL(singularityDescriptor.launchUrl).searchParams.get("ports"), "8086", "singularity launch ports");
assertEqual(singularityDescriptor.probeUrl, `http://${singularityDescriptor.host}:8086/mcp`, "singularity probe URL");
assertEqual(singularityDescriptor.transport, "streamable", "singularity transport");

const customDescriptor = buildCustomUrlDescriptor("http://s-demo.7f000001-token-fs-e.rebind.example.test:8080/payloads/victim-launcher.html?campaign=c-demo&transport=streamable&path=%2Fmcp&ports=8086");
assertEqual(customDescriptor.provider, "custom-url", "custom provider");
assertEqual(customDescriptor.launchUrl.includes("victim-launcher.html"), true, "custom launch URL preserved");
assertEqual(customDescriptor.probeUrl, "http://s-demo.7f000001-token-fs-e.rebind.example.test:8086/mcp", "custom probe URL derived");
assertEqual(customDescriptor.campaignId, "c-demo", "custom campaign id");
assertEqual(customDescriptor.transport, "streamable", "custom transport");

assertEqual(normalizeDashboardBase("http://dashboard.example.test:8090/"), "http://dashboard.example.test:8090", "dashboard base normalization");
const dashboardState = {
  victims: {
    "victim-1": { id: "victim-1" }
  },
  sessions: {
    "session-1": { id: "session-1", status: "initialized" }
  },
  tasks: {
    "session-1": []
  },
  results: [
    {
      session: "session-1",
      data: {
        result: {
          tools: [
            { name: "alpha" },
            { name: "alpha" },
            { name: "beta" }
          ]
        }
      }
    }
  ]
};
assertEqual(summarizeDashboardState(dashboardState).connectedSessions, 1, "dashboard connected sessions");
assertEqual(discoveredToolsForSession(dashboardState, "session-1").length, 2, "dashboard discovered tools");

const localDashboard = createMemoryDashboard({ now: () => "2026-07-14T00:00:00.000Z" });
localDashboard.registerVictim({ id: "victim-local", origin: "chrome-extension://test" });
localDashboard.registerSession({ id: "session-local", victimId: "victim-local", status: "initialized" });
localDashboard.recordEvent({ sessionId: "session-local", kind: "bridge.initialized" });
localDashboard.recordResult({ sessionId: "session-local", kind: "tools/list", data: { result: { tools: [{ name: "local_tool" }] } } });
localDashboard.queueTask("session-local", { kind: "tools/list" });
localDashboard.queueTask("session-local", { kind: "tools/call", tool: "local_tool", args: { id: 7 } });
assertEqual(localDashboard.listState().victims["victim-local"].origin, "chrome-extension://test", "local dashboard victim");
assertEqual(localDashboard.listState().sessions["session-local"].status, "initialized", "local dashboard session");
assertEqual(localDashboard.listState().events.length, 1, "local dashboard event count");
assertEqual(localDashboard.listState().results.length, 1, "local dashboard result count");
assertEqual(localDashboard.listState().tasks["session-local"].length, 2, "local dashboard queued task count");
assertEqual(localDashboard.takeTasks("session-local").length, 2, "local dashboard take task count");
assertEqual(localDashboard.listState().tasks["session-local"].length, 0, "local dashboard task queue drained");
assertEqual(localDashboard.exportEvidence().sessions["session-local"].id, "session-local", "local dashboard export session");
localDashboard.clear();
assertEqual(Object.keys(localDashboard.listState().sessions).length, 0, "local dashboard clear sessions");

const server = await listen(20380);
try {
  const bridgeDashboard = createMemoryDashboard({ now: () => "2026-07-14T00:00:00.000Z" });
  const bridge = await runRebindBridge({
    finding: { id: "finding-20380", port: 20380 },
    descriptor: {
      provider: "custom-url",
      mode: "manual",
      launchUrl: "http://127.0.0.1:20380/mcp",
      probeUrl: "http://127.0.0.1:20380/mcp",
      host: "127.0.0.1",
      port: 20380,
      path: "/mcp",
      transport: "streamable",
      campaignId: "c-bridge",
      metadata: {}
    },
    dashboard: bridgeDashboard,
    fetchImpl: fetch,
    sessionId: "session-bridge"
  });
  assertEqual(bridge.proof.result, "rebind_confirmed", "bridge proof result");
  assertEqual(bridge.session.id, "session-bridge", "bridge session id");
  assertEqual(bridgeDashboard.listState().sessions["session-bridge"].status, "tools-listed", "bridge dashboard session status");
  assertEqual(bridgeDashboard.listState().results.length, 1, "bridge dashboard result count");
  assertEqual(bridgeDashboard.listState().results[0].data.result.tools[0].name, "fixture_tool", "bridge tools/list result");
  assertEqual(Number.isInteger(bridgeDashboard.listState().victims["victim-c-bridge"].createdMs), true, "bridge victim has clear-generation timestamp");
  assertEqual(Number.isInteger(bridgeDashboard.listState().sessions["session-bridge"].createdMs), true, "bridge session has clear-generation timestamp");
  assertEqual(Number.isInteger(bridgeDashboard.listState().events[0].createdMs), true, "bridge event has clear-generation timestamp");
  assertEqual(Number.isInteger(bridgeDashboard.listState().results[0].createdMs), true, "bridge result has clear-generation timestamp");
  assertEqual(
    bridgeDashboard.listState().sessions["session-bridge"].createdMs,
    bridgeDashboard.listState().victims["victim-c-bridge"].createdMs,
    "bridge dashboard records share run timestamp"
  );
  const asyncBridgeDashboard = asyncDashboard(createMemoryDashboard({ now: () => "2026-07-14T00:00:00.000Z" }));
  const asyncBridge = await runRebindBridge({
    finding: { id: "finding-20380-async", port: 20380 },
    descriptor: {
      provider: "custom-url",
      mode: "manual",
      launchUrl: "http://127.0.0.1:20380/mcp",
      probeUrl: "http://127.0.0.1:20380/mcp",
      host: "127.0.0.1",
      port: 20380,
      path: "/mcp",
      transport: "streamable",
      campaignId: "c-bridge-async",
      metadata: {}
    },
    dashboard: asyncBridgeDashboard,
    fetchImpl: fetch,
    sessionId: "session-bridge-async"
  });
  assertEqual(asyncBridge.session.id, "session-bridge-async", "bridge async dashboard session id");
  assertEqual(asyncBridge.proof.result, "rebind_confirmed", "bridge async dashboard proof");
  const bridgeTask = await executeBridgeTask({
    descriptor: bridgeDashboard.listState().sessions["session-bridge"].descriptor,
    task: { kind: "tools/list", id: "task-bridge" },
    session: bridgeDashboard.listState().sessions["session-bridge"],
    fetchImpl: fetch
  });
  assertEqual(bridgeTask.response.body.result.tools[0].name, "fixture_tool", "bridge follow-up task result");

  const scan = await runLocalPortScan({ target: "localtest.me", ports: "20380", timeoutMs: 1000, concurrency: 1 });
  assertEqual(scan.summary.findings, 1, "fixture scan finding count");
  assertEqual(scan.findings[0].rebindProof.result, "not_tested", "default rebind proof result");
  const localtestScan = await runLocalPortScan({ target: "localtest.me", ports: "20380", timeoutMs: 1000, concurrency: 1 });
  assertEqual(localtestScan.target, "localtest.me", "localtest scan target");
  assertEqual(localtestScan.summary.findings, 1, "localtest fixture scan finding count");
  const progressEvents = [];
  const progressScan = await runLocalPortScan(
    { target: "localtest.me", ports: "20382-20384", timeoutMs: 80, concurrency: 2 },
    undefined,
    {
      onProgress: (event) => progressEvents.push(event)
    }
  );
  assertEqual(progressScan.summary.scanned, 3, "scan progress fixture scans every requested port");
  assertEqual(progressEvents.some((event) => event.phase === "ports" && event.completed === 3 && event.total === 3), true, "scan progress reports completed port phase");
  assertEqual(progressEvents.some((event) => event.phase === "endpoints"), true, "scan progress reports endpoint phase");
  assertEqual(progressEvents.some((event) => event.phase === "headers"), true, "scan progress reports header phase");
} finally {
  await close(server);
}

const flipServer = await listenAfterAttackerPhase(20381);
try {
  const retryDashboard = createMemoryDashboard({ now: () => "2026-07-14T00:00:00.000Z" });
  const retry = await runRebindBridge({
    finding: { id: "finding-20381", port: 20381 },
    descriptor: {
      provider: "custom-url",
      mode: "manual",
      launchUrl: "http://127.0.0.1:20381/mcp",
      probeUrl: "http://127.0.0.1:20381/mcp",
      host: "127.0.0.1",
      port: 20381,
      path: "/mcp",
      transport: "streamable",
      campaignId: "c-retry",
      metadata: {}
    },
    dashboard: retryDashboard,
    fetchImpl: fetch,
    sessionId: "session-retry",
    attempts: 2,
    delayMs: 10
  });
  assertEqual(retry.proof.result, "rebind_confirmed", "bridge retry proof result");
  assertEqual(retryDashboard.listState().events.some((event) => event.kind === "bridge.error"), false, "bridge retry avoids final error");
} finally {
  await close(flipServer);
}

const ssePreambleServer = await listenSsePreamble(20385);
try {
  const ssePreambleDashboard = createMemoryDashboard({ now: () => "2026-07-14T00:00:00.000Z" });
  const ssePreamble = await runRebindBridge({
    finding: { id: "finding-20385", port: 20385 },
    descriptor: {
      provider: "custom-url",
      mode: "manual",
      launchUrl: "http://127.0.0.1:20385/mcp",
      probeUrl: "http://127.0.0.1:20385/mcp",
      host: "127.0.0.1",
      port: 20385,
      path: "/mcp",
      transport: "streamable",
      campaignId: "c-sse-preamble",
      metadata: {}
    },
    dashboard: ssePreambleDashboard,
    fetchImpl: fetch,
    sessionId: "session-sse-preamble",
    attempts: 1,
    delayMs: 10
  });
  assertEqual(ssePreamble.proof.result, "rebind_confirmed", "bridge parses SSE preamble response");
  assertEqual(ssePreamble.proof.mcp.tools[0], "sse_preamble_tool", "bridge extracts tools from SSE preamble response");
} finally {
  await close(ssePreambleServer);
}

const mixedBridgeServer = await listenMixedBridgeStream(20386);
try {
  const mixedDashboard = createMemoryDashboard({ now: () => "2026-07-14T00:00:00.000Z" });
  const mixed = await runRebindBridge({
    finding: { id: "finding-20386", port: 20386 },
    descriptor: {
      provider: "custom-url",
      mode: "manual",
      launchUrl: "http://127.0.0.1:20386/mcp",
      probeUrl: "http://127.0.0.1:20386/mcp",
      host: "127.0.0.1",
      port: 20386,
      path: "/mcp",
      transport: "streamable",
      campaignId: "c-mixed-bridge",
      metadata: {}
    },
    dashboard: mixedDashboard,
    fetchImpl: fetch,
    sessionId: "session-mixed-bridge",
    attempts: 1,
    delayMs: 10
  });
  assertEqual(mixed.proof.result, "rebind_confirmed", "bridge parses mixed keepalive and JSON-RPC response");
  assertEqual(mixed.proof.mcp.tools[0], "mixed_bridge_tool", "bridge extracts tools from mixed bridge response");
} finally {
  await close(mixedBridgeServer);
}

const fallbackPathServer = await listenFallbackPathBridge(20387);
try {
  const fallbackDashboard = createMemoryDashboard({ now: () => "2026-07-14T00:00:00.000Z" });
  const fallback = await runRebindBridge({
    finding: { id: "finding-20387", port: 20387 },
    descriptor: {
      provider: "custom-url",
      mode: "manual",
      launchUrl: "http://127.0.0.1:20387/mcp",
      probeUrl: "http://127.0.0.1:20387/mcp",
      host: "127.0.0.1",
      port: 20387,
      path: "/mcp",
      transport: "streamable",
      campaignId: "c-fallback-path",
      metadata: {}
    },
    dashboard: fallbackDashboard,
    fetchImpl: fetch,
    sessionId: "session-fallback-path",
    attempts: 1,
    delayMs: 10
  });
  assertEqual(fallback.proof.result, "rebind_confirmed", "bridge falls back from /mcp to root streamable endpoint");
  assertEqual(fallback.proof.mcp.tools[0], "root_fallback_tool", "bridge extracts tools from fallback path");
  assertEqual(new URL(fallback.proof.probeUrl).pathname, "/", "bridge proof records successful fallback path");
  assertEqual(fallbackDashboard.listState().sessions["session-fallback-path"].descriptor.path, "/", "dashboard session records successful fallback descriptor");
  const fallbackCall = await executeBridgeTask({
    descriptor: fallback.session.descriptor,
    task: { kind: "tools/call", id: "task-fallback-call", tool: "root_fallback_tool", args: { value: 7 } },
    session: fallback.session,
    fetchImpl: fetch
  });
  assertEqual(fallbackCall.response.body.result.content[0].text, "root call ok: 7", "bridge tool call uses successful fallback path");
} finally {
  await close(fallbackPathServer);
}

const tapoRootSseServer = await listenRootSseInitializeBridge(20390);
try {
  const tapoDashboard = createMemoryDashboard({ now: () => "2026-07-14T00:00:00.000Z" });
  const tapoBridge = await runRebindBridge({
    finding: { id: "finding-20390", port: 20390 },
    descriptor: {
      provider: "custom-url",
      mode: "manual",
      launchUrl: "http://127.0.0.1:20390/",
      probeUrl: "http://127.0.0.1:20390/",
      host: "127.0.0.1",
      port: 20390,
      path: "/",
      transport: "sse",
      campaignId: "c-root-sse-init",
      metadata: {}
    },
    dashboard: tapoDashboard,
    fetchImpl: fetch,
    sessionId: "session-root-sse-init",
    attempts: 1,
    delayMs: 10
  });
  assertEqual(tapoBridge.proof.result, "rebind_confirmed", "bridge supports root SSE initialize transport");
  assertEqual(tapoBridge.proof.mcp.tools[0], "list_devices", "bridge extracts tools after root SSE initialize");
} finally {
  await close(tapoRootSseServer);
}

const authAfterInitializeServer = await listenAuthAfterInitializeBridge(20391);
try {
  const authAfterInitializeDashboard = createMemoryDashboard({ now: () => "2026-07-14T00:00:00.000Z" });
  const authAfterInitialize = await runRebindBridge({
    finding: { id: "finding-20391", port: 20391 },
    descriptor: {
      provider: "custom-url",
      mode: "manual",
      launchUrl: "http://127.0.0.1:20391/mcp",
      probeUrl: "http://127.0.0.1:20391/mcp",
      host: "127.0.0.1",
      port: 20391,
      path: "/mcp",
      transport: "streamable",
      campaignId: "c-auth-after-init",
      metadata: {}
    },
    dashboard: authAfterInitializeDashboard,
    fetchImpl: fetch,
    sessionId: "session-auth-after-init",
    attempts: 1,
    delayMs: 10
  });
  assertEqual(authAfterInitialize.proof.result, "rebind_confirmed", "bridge confirms MCP when initialize succeeds but tools are auth-blocked");
  assertEqual(authAfterInitialize.proof.mcp.tools.length, 0, "bridge records no tools when tools/list is auth-blocked");
  assertEqual(authAfterInitialize.proof.mcp.toolsError.status, 401, "bridge records tools/list auth-block status");
} finally {
  await close(authAfterInitializeServer);
}

const legacyBridgeServer = await listenLegacySseBridge(20389);
try {
  const legacyBridgeDashboard = createMemoryDashboard({ now: () => "2026-07-14T00:00:00.000Z" });
  const legacyBridge = await runRebindBridge({
    finding: { id: "finding-20389", port: 20389 },
    descriptor: {
      provider: "custom-url",
      mode: "manual",
      launchUrl: "http://127.0.0.1:20389/sse",
      probeUrl: "http://127.0.0.1:20389/sse",
      host: "127.0.0.1",
      port: 20389,
      path: "/sse",
      transport: "legacy-sse",
      campaignId: "c-legacy-bridge",
      metadata: {}
    },
    dashboard: legacyBridgeDashboard,
    fetchImpl: fetch,
    sessionId: "session-legacy-bridge",
    attempts: 1,
    delayMs: 10
  });
  assertEqual(legacyBridge.proof.result, "rebind_confirmed", "bridge supports legacy SSE transport");
  assertEqual(legacyBridge.proof.mcp.tools[0], "legacy_bridge_tool", "bridge extracts tools from legacy SSE message endpoint");
  assertEqual(legacyBridge.session.descriptor.path, "/messages", "bridge records legacy SSE message endpoint path");
  const legacyMessagePathDashboard = createMemoryDashboard({ now: () => "2026-07-14T00:00:00.000Z" });
  const legacyMessagePath = await runRebindBridge({
    finding: { id: "finding-20389-message", port: 20389 },
    descriptor: {
      provider: "custom-url",
      mode: "manual",
      launchUrl: "http://127.0.0.1:20389/messages",
      probeUrl: "http://127.0.0.1:20389/messages",
      host: "127.0.0.1",
      port: 20389,
      path: "/messages",
      transport: "sse",
      campaignId: "c-legacy-message-path",
      metadata: {}
    },
    dashboard: legacyMessagePathDashboard,
    fetchImpl: fetch,
    sessionId: "session-legacy-message-path",
    attempts: 1,
    delayMs: 10
  });
  assertEqual(legacyMessagePath.proof.result, "rebind_confirmed", "bridge falls back from legacy message path to SSE control endpoint");
  assertEqual(legacyMessagePath.proof.mcp.tools[0], "legacy_bridge_tool", "bridge extracts tools after legacy SSE path fallback");
} finally {
  await close(legacyBridgeServer);
}

const abortController = new AbortController();
abortController.abort();
const abortDashboard = createMemoryDashboard({ now: () => "2026-07-14T00:00:00.000Z" });
const abortedBridge = await runRebindBridge({
  finding: { id: "finding-abort", port: 20999 },
  descriptor: {
    provider: "custom-url",
    mode: "manual",
    launchUrl: "http://127.0.0.1:20999/mcp",
    probeUrl: "http://127.0.0.1:20999/mcp",
    host: "127.0.0.1",
    port: 20999,
    path: "/mcp",
    transport: "streamable",
    campaignId: "c-abort",
    metadata: {}
  },
  dashboard: abortDashboard,
  fetchImpl: fetch,
  sessionId: "session-abort",
  attempts: 3,
  delayMs: 10,
  signal: abortController.signal
});
assertEqual(abortedBridge.proof.result, "stopped", "bridge returns stopped proof when aborted");

const legacyTaskDashboard = await listenLegacyTaskDashboard(20388);
try {
  const legacyTasks = await takeDashboardTasks("http://127.0.0.1:20388", "session-legacy");
  assertEqual(Array.isArray(legacyTasks), true, "legacy dashboard task response normalizes to array");
  assertEqual(legacyTasks.length, 1, "legacy dashboard returns one claimed task");
  assertEqual(legacyTasks[0].tool, "legacy_tool", "legacy dashboard task tool preserved");
} finally {
  await close(legacyTaskDashboard);
}

const runtimeConfig = await loadRuntimeConfig({
  runtime: {
    getURL: () => "memory://runtime-config"
  },
  fetchImpl: async () => ({
    ok: true,
    async json() {
      return {
        dashboardMode: "remote-http",
        dashboardBaseUrl: "http://dashboard.example.com:8090",
        rebindDomain: "rebind.example.com",
        defaultProvider: "singularity-compatible",
        launcherPort: 8080
      };
    }
  })
});
assertEqual(dashboardBaseFromRuntimeConfig(runtimeConfig), "http://dashboard.example.com:8090", "runtime dashboard base");
assertEqual(labSettingsFromRuntimeConfig(runtimeConfig).labDomain, "rebind.example.com", "runtime lab domain");
assertEqual(labSettingsFromRuntimeConfig(runtimeConfig).launcherPort, "8080", "runtime launcher port");
assertEqual(formatScanStage("stage-3"), "Scan complete", "stage-3 dashboard label");
assertEqual(formatScanStage("stage-5"), "DNS rebind attack", "stage-5 dashboard label");
assertEqual(validateScanTargetAccess("localtest.me").target, "localtest.me", "scan policy allows default localtest.me");
assertEqual(validateScanTargetAccess("demo.localtest.me").target, "demo.localtest.me", "scan policy allows default localtest.me subdomain");
const googlePermissionProbe = scanTargetPermissionCandidates("google.com");
assertEqual(googlePermissionProbe.target, "google.com", "scan permission probe normalizes target");
assertEqual(googlePermissionProbe.origins.includes("http://google.com/*"), true, "scan permission probe checks exact host access");
assertEqual(googlePermissionProbe.origins.includes("http://google.com:*/*"), true, "scan permission probe checks port wildcard access");
assertEqual(
  validateScanTargetAccess("google.com", { allowedHostPermissions: ["http://google.com/*"] }).target,
  "google.com",
  "scan policy allows target when extension site access grants host"
);
try {
  validateScanTargetAccess("attacker.com", { allowedHostPermissions: ["http://google.com/*"] });
  throw new Error("scan policy should reject target not covered by site access");
} catch (error) {
  assertEqual(String(error.message).includes("http://google.com/*"), true, "scan policy error names current site access");
}
try {
  validateScanTargetAccess("localtest.mea", { allowedHostPermissions: ["http://localtest.me/*"] });
  throw new Error("scan policy should reject typo target not covered by site access");
} catch (error) {
  assertEqual(error.operatorSuggestion, "localtest.me", "scan policy suggests close allowed target");
}

console.log("rebind evidence ok");

function assertEqual(actual, expected, label) {
  if (actual !== expected) {
    throw new Error(`${label}: expected ${expected}, got ${actual}`);
  }
}

function listen(port) {
  const server = http.createServer((req, res) => {
    readBody(req).then((body) => {
      if (req.url !== "/mcp") {
        json(res, 404, {});
        return;
      }

      if (req.method === "GET") {
        json(res, 200, { mcp: true });
        return;
      }

      if (body.method === "initialize") {
        json(res, 200, {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2024-11-05",
            serverInfo: {
              name: "rebind-proof-fixture",
              version: "1.0.0"
            },
            capabilities: {
              tools: {}
            }
          }
        }, {
          "mcp-session-id": "fixture-session"
        });
        return;
      }

      if (body.method === "tools/list") {
        json(res, 200, {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            tools: [
              {
                name: "fixture_tool",
                description: "fixture tool"
              }
            ]
          }
        });
        return;
      }

      json(res, 202, {});
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function listenAfterAttackerPhase(port) {
  let initializeAttempts = 0;
  const server = http.createServer((req, res) => {
    readBody(req).then((body) => {
      if (req.url !== "/mcp") {
        json(res, 404, {});
        return;
      }

      if (body.method === "initialize") {
        initializeAttempts += 1;
        if (initializeAttempts === 1) {
          json(res, 404, { phase: "attacker" });
          return;
        }
        json(res, 200, {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2024-11-05",
            serverInfo: { name: "rebind-retry-fixture", version: "1.0.0" },
            capabilities: { tools: {} }
          }
        }, {
          "mcp-session-id": "retry-session"
        });
        return;
      }

      if (body.method === "tools/list") {
        json(res, 200, {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            tools: [{ name: "retry_tool" }]
          }
        });
        return;
      }

      json(res, 202, {});
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function listenSsePreamble(port) {
  const server = http.createServer((req, res) => {
    readBody(req).then((body) => {
      if (req.url !== "/mcp") {
        json(res, 404, {});
        return;
      }

      if (body.method === "initialize") {
        sse(res, {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2024-11-05",
            serverInfo: { name: "sse-preamble-fixture", version: "1.0.0" },
            capabilities: { tools: {} }
          }
        }, {
          "mcp-session-id": "sse-preamble-session"
        });
        return;
      }

      if (body.method === "tools/list") {
        sse(res, {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            tools: [{ name: "sse_preamble_tool" }]
          }
        });
        return;
      }

      json(res, 202, {});
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function listenMixedBridgeStream(port) {
  const server = http.createServer((req, res) => {
    readBody(req).then((body) => {
      if (req.url !== "/mcp") {
        json(res, 404, {});
        return;
      }

      if (body.method === "initialize") {
        mixed(res, {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2024-11-05",
            serverInfo: { name: "mixed-bridge-fixture", version: "1.0.0" },
            capabilities: { tools: {} }
          }
        }, {
          "mcp-session-id": "mixed-bridge-session"
        });
        return;
      }

      if (body.method === "tools/list") {
        mixed(res, {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            tools: [{ name: "mixed_bridge_tool" }]
          }
        });
        return;
      }

      json(res, 202, {});
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function listenFallbackPathBridge(port) {
  const server = http.createServer((req, res) => {
    readBody(req).then((body) => {
      if (req.url === "/mcp") {
        res.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
        res.end("404 page not found");
        return;
      }

      if (req.url !== "/") {
        json(res, 404, {});
        return;
      }

      if (body.method === "initialize") {
        json(res, 200, {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2024-11-05",
            serverInfo: { name: "root-fallback-fixture", version: "1.0.0" },
            capabilities: { tools: {} }
          }
        }, {
          "mcp-session-id": "root-fallback-session"
        });
        return;
      }

      if (body.method === "tools/list") {
        json(res, 200, {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            tools: [{ name: "root_fallback_tool" }]
          }
        });
        return;
      }

      if (body.method === "tools/call") {
        json(res, 200, {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            content: [
              {
                type: "text",
                text: `root call ok: ${body.params?.arguments?.value}`
              }
            ]
          }
        });
        return;
      }

      json(res, 202, {});
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function listenLegacySseBridge(port) {
  const server = http.createServer((req, res) => {
    readBody(req).then((body) => {
      if (req.method === "GET" && req.url === "/sse") {
        res.writeHead(200, {
          "content-type": "text/event-stream"
        });
        res.end("event: endpoint\ndata: /messages?sessionId=legacy-bridge\n\n");
        return;
      }

      if (req.method !== "POST" || !req.url.startsWith("/messages")) {
        json(res, 404, {});
        return;
      }

      if (body.method === "initialize") {
        json(res, 200, {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2024-11-05",
            serverInfo: { name: "legacy-sse-bridge", version: "1.0.0" },
            capabilities: { tools: {} }
          }
        });
        return;
      }

      if (body.method === "tools/list") {
        json(res, 200, {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            tools: [{ name: "legacy_bridge_tool" }]
          }
        });
        return;
      }

      json(res, 202, {});
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function listenRootSseInitializeBridge(port) {
  const server = http.createServer((req, res) => {
    readBody(req).then((body) => {
      if (req.url !== "/") {
        json(res, 404, {});
        return;
      }

      if (req.method === "GET") {
        sse(res, {
          jsonrpc: "2.0",
          id: 1,
          result: {
            protocolVersion: "2024-11-05",
            serverInfo: { name: "tapo-mcp", version: "0.4.0" },
            capabilities: { tools: {} }
          }
        }, {
          "content-type": "text/event-stream",
          "mcp-session-id": "tapo-root-session"
        }, { keepOpen: true });
        return;
      }

      if (body.method === "tools/list") {
        sse(res, {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            tools: [{ name: "list_devices" }]
          }
        });
        return;
      }

      json(res, 202, {});
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function listenAuthAfterInitializeBridge(port) {
  const server = http.createServer((req, res) => {
    readBody(req).then((body) => {
      if (req.url !== "/mcp") {
        json(res, 404, {});
        return;
      }

      if (body.method === "initialize") {
        json(res, 200, {
          jsonrpc: "2.0",
          id: body.id,
          result: {
            protocolVersion: "2024-11-05",
            serverInfo: { name: "huggingface-mcp", version: "1.0.0" },
            capabilities: { tools: {} },
            instructions: "Authenticated user context is active."
          }
        }, {
          "mcp-session-id": "huggingface-session"
        });
        return;
      }

      if (body.method === "tools/list") {
        json(res, 401, {
          jsonrpc: "2.0",
          id: body.id,
          error: {
            code: -32001,
            message: "Authentication required"
          }
        });
        return;
      }

      json(res, 202, {});
    });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function listenLegacyTaskDashboard(port) {
  const server = http.createServer((req, res) => {
    if (req.method === "GET" && req.url === "/api/tasks/session-legacy") {
      json(res, 200, {
        task: {
          id: "legacy-task-1",
          kind: "tools/call",
          tool: "legacy_tool",
          args: { value: 7 },
          claimedAt: "2026-07-14T00:00:00.000Z"
        }
      });
      return;
    }

    json(res, 404, { error: "not found" });
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => resolve(server));
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = "";
    req.setEncoding("utf8");
    req.on("data", (chunk) => {
      data += chunk;
    });
    req.on("end", () => {
      try {
        resolve(data ? JSON.parse(data) : {});
      } catch {
        resolve({});
      }
    });
  });
}

function json(res, status, body, headers = {}) {
  res.writeHead(status, {
    "content-type": "application/json",
    ...headers
  });
  res.end(JSON.stringify(body));
}

function sse(res, body, headers = {}, options = {}) {
  res.writeHead(200, {
    "content-type": "application/json",
    ...headers
  });
  const payload = `id: 0\nretry: 3000\n\ndata: ${JSON.stringify(body)}\n\n`;
  if (options.keepOpen) {
    res.write(payload);
    return;
  }
  res.end(payload);
}

function mixed(res, body, headers = {}) {
  res.writeHead(200, {
    "content-type": "application/json",
    ...headers
  });
  res.end(`{}\n\n${JSON.stringify(body)}\n`);
}

function asyncDashboard(dashboard) {
  return {
    registerVictim: async (value) => dashboard.registerVictim(value),
    registerSession: async (value) => dashboard.registerSession(value),
    recordEvent: async (value) => dashboard.recordEvent(value),
    recordResult: async (value) => dashboard.recordResult(value),
    listState: () => dashboard.listState()
  };
}

function createMemoryDashboard(options = {}) {
  const now = typeof options.now === "function" ? options.now : () => new Date().toISOString();
  let state = emptyState();

  return {
    registerVictim(victim) {
      const id = requireId(victim?.id, "victim id");
      state.victims[id] = stamp({ ...victim, id }, now);
      return clone(state.victims[id]);
    },

    registerSession(session) {
      const id = requireId(session?.id, "session id");
      state.sessions[id] = stamp({ ...session, id }, now);
      if (!state.tasks[id]) {
        state.tasks[id] = [];
      }
      return clone(state.sessions[id]);
    },

    recordEvent(event) {
      const item = stamp({
        id: event?.id || `event-${state.events.length + 1}`,
        ...event
      }, now);
      state.events.push(item);
      return clone(item);
    },

    recordResult(result) {
      const item = stamp({
        id: result?.id || `result-${state.results.length + 1}`,
        ...result
      }, now);
      state.results.push(item);
      return clone(item);
    },

    listState() {
      return clone(state);
    },

    queueTask(sessionId, task) {
      const sid = requireId(sessionId, "session id");
      const normalized = {
        id: task?.id || `task-${(state.tasks[sid]?.length || 0) + 1}`,
        kind: task?.kind || "tools/list",
        createdAt: now(),
        ...task
      };
      if (!state.tasks[sid]) {
        state.tasks[sid] = [];
      }
      state.tasks[sid].push(normalized);
      return clone(normalized);
    },

    takeTasks(sessionId) {
      const sid = requireId(sessionId, "session id");
      const tasks = state.tasks[sid] || [];
      state.tasks[sid] = [];
      return clone(tasks);
    },

    clear() {
      state = emptyState();
      return this.listState();
    },

    exportEvidence() {
      return {
        exportedAt: now(),
        ...this.listState()
      };
    }
  };
}

function emptyState() {
  return {
    victims: {},
    sessions: {},
    events: [],
    results: [],
    tasks: {}
  };
}

function stamp(value, now) {
  return {
    ...value,
    receivedAt: value.receivedAt || now()
  };
}

function requireId(value, label) {
  const id = String(value || "").trim();
  if (!id) {
    throw new Error(`${label} is required.`);
  }
  return id;
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
