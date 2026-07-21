import { Stage } from "./messages.js";
import { emptyRebindProof } from "./rebind-evidence.js";

const DEFAULT_TARGET = "localtest.me";
const DEFAULT_PORTS = "8000-9000";
const DEFAULT_TIMEOUT_MS = 1200;
const DEFAULT_CONCURRENCY = 64;
const MAX_PORTS_PER_SCAN = 20000;
const MCP_ENDPOINT_PATHS = ["/", "/mcp", "/sse", "/messages"];
const ROOT_FAILED_ENDPOINT_PATHS = ["/mcp", "/sse"];
const MCP_PROTOCOL_VERSION = "2025-06-18";
const MCP_PROTOCOL_VERSIONS = ["2025-06-18", "2025-03-26", "2024-11-05"];
const ATTACKER_ORIGIN = "https://attacker.example";
const ATTACKER_HOST = "attacker.example";
const STREAM_SNIPPET_TIMEOUT_MS = 1600;
const MAX_BODY_SNIPPET_BYTES = 32768;
const SCAN_HOST_PERMISSIONS = [
  "http://localtest.me:*/*",
  "http://*.localtest.me:*/*"
];

export async function runLocalPortScan(payload = {}, scanSignal, hooks = {}) {
  const startedAt = new Date().toISOString();
  const target = validateScanTargetAccess(payload.target || DEFAULT_TARGET, {
    allowedHostPermissions: payload.allowedHostPermissions
  }).target;
  const portsInput = String(payload.ports || DEFAULT_PORTS).trim();
  const ports = parsePorts(portsInput);
  const timeoutMs = normalizePositiveInteger(payload.timeoutMs, DEFAULT_TIMEOUT_MS);
  const concurrency = normalizePositiveInteger(payload.concurrency, DEFAULT_CONCURRENCY);
  const progress = createProgressReporter(hooks.onProgress, startedAt);

  if (ports.length > MAX_PORTS_PER_SCAN) {
    throw new Error(`Refusing to scan ${ports.length} ports. Local scan limit is ${MAX_PORTS_PER_SCAN}.`);
  }

  const results = await mapWithConcurrency(
    ports,
    Math.min(concurrency, ports.length),
    (port) => probeHttpRoot(target, port, timeoutMs, scanSignal),
    scanSignal,
    progress.forPhase("ports", ports.length)
  );

  const responsive = results.filter((result) => result.state === "responsive");
  const endpointProbeTargets = results.filter((result) => result.state !== "timed_out");
  const probed = await mapWithConcurrency(
    endpointProbeTargets,
    Math.min(concurrency, Math.max(endpointProbeTargets.length, 1)),
    (result) => probeMcpSurface(target, result, timeoutMs, scanSignal),
    scanSignal,
    progress.forPhase("endpoints", endpointProbeTargets.length)
  );
  const headerTested = await mapWithConcurrency(
    probed,
    Math.min(concurrency, Math.max(probed.length, 1)),
    (result) => enrichWithHeaderValidation(result, timeoutMs, scanSignal),
    scanSignal,
    progress.forPhase("headers", probed.length)
  );
  const findings = headerTested
    .filter((result) => result.mcpDetected || result.toolListingDetected)
    .map((result) => toFinding(target, result));

  const scanResult = {
    stage: Stage.HeaderValidation,
    status: "completed",
    startedAt,
    completedAt: new Date().toISOString(),
    target,
    ports: portsInput,
    summary: {
      scanned: results.length,
      responsive: headerTested.filter((result) => result.state === "responsive").length,
      timedOut: results.filter((result) => result.state === "timed_out").length,
      failed: headerTested.filter((result) => result.state === "closed_or_blocked").length,
      mcpDetected: headerTested.filter((result) => result.mcpDetected).length,
      sseDetected: headerTested.filter((result) => result.sseDetected).length,
      toolListingDetected: headerTested.filter((result) => result.toolListingDetected).length,
      authRequired: headerTested.filter((result) => result.fingerprint?.auth?.required).length,
      likelyVulnerable: headerTested.filter((result) => result.headerValidation?.result === "likely_vulnerable").length,
      weakSignal: headerTested.filter((result) => result.headerValidation?.result === "weak_signal").length,
      findings: findings.length
    },
    findings
  };

  if (payload.includeRawResults) {
    scanResult.portResults = results;
    scanResult.endpointResults = headerTested;
  }

  return scanResult;
}

export function validateScanTargetAccess(target, options = {}) {
  const normalized = normalizeTarget(target || DEFAULT_TARGET);
  const allowedHostPermissions = normalizeAllowedHostPermissions(options.allowedHostPermissions);

  if (targetAllowedByHostPermissions(normalized, allowedHostPermissions)) {
    return {
      target: normalized,
      allowed: true,
      allowedHostPermissions
    };
  }

  const error = new Error(scanTargetPolicyMessage(normalized, allowedHostPermissions));
  error.name = "ScanTargetAccessError";
  error.target = normalized;
  error.allowedHostPermissions = allowedHostPermissions;
  error.operatorSummary = "Site access blocks that origin.";
  error.operatorAction = "Grant this extension Site access for the target origin, or repack it with an explicit host permission for an authorized origin.";
  error.operatorSuggestion = suggestAllowedTarget(normalized, allowedHostPermissions);
  throw error;
}

export function scanTargetPermissionCandidates(target) {
  const normalized = normalizeTarget(target || DEFAULT_TARGET);
  return {
    target: normalized,
    origins: [
      `http://${normalized}/*`,
      `http://${normalized}:*/*`
    ]
  };
}

export function parsePorts(input) {
  const ports = new Set();
  const parts = String(input || "").split(",");

  for (const rawPart of parts) {
    const part = rawPart.trim();

    if (!part) {
      continue;
    }

    if (part.includes("-")) {
      const [rawStart, rawEnd] = part.split("-", 2);
      const start = parsePort(rawStart);
      const end = parsePort(rawEnd);

      if (end < start) {
        throw new Error(`Invalid port range: ${part}`);
      }

      for (let port = start; port <= end; port += 1) {
        ports.add(port);
      }

      continue;
    }

    ports.add(parsePort(part));
  }

  if (ports.size === 0) {
    throw new Error("At least one port is required.");
  }

  return [...ports].sort((a, b) => a - b);
}

function parsePort(value) {
  const portText = String(value).trim();
  const port = Number.parseInt(portText, 10);

  if (!Number.isInteger(port) || port < 1 || port > 65535 || String(port) !== portText) {
    throw new Error(`Invalid port: ${value}`);
  }

  return port;
}

function normalizeTarget(target) {
  const normalized = String(target || "").trim().toLowerCase();

  if (/^[a-z0-9.-]+$/.test(normalized) && !normalized.includes("..") && !normalized.startsWith(".") && !normalized.endsWith(".")) {
    return normalized;
  }

  throw new Error(`Invalid scanner target: ${target}`);
}

function scanTargetPolicyMessage(target, allowedHostPermissions) {
  return [
    `Browser policy blocks scanning ${target}.`,
    `Current extension Site access allows: ${allowedHostPermissions.join(", ")}.`,
    "Grant Site access for this target, or repack the extension with explicit host permissions for another authorized origin."
  ].join(" ");
}

function normalizeAllowedHostPermissions(value) {
  return Array.isArray(value) && value.length ? value.map(String) : [...SCAN_HOST_PERMISSIONS];
}

function targetAllowedByHostPermissions(target, permissions) {
  return permissions.some((permission) => hostPermissionMatchesTarget(permission, target));
}

function suggestAllowedTarget(target, permissions) {
  const candidates = permissions
    .map(permissionHost)
    .filter((host) => host && host !== "*")
    .map((host) => host.startsWith("*.") ? host.slice(2) : host);

  for (const candidate of [...new Set(candidates)]) {
    if (editDistance(target, candidate) <= 2) {
      return candidate;
    }
  }

  return "";
}

function permissionHost(permission) {
  const raw = String(permission || "").trim().toLowerCase();
  const match = raw.match(/^(?:\*|http|https):\/\/([^/:/*]+|\*\.[^/:/*]+|\*)(?::\*)?\/\*$/);
  return match?.[1] || "";
}

function hostPermissionMatchesTarget(permission, target) {
  const raw = String(permission || "").trim().toLowerCase();
  if (raw === "<all_urls>") {
    return true;
  }

  const match = raw.match(/^(?:\*|http|https):\/\/([^/:/*]+|\*\.[^/:/*]+|\*)(?::\*)?\/\*$/);
  if (!match) {
    return false;
  }

  const host = match[1];
  if (host === "*") {
    return true;
  }

  if (host.startsWith("*.")) {
    const suffix = host.slice(2);
    return target.endsWith(`.${suffix}`);
  }

  return target === host;
}

function editDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);

  for (let leftIndex = 0; leftIndex < left.length; leftIndex += 1) {
    let diagonal = previous[0];
    previous[0] = leftIndex + 1;

    for (let rightIndex = 0; rightIndex < right.length; rightIndex += 1) {
      const cost = left[leftIndex] === right[rightIndex] ? 0 : 1;
      const nextDiagonal = previous[rightIndex + 1];
      previous[rightIndex + 1] = Math.min(
        previous[rightIndex + 1] + 1,
        previous[rightIndex] + 1,
        diagonal + cost
      );
      diagonal = nextDiagonal;
    }
  }

  return previous[right.length];
}

function normalizePositiveInteger(value, fallback) {
  const parsed = Number.parseInt(String(value || ""), 10);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function mapWithConcurrency(items, concurrency, mapper, signal, onItemComplete = null) {
  const results = new Array(items.length);
  let nextIndex = 0;
  let completed = 0;

  async function worker() {
    while (nextIndex < items.length) {
      if (signal?.aborted) {
        throw new DOMException("Scan cancelled.", "AbortError");
      }

      const currentIndex = nextIndex;
      nextIndex += 1;
      results[currentIndex] = await mapper(items[currentIndex]);
      completed += 1;
      onItemComplete?.({
        completed,
        total: items.length,
        item: items[currentIndex],
        result: results[currentIndex]
      });
    }
  }

  if (!items.length) {
    onItemComplete?.({
      completed: 0,
      total: 0,
      item: null,
      result: null
    });
    return results;
  }

  const workers = Array.from({ length: Math.min(concurrency, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

function createProgressReporter(onProgress, startedAt) {
  let lastEmitMs = 0;
  const minIntervalMs = 250;

  return {
    forPhase(phase, total) {
      if (typeof onProgress !== "function") {
        return null;
      }

      emit({
        phase,
        completed: 0,
        total
      }, true);

      return ({ completed, result }) => {
        emit({
          phase,
          completed,
          total,
          lastPort: result?.port || null,
          responsive: result?.state === "responsive" || result?.responsive || false,
          mcpDetected: Boolean(result?.mcpDetected),
          findingDetected: Boolean(result?.mcpDetected || result?.toolListingDetected)
        }, completed === total);
      };
    }
  };

  function emit(event, force = false) {
    const now = Date.now();

    if (!force && now - lastEmitMs < minIntervalMs) {
      return;
    }

    lastEmitMs = now;
    onProgress({
      ...event,
      startedAt,
      emittedAt: new Date(now).toISOString(),
      percent: event.total ? Math.round((event.completed / event.total) * 100) : 100
    });
  }
}

async function probeHttpRoot(target, port, timeoutMs, scanSignal) {
  const url = `http://${target}:${port}/`;
  const startedAt = performance.now();
  const controller = new AbortController();
  let timedOut = false;
  let removeAbortListener = null;

  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  if (scanSignal) {
    const abortCurrentProbe = () => controller.abort();
    scanSignal.addEventListener("abort", abortCurrentProbe, { once: true });
    removeAbortListener = () => scanSignal.removeEventListener("abort", abortCurrentProbe);
  }

  try {
    const response = await fetch(url, {
      method: "GET",
      cache: "no-store",
      redirect: "manual",
      signal: controller.signal
    });

    const contentType = response.headers.get("content-type");
    const bodySnippet = await readBodySnippet(response, contentType);

    return {
      port,
      url,
      state: "responsive",
      status: response.status,
      statusText: response.statusText,
      contentType,
      headers: gatherInterestingHeaders(response.headers),
      elapsedMs: elapsedSince(startedAt),
      bodySnippet
    };
  } catch (error) {
    if (scanSignal?.aborted) {
      throw new DOMException("Scan cancelled.", "AbortError");
    }

    return {
      port,
      url,
      state: timedOut ? "timed_out" : "closed_or_blocked",
      status: null,
      statusText: null,
      contentType: null,
      elapsedMs: elapsedSince(startedAt),
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    clearTimeout(timeoutId);
    removeAbortListener?.();
  }
}

async function probeMcpSurface(target, rootResult, timeoutMs, scanSignal) {
  const endpointResults = [];
  const endpointPaths = rootResult.state === "responsive" ? MCP_ENDPOINT_PATHS : ROOT_FAILED_ENDPOINT_PATHS;

  for (const path of endpointPaths) {
    if (scanSignal?.aborted) {
      throw new DOMException("Scan cancelled.", "AbortError");
    }

    endpointResults.push(await probeEndpoint(target, rootResult.port, path, timeoutMs, scanSignal));
  }

  const candidateEndpoints = endpointResults.filter(isMcpCandidateEndpoint);
  const toolAttempts = [];

  for (const endpoint of candidateEndpoints) {
    const attempt = await attemptMcpConnection(endpoint.url, timeoutMs, scanSignal);
    toolAttempts.push(attempt);

    if (attempt.tools.length > 0) {
      break;
    }
  }

  const tools = dedupeTools(toolAttempts.flatMap((attempt) => attempt.tools));
  const sseDetected = endpointResults.some((result) => result.sseDetected);
  const jsonRpcDetected = endpointResults.some((result) => result.jsonRpcDetected) ||
    toolAttempts.some((attempt) => attempt.jsonRpcDetected);
  const detectionEvidence = gatherMcpDetectionEvidence(endpointResults, toolAttempts, tools);
  const mcpDetected = detectionEvidence.length > 0;

  return {
    ...rootResult,
    state: rootResult.state === "responsive" || mcpDetected ? "responsive" : rootResult.state,
    responsive: rootResult.state === "responsive" || mcpDetected,
    endpointResults,
    toolAttempts,
    sseDetected,
    jsonRpcDetected,
    mcpDetected,
    detectionEvidence,
    fingerprint: buildMcpFingerprint(rootResult, endpointResults, toolAttempts, tools),
    toolListingDetected: tools.length > 0,
    tools
  };
}

async function probeEndpoint(target, port, path, timeoutMs, scanSignal) {
  const url = `http://${target}:${port}${path}`;
  const startedAt = performance.now();
  const result = await fetchWithTimeout(url, {
    method: "GET",
    headers: {
      accept: "application/json, text/event-stream, text/plain, */*"
    },
    cache: "no-store",
    redirect: "manual"
  }, timeoutMs, scanSignal);

  if (!result.response) {
    return {
      path,
      url,
      state: result.timedOut ? "timed_out" : "failed",
      status: null,
      statusText: null,
      contentType: null,
      elapsedMs: elapsedSince(startedAt),
      bodySnippet: "",
      error: result.error
    };
  }

  const response = result.response;
  const contentType = response.headers.get("content-type");
  const bodySnippet = await readBodySnippet(response, contentType);

  return {
    path,
    url,
    state: "responsive",
    status: response.status,
    statusText: response.statusText,
    contentType,
    headers: gatherInterestingHeaders(response.headers),
    elapsedMs: elapsedSince(startedAt),
    bodySnippet,
    sseDetected: isSseResponse(contentType, bodySnippet),
    jsonRpcDetected: hasJsonRpcSignal(bodySnippet),
    mcpKeywordDetected: hasMcpKeywordSignal(bodySnippet),
    streamableHttpPostRequired: hasStreamableHttpPostRequired(bodySnippet)
  };
}

async function attemptMcpConnection(url, timeoutMs, scanSignal) {
  const streamable = await attemptStreamableHttpToolList(url, timeoutMs, scanSignal);

  if (streamable.tools.length > 0 || streamable.mcpDetected) {
    return streamable;
  }

  const legacy = await attemptLegacySseToolList(url, timeoutMs, scanSignal);

  if (legacy.tools.length > 0 || legacy.legacyEndpointDetected) {
    return legacy;
  }

  return streamable;
}

async function attemptStreamableHttpToolList(url, timeoutMs, scanSignal) {
  let initialize = null;
  let initialized = null;
  let toolsList = null;
  let negotiatedVersion = MCP_PROTOCOL_VERSION;

  for (const protocolVersion of MCP_PROTOCOL_VERSIONS) {
    initialize = await postJsonRpc(
      url,
      buildInitializeRequest(protocolVersion),
      timeoutMs,
      scanSignal,
      buildProtocolHeaders(protocolVersion)
    );

    negotiatedVersion = extractProtocolVersion(initialize.bodySnippet) || protocolVersion;

    if (hasInitializeResult(initialize.bodySnippet) || hasStreamableSession(initialize)) {
      break;
    }
  }

  if (!hasInitializeResult(initialize?.bodySnippet) && !hasStreamableSession(initialize)) {
    return {
      url,
      transport: "streamable-http",
      initialize,
      initialized,
      toolsList: buildSkippedResponse("tools/list skipped because initialize did not return an MCP initialize result."),
      jsonRpcDetected: Boolean(initialize?.jsonRpcDetected),
      mcpDetected: Boolean(initialize?.mcpDetected),
      tools: []
    };
  }

  const sessionHeaders = buildSessionHeaders(initialize, negotiatedVersion);
  initialized = await postJsonRpc(url, {
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: {}
  }, timeoutMs, scanSignal, sessionHeaders);

  toolsList = await postJsonRpc(url, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {}
  }, timeoutMs, scanSignal, sessionHeaders);

  return {
    url,
    transport: "streamable-http",
    negotiatedVersion,
    initialize,
    initialized,
    toolsList,
    jsonRpcDetected: initialize.jsonRpcDetected || toolsList.jsonRpcDetected,
    mcpDetected: initialize.mcpDetected || toolsList.mcpDetected || hasStreamableSession(initialize),
    tools: extractTools(toolsList.bodySnippet)
  };
}

function buildSkippedResponse(reason) {
  return {
    request: null,
    status: null,
    contentType: null,
    headers: {},
    sessionId: null,
    bodySnippet: reason,
    jsonRpcDetected: false,
    mcpDetected: false,
    skipped: true
  };
}

async function attemptLegacySseToolList(url, timeoutMs, scanSignal) {
  const sseOpen = await getSseEndpoint(url, timeoutMs, scanSignal);
  const messageEndpoint = extractLegacyMessageEndpoint(sseOpen.bodySnippet, url);
  const legacyEndpointDetected = Boolean(messageEndpoint);

  if (!messageEndpoint) {
    return {
      url,
      transport: "legacy-sse",
      sseOpen,
      initialize: sseOpen,
      initialized: null,
      toolsList: sseOpen,
      legacySseDetected: sseOpen.sseDetected,
      legacyEndpointDetected,
      jsonRpcDetected: sseOpen.jsonRpcDetected,
      mcpDetected: false,
      tools: []
    };
  }

  const initialize = await postJsonRpc(messageEndpoint, buildInitializeRequest("2024-11-05"), timeoutMs, scanSignal, {
    accept: "application/json, text/event-stream, */*"
  });
  const initialized = await postJsonRpc(messageEndpoint, {
    jsonrpc: "2.0",
    method: "notifications/initialized"
  }, timeoutMs, scanSignal, {
    accept: "application/json, text/event-stream, */*"
  });
  const toolsList = await postJsonRpc(messageEndpoint, {
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {}
  }, timeoutMs, scanSignal, {
    accept: "application/json, text/event-stream, */*"
  });

  return {
    url,
    transport: "legacy-sse",
    sseOpen,
    messageEndpoint,
    initialize,
    initialized,
    toolsList,
    legacySseDetected: true,
    legacyEndpointDetected,
    jsonRpcDetected: sseOpen.jsonRpcDetected || initialize.jsonRpcDetected || toolsList.jsonRpcDetected,
    mcpDetected: true,
    tools: extractTools(toolsList.bodySnippet)
  };
}

async function getSseEndpoint(url, timeoutMs, scanSignal) {
  const result = await fetchWithTimeout(url, {
    method: "GET",
    headers: {
      accept: "text/event-stream"
    },
    cache: "no-store",
    redirect: "manual"
  }, timeoutMs, scanSignal);

  if (!result.response) {
    return {
      status: null,
      contentType: null,
      headers: {},
      bodySnippet: "",
      sseDetected: false,
      jsonRpcDetected: false,
      mcpDetected: false,
      error: result.error
    };
  }

  const contentType = result.response.headers.get("content-type");
  const bodySnippet = await readBodySnippet(result.response, contentType);

  return {
    status: result.response.status,
    contentType,
    headers: gatherInterestingHeaders(result.response.headers),
    bodySnippet,
    sseDetected: isSseResponse(contentType, bodySnippet),
    jsonRpcDetected: hasJsonRpcSignal(bodySnippet),
    mcpDetected: hasMcpKeywordSignal(bodySnippet) || hasJsonRpcSignal(bodySnippet) || isSseResponse(contentType, bodySnippet)
  };
}

async function postJsonRpc(url, body, timeoutMs, scanSignal, extraHeaders = {}) {
  const headers = {
    accept: "application/json, text/event-stream",
    "content-type": "application/json",
    ...buildProtocolHeaders(MCP_PROTOCOL_VERSION),
    ...extraHeaders
  };
  const bodyText = JSON.stringify(body);
  const result = await fetchWithTimeout(url, {
    method: "POST",
    headers,
    cache: "no-store",
    redirect: "manual",
    body: bodyText
  }, timeoutMs, scanSignal);

  if (!result.response) {
    return {
      request: {
        method: "POST",
        url,
        headers,
        body: bodyText
      },
      status: null,
      contentType: null,
      bodySnippet: "",
      jsonRpcDetected: false,
      mcpDetected: false,
      error: result.error
    };
  }

  const contentType = result.response.headers.get("content-type");
  const bodySnippet = await readBodySnippet(result.response, contentType);

  return {
    request: {
      method: "POST",
      url,
      headers,
      body: bodyText
    },
    responseUrl: result.response.url,
    redirected: result.response.redirected,
    status: result.response.status,
    contentType,
    headers: gatherInterestingHeaders(result.response.headers),
    sessionId: result.response.headers.get("mcp-session-id"),
    bodySnippet,
    jsonRpcDetected: hasJsonRpcSignal(bodySnippet),
    mcpDetected: hasJsonRpcSignal(bodySnippet) || hasMcpKeywordSignal(bodySnippet)
  };
}

async function fetchWithTimeout(url, options, timeoutMs, scanSignal) {
  const controller = new AbortController();
  let timedOut = false;
  let removeAbortListener = null;

  const timeoutId = setTimeout(() => {
    timedOut = true;
    controller.abort();
  }, timeoutMs);

  if (scanSignal) {
    const abortCurrentProbe = () => controller.abort();
    scanSignal.addEventListener("abort", abortCurrentProbe, { once: true });
    removeAbortListener = () => scanSignal.removeEventListener("abort", abortCurrentProbe);
  }

  try {
    return {
      response: await fetch(url, {
        ...options,
        signal: controller.signal
      }),
      timedOut: false,
      error: null
    };
  } catch (error) {
    if (scanSignal?.aborted) {
      throw new DOMException("Scan cancelled.", "AbortError");
    }

    return {
      response: null,
      timedOut,
      error: error instanceof Error ? error.message : String(error)
    };
  } finally {
    clearTimeout(timeoutId);
    removeAbortListener?.();
  }
}

async function enrichWithHeaderValidation(result, timeoutMs, scanSignal) {
  if (!result.mcpDetected && !result.toolListingDetected) {
    return {
      ...result,
      headerValidation: buildUntestedHeaderValidation("No confirmed MCP service was detected on this port.")
    };
  }

  return {
    ...result,
    headerValidation: await testHeaderValidation(result, timeoutMs, scanSignal)
  };
}

async function testHeaderValidation(result, timeoutMs, scanSignal) {
  const candidateEndpoints = result.endpointResults
    .filter(isMcpCandidateEndpoint)
    .slice(0, 4);
  const endpointTests = [];

  for (const endpoint of candidateEndpoints) {
    endpointTests.push({
      path: endpoint.path,
      url: endpoint.url,
      combined: await requestWithForgedHeaders(endpoint.url, "combined", timeoutMs, scanSignal),
      originOnly: await requestWithForgedHeaders(endpoint.url, "origin_only", timeoutMs, scanSignal),
      hostOnly: await requestWithForgedHeaders(endpoint.url, "host_only", timeoutMs, scanSignal)
    });
  }

  const evaluations = endpointTests.flatMap((test) => [test.combined, test.originOnly, test.hostOnly]);
  const strongest = strongestHeaderEvaluation(evaluations);

  return {
    tested: endpointTests.length > 0,
    attackerOrigin: ATTACKER_ORIGIN,
    attackerHost: ATTACKER_HOST,
    result: strongest.result,
    evidence: strongest.evidence,
    endpointTests,
    limitations: [
      "Stage 3 is a direct header-validation probe, not a real DNS rebinding test.",
      "After MCP discovery, header probing does not send another POST initialize because some MCP servers only allow one handshake per session.",
      "Browser fetch APIs may block or rewrite forbidden headers such as Host and Origin. The result records request errors when that happens.",
      "CORS headers are recorded as auxiliary metadata only. They do not drive the vulnerability verdict."
    ]
  };
}

async function requestWithForgedHeaders(url, mode, timeoutMs, scanSignal) {
  const headers = {
    accept: "application/json, text/event-stream, text/plain, */*"
  };

  if (mode === "combined" || mode === "origin_only") {
    headers.origin = ATTACKER_ORIGIN;
  }

  if (mode === "combined" || mode === "host_only") {
    headers.host = ATTACKER_HOST;
  }

  const getResult = await requestWithHeaders(url, "GET", headers, null, timeoutMs, scanSignal);
  const postResult = buildSkippedHeaderRequest("POST initialize skipped to avoid consuming a one-shot MCP handshake.");
  const evaluation = evaluateHeaderAcceptance(mode, getResult, postResult);

  return {
    mode,
    requestedHeaders: headers,
    result: evaluation.result,
    evidence: evaluation.evidence,
    get: getResult,
    post: postResult
  };
}

function buildSkippedHeaderRequest(reason) {
  return {
    method: "POST",
    status: null,
    headers: {},
    bodySnippet: "",
    jsonRpcDetected: false,
    mcpDetected: false,
    toolListingDetected: false,
    result: "skipped",
    evidence: reason,
    skipped: true
  };
}

async function requestWithHeaders(url, method, headers, body, timeoutMs, scanSignal) {
  const result = await fetchWithTimeout(url, {
    method,
    headers,
    cache: "no-store",
    redirect: "manual",
    body
  }, timeoutMs, scanSignal);

  if (!result.response) {
    return {
      method,
      status: null,
      headers: {},
      bodySnippet: "",
      jsonRpcDetected: false,
      mcpDetected: false,
      toolListingDetected: false,
      result: "unknown",
      evidence: result.error || `${method} request did not complete.`
    };
  }

  const contentType = result.response.headers.get("content-type");
  const bodySnippet = await readBodySnippet(result.response, contentType);

  const corsHeaders = gatherCorsHeaders(result.response.headers);

  return {
    method,
    status: result.response.status,
    headers: {
      ...gatherInterestingHeaders(result.response.headers),
      ...corsHeaders
    },
    bodySnippet,
    observedAttackerHost: responseContainsHostEvidence(bodySnippet, result.response.headers),
    observedAttackerOrigin: responseContainsOriginEvidence(bodySnippet, result.response.headers),
    jsonRpcDetected: hasJsonRpcSignal(bodySnippet),
    mcpDetected: hasJsonRpcSignal(bodySnippet) || hasMcpKeywordSignal(bodySnippet) || isSseResponse(contentType, bodySnippet),
    toolListingDetected: extractTools(bodySnippet).length > 0,
    result: "observed",
    evidence: `${method} returned HTTP ${result.response.status}.`
  };
}

function evaluateHeaderAcceptance(mode, getResult, postResult) {
  const acceptedMcpGet = isSuccessfulHttp(getResult.status) && getResult.mcpDetected;
  const acceptedMcpPost = isSuccessfulHttp(postResult.status) &&
    (postResult.jsonRpcDetected || postResult.toolListingDetected || postResult.mcpDetected);
  const observedHostAndOrigin = (getResult.observedAttackerHost && getResult.observedAttackerOrigin) ||
    (postResult.observedAttackerHost && postResult.observedAttackerOrigin);

  if (mode === "combined" && (acceptedMcpGet || acceptedMcpPost) && observedHostAndOrigin) {
    return {
      result: "likely_vulnerable",
      evidence: `MCP endpoint responded to attacker-style Host ${ATTACKER_HOST} and Origin ${ATTACKER_ORIGIN}.`
    };
  }

  if (mode === "combined" && (acceptedMcpGet || acceptedMcpPost)) {
    return {
      result: "weak_signal",
      evidence: `MCP endpoint responded to a forged-header probe, but Host transmission was not verified. Requested Host ${ATTACKER_HOST} and Origin ${ATTACKER_ORIGIN}.`
    };
  }

  if ((mode === "origin_only" || mode === "host_only") && (acceptedMcpGet || acceptedMcpPost)) {
    return {
      result: "weak_signal",
      evidence: `MCP endpoint responded to ${mode === "origin_only" ? `Origin ${ATTACKER_ORIGIN}` : `Host ${ATTACKER_HOST}`} alone.`
    };
  }

  if (isSuccessfulHttp(getResult.status) || isSuccessfulHttp(postResult.status)) {
    return {
      result: "weak_signal",
      evidence: "Endpoint returned HTTP success to forged-header request, but MCP-specific response evidence was weak."
    };
  }

  if (getResult.status || postResult.status) {
    return {
      result: "not_vulnerable",
      evidence: "Endpoint did not return a successful MCP response to forged-header requests."
    };
  }

  return {
    result: "unknown",
    evidence: "Forged-header requests did not complete. Browser header restrictions or network behavior may have blocked the probe."
  };
}

function strongestHeaderEvaluation(evaluations) {
  const priority = {
    likely_vulnerable: 3,
    weak_signal: 2,
    not_vulnerable: 1,
    unknown: 0
  };

  return evaluations.reduce((strongest, current) => {
    if (!strongest || priority[current.result] > priority[strongest.result]) {
      return current;
    }

    return strongest;
  }, null) || {
    result: "unknown",
    evidence: "No header-validation tests ran."
  };
}

function buildUntestedHeaderValidation(reason) {
  return {
    tested: false,
    attackerOrigin: ATTACKER_ORIGIN,
    attackerHost: ATTACKER_HOST,
    result: "unknown",
    evidence: reason,
    endpointTests: [],
    limitations: []
  };
}

async function readBodySnippet(response, contentType) {
  if (!contentType || !isTextContent(contentType)) {
    return "";
  }

  if (contentType.includes("text/event-stream")) {
    return readStreamSnippet(response, STREAM_SNIPPET_TIMEOUT_MS, MAX_BODY_SNIPPET_BYTES);
  }

  const text = await response.text();
  return normalizeSnippet(text);
}

async function readStreamSnippet(response, timeoutMs, maxBytes) {
  const reader = response.body?.getReader();

  if (!reader) {
    return "SSE stream detected. Response body was not readable.";
  }

  const decoder = new TextDecoder();
  let bytesRead = 0;
  let text = "";

  try {
    while (bytesRead < maxBytes) {
      const next = await Promise.race([
        reader.read(),
        sleep(timeoutMs).then(() => ({ timedOut: true }))
      ]);

      if (next.timedOut || next.done) {
        break;
      }

      bytesRead += next.value.byteLength;
      text += decoder.decode(next.value, { stream: true });

      if (hasJsonRpcSignal(text) || text.includes("\"tools\"")) {
        break;
      }
    }
  } finally {
    await reader.cancel().catch(() => {});
  }

  return normalizeStreamSnippet(text || "SSE stream detected. No event data arrived before timeout.");
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeSnippet(text) {
  return text.replace(/\r\n/g, "\n").replace(/\s+/g, " ").trim().slice(0, MAX_BODY_SNIPPET_BYTES);
}

function normalizeStreamSnippet(text) {
  return text.replace(/\r\n/g, "\n").trim().slice(0, MAX_BODY_SNIPPET_BYTES);
}

function isTextContent(contentType) {
  return [
    "application/json",
    "application/problem+json",
    "application/xml",
    "text/",
    "application/javascript"
  ].some((candidate) => contentType.includes(candidate));
}

function elapsedSince(startedAt) {
  return Math.round(performance.now() - startedAt);
}

function toFinding(target, result) {
  const evidence = result.endpointResults
    .filter((endpoint) => endpoint.state === "responsive")
    .map((endpoint) => ({
      path: endpoint.path,
      status: endpoint.status,
      contentType: endpoint.contentType,
      bodySnippet: endpoint.bodySnippet || describeEndpointSignal(endpoint)
    }));

  for (const attempt of result.toolAttempts) {
    if (attempt.tools.length > 0 || attempt.jsonRpcDetected || attempt.mcpDetected) {
      const attemptEvidence = summarizeAttemptEvidence(attempt);
      evidence.push({
        path: new URL(attempt.url).pathname,
        status: attempt.toolsList?.status,
        contentType: attempt.toolsList?.contentType,
        bodySnippet: attempt.tools.length > 0
          ? `tools/list returned ${attempt.tools.length} tool(s).`
          : attemptEvidence
      });
    }
  }

  if (result.headerValidation?.tested) {
    evidence.push({
      path: "header-validation",
      status: null,
      contentType: null,
      bodySnippet: result.headerValidation.evidence
    });
  }

  if (result.fingerprint?.auth?.required) {
    evidence.push({
      path: "auth",
      status: null,
      contentType: null,
      bodySnippet: result.fingerprint.auth.evidence.join(" | ")
    });
  }

  return {
    target,
    port: result.port,
    baseUrl: result.url,
    responsive: true,
    matchedEndpoints: result.endpointResults
      .filter((endpoint) => endpoint.sseDetected || endpoint.jsonRpcDetected || endpoint.mcpKeywordDetected)
      .map((endpoint) => endpoint.path),
    mcpDetected: result.mcpDetected,
    detectionEvidence: result.detectionEvidence,
    fingerprint: result.fingerprint,
    sseDetected: result.sseDetected,
    jsonRpcDetected: result.jsonRpcDetected,
    toolListingDetected: result.toolListingDetected,
    tools: result.tools,
    headerValidation: {
      tested: Boolean(result.headerValidation?.tested),
      result: result.headerValidation?.result || "unknown",
      evidence: result.headerValidation?.evidence || "Header validation test did not run.",
      attackerOrigin: result.headerValidation?.attackerOrigin || ATTACKER_ORIGIN,
      attackerHost: result.headerValidation?.attackerHost || ATTACKER_HOST,
      limitations: result.headerValidation?.limitations || []
    },
    originValidation: {
      tested: Boolean(result.headerValidation?.tested),
      result: result.headerValidation?.result || "unknown",
      evidence: result.headerValidation?.evidence || "Origin validation test did not run.",
      attackerOrigin: result.headerValidation?.attackerOrigin || ATTACKER_ORIGIN,
      limitations: result.headerValidation?.limitations || []
    },
    hostValidation: {
      tested: Boolean(result.headerValidation?.tested),
      result: result.headerValidation?.result || "unknown",
      evidence: result.headerValidation?.evidence || "Host validation test did not run.",
      attackerHost: result.headerValidation?.attackerHost || ATTACKER_HOST,
      limitations: result.headerValidation?.limitations || []
    },
    rebindProof: emptyRebindProof(),
    confidence: classifyConfidence(result),
    severity: classifySeverity(result),
    evidence
  };
}

function gatherInterestingHeaders(headers) {
  const names = [
    "access-control-allow-origin",
    "access-control-allow-methods",
    "access-control-allow-headers",
    "access-control-allow-credentials",
    "content-type",
    "mcp-session-id",
    "server",
    "x-observed-host",
    "x-observed-origin"
  ];
  const gathered = {};

  for (const name of names) {
    const value = headers.get(name);

    if (value) {
      gathered[name] = value;
    }
  }

  return gathered;
}

function summarizeAttemptEvidence(attempt) {
  const parts = [
    formatRpcEvidence("initialize", attempt.initialize),
    formatRpcEvidence("initialized", attempt.initialized),
    formatRpcEvidence("tools/list", attempt.toolsList)
  ];

  return parts.join(" | ").slice(0, MAX_BODY_SNIPPET_BYTES);
}

function formatRpcEvidence(label, response) {
  if (!response) {
    return `${label}: no response`;
  }

  const method = response.request?.method || "POST";
  const url = response.request?.url || "";
  const responseUrl = response.responseUrl && response.responseUrl !== url ? ` responseUrl=${response.responseUrl}` : "";
  const session = response.sessionId ? ` session=${response.sessionId}` : "";
  return `${label}: request=${method} ${url} status=${response.status ?? "no status"}${responseUrl}${session} body=${response.bodySnippet || ""}`.trim();
}

function gatherCorsHeaders(headers) {
  const names = [
    "access-control-allow-origin",
    "access-control-allow-methods",
    "access-control-allow-headers",
    "access-control-allow-credentials",
    "access-control-max-age",
    "vary"
  ];
  const gathered = {};

  for (const name of names) {
    const value = headers.get(name);

    if (value) {
      gathered[name] = value;
    }
  }

  return gathered;
}

function gatherMcpDetectionEvidence(endpointResults, toolAttempts, tools) {
  const evidence = [];

  for (const attempt of toolAttempts) {
    if (hasInitializeResult(attempt.initialize?.bodySnippet)) {
      evidence.push(`${attempt.transport}: initialize result`);
    }

    if (hasStreamableSession(attempt.initialize)) {
      evidence.push(`${attempt.transport}: session initialized`);
    }

    if (hasProtocolMetadata(attempt.initialize?.bodySnippet)) {
      evidence.push(`${attempt.transport}: protocol metadata`);
    }

    if (hasAuthenticatedContextSignal(attempt.initialize?.bodySnippet)) {
      evidence.push(`${attempt.transport}: authenticated context exposed`);
    }

    if (hasToolsListResult(attempt.toolsList?.bodySnippet) || attempt.tools.length > 0) {
      evidence.push(`${attempt.transport}: tools/list result`);
    }

    if (hasJsonRpcError(attempt.initialize?.bodySnippet) || hasJsonRpcError(attempt.initialized?.bodySnippet) || hasJsonRpcError(attempt.toolsList?.bodySnippet)) {
      evidence.push(`${attempt.transport}: JSON-RPC error response`);
    }

    if (isAuthRequiredResponse(attempt.initialized) || isAuthRequiredResponse(attempt.toolsList)) {
      evidence.push(`${attempt.transport}: tool access blocked by auth`);
    }

    if (attempt.transport === "legacy-sse" && hasLegacyEndpointEvent(attempt.sseOpen?.bodySnippet)) {
      evidence.push("legacy-sse: endpoint event");
    }

    if (attempt.transport === "legacy-sse" && attempt.messageEndpoint && hasInitializeResult(attempt.initialize?.bodySnippet)) {
      evidence.push("legacy-sse: message endpoint initialize result");
    }
  }

  if (tools.length > 0) {
    evidence.push("tool names exposed");
  }

  for (const endpoint of endpointResults) {
    if (hasProtocolMetadata(endpoint.bodySnippet)) {
      evidence.push(`${endpoint.path}: protocol metadata`);
    }

    if (endpoint.streamableHttpPostRequired) {
      evidence.push(`${endpoint.path}: streamable HTTP POST required`);
    }
  }

  return [...new Set(evidence)];
}

function buildMcpFingerprint(rootResult, endpointResults, toolAttempts, tools) {
  const bestAttempt = selectBestAttempt(toolAttempts);
  const initializePayload = firstJsonPayload(bestAttempt?.initialize?.bodySnippet);
  const result = initializePayload?.result || {};
  const matchedEndpoints = endpointResults
    .filter((endpoint) => endpoint.sseDetected || endpoint.jsonRpcDetected || endpoint.mcpKeywordDetected)
    .map((endpoint) => endpoint.path);
  const sessionId = bestAttempt?.initialize?.sessionId || bestAttempt?.toolsList?.sessionId || null;
  const authHints = gatherAuthHints(endpointResults, toolAttempts);
  const rpcErrors = gatherJsonRpcErrors(toolAttempts);
  const authenticatedContext = hasAuthenticatedContextSignal(bestAttempt?.initialize?.bodySnippet);

  return {
    transport: bestAttempt?.transport || inferTransport(endpointResults),
    endpoint: bestAttempt?.messageEndpoint || bestAttempt?.url || rootResult.url,
    matchedEndpoints,
    protocolVersion: typeof result.protocolVersion === "string"
      ? result.protocolVersion
      : extractProtocolVersion(bestAttempt?.initialize?.bodySnippet) || bestAttempt?.negotiatedVersion || null,
    serverName: typeof result.serverInfo?.name === "string" ? result.serverInfo.name : null,
    serverVersion: typeof result.serverInfo?.version === "string" ? result.serverInfo.version : null,
    capabilities: result.capabilities && typeof result.capabilities === "object" ? Object.keys(result.capabilities) : [],
    session: {
      supported: Boolean(sessionId),
      id: sessionId
    },
    tools: {
      count: tools.length,
      names: tools.map((tool) => tool.name)
    },
    auth: {
      required: authHints.required,
      evidence: authHints.evidence
    },
    exposure: {
      authenticatedContext,
      evidence: authenticatedContext ? ["initialize instructions disclose an authenticated user context"] : []
    },
    errors: {
      jsonRpc: rpcErrors
    }
  };
}

function selectBestAttempt(toolAttempts) {
  return [...toolAttempts].sort((a, b) => scoreAttempt(b) - scoreAttempt(a))[0] || null;
}

function scoreAttempt(attempt) {
  if (!attempt) {
    return 0;
  }

  return [
    attempt.tools?.length ? 8 : 0,
    hasToolsListResult(attempt.toolsList?.bodySnippet) ? 6 : 0,
    hasStreamableSession(attempt.initialize) ? 5 : 0,
    hasInitializeResult(attempt.initialize?.bodySnippet) ? 4 : 0,
    attempt.transport === "streamable-http" ? 2 : 0,
    attempt.transport === "legacy-sse" ? 1 : 0
  ].reduce((sum, value) => sum + value, 0);
}

function firstJsonPayload(bodySnippet) {
  return parseJsonPayloads(bodySnippet)[0] || null;
}

function inferTransport(endpointResults) {
  if (endpointResults.some((endpoint) => endpoint.sseDetected)) {
    return "sse-signal";
  }

  if (endpointResults.some((endpoint) => endpoint.jsonRpcDetected)) {
    return "json-rpc-signal";
  }

  return "unknown";
}

function gatherAuthHints(endpointResults, toolAttempts) {
  const evidence = [];

  for (const endpoint of endpointResults) {
    if (endpoint.status === 401 || endpoint.status === 403) {
      evidence.push(`${endpoint.path} returned HTTP ${endpoint.status}`);
    }
  }

  for (const attempt of toolAttempts) {
    for (const [label, response] of [["initialize", attempt.initialize], ["tools/list", attempt.toolsList]]) {
      if (isAuthRequiredResponse(response)) {
        const message = extractAuthMessage(response.bodySnippet);
        evidence.push(`${attempt.transport} ${label} returned HTTP ${response.status}${message ? `: ${message}` : ""}`);
      }
    }
  }

  return {
    required: evidence.length > 0,
    evidence
  };
}

function isAuthRequiredResponse(response) {
  if (!response) {
    return false;
  }

  if (hasToolsListResult(response.bodySnippet)) {
    return false;
  }

  if (response.status === 401 || response.status === 403) {
    return true;
  }

  if (isSuccessfulHttp(response.status)) {
    return false;
  }

  return hasAuthRequiredSignal(response.bodySnippet);
}

function hasAuthRequiredSignal(bodySnippet) {
  return Boolean(bodySnippet &&
    /missing .*?(private-token|job_token|authorization)|remote authorization is enabled|unauthorized|forbidden|authentication required/i.test(bodySnippet));
}

function extractAuthMessage(bodySnippet) {
  const payload = firstJsonPayload(bodySnippet);
  const message = payload?.message || payload?.error?.message || payload?.error;

  if (typeof message === "string") {
    return message;
  }

  if (hasAuthRequiredSignal(bodySnippet)) {
    return normalizeSnippet(bodySnippet).slice(0, 180);
  }

  return "";
}

function hasInitializeResult(bodySnippet) {
  return parseJsonPayloads(bodySnippet).some((parsed) => parsed?.jsonrpc === "2.0" &&
    parsed?.result &&
    (typeof parsed.result.protocolVersion === "string" ||
      Boolean(parsed.result.capabilities) ||
      Boolean(parsed.result.serverInfo)));
}

function hasStreamableSession(response) {
  return Boolean(response?.sessionId && isSuccessfulHttp(response.status));
}

function hasProtocolMetadata(bodySnippet) {
  return parseJsonPayloads(bodySnippet).some((parsed) => Boolean(parsed?.result?.protocolVersion) ||
    Boolean(parsed?.result?.serverInfo) ||
    Boolean(parsed?.result?.capabilities));
}

function hasToolsListResult(bodySnippet) {
  return parseJsonPayloads(bodySnippet).some((parsed) => parsed?.jsonrpc === "2.0" &&
    Array.isArray(parsed?.result?.tools));
}

function hasAuthenticatedContextSignal(bodySnippet) {
  return parseJsonPayloads(bodySnippet).some((parsed) => {
    const instructions = parsed?.result?.instructions;

    return typeof instructions === "string" &&
      /authenticated user|using authenticated|logged in as|current user|authorized user/i.test(instructions);
  });
}

function hasJsonRpcError(bodySnippet) {
  return parseJsonPayloads(bodySnippet).some((parsed) => parsed?.jsonrpc === "2.0" && parsed?.error);
}

function gatherJsonRpcErrors(toolAttempts) {
  const errors = [];

  for (const attempt of toolAttempts) {
    for (const [stage, response] of [["initialize", attempt.initialize], ["initialized", attempt.initialized], ["tools/list", attempt.toolsList]]) {
      for (const parsed of parseJsonPayloads(response?.bodySnippet)) {
        if (parsed?.jsonrpc !== "2.0" || !parsed.error) {
          continue;
        }

        errors.push({
          transport: attempt.transport,
          stage,
          status: response?.status ?? null,
          code: typeof parsed.error.code === "number" ? parsed.error.code : null,
          message: typeof parsed.error.message === "string" ? parsed.error.message : "JSON-RPC error"
        });
      }
    }
  }

  return errors;
}

function hasLegacyEndpointEvent(bodySnippet) {
  return Boolean(bodySnippet && /event:\s*endpoint/i.test(bodySnippet));
}

function isSuccessfulHttp(status) {
  return Number.isInteger(status) && status >= 200 && status < 400;
}

function responseContainsHostEvidence(bodySnippet, headers) {
  const echoedHost = headers.get("x-observed-host");

  if (echoedHost === ATTACKER_HOST || echoedHost?.startsWith(`${ATTACKER_HOST}:`)) {
    return true;
  }

  if (!bodySnippet) {
    return false;
  }

  try {
    const parsed = JSON.parse(bodySnippet);
    const host = String(parsed.host || parsed.headers?.host || "");
    return host === ATTACKER_HOST || host.startsWith(`${ATTACKER_HOST}:`);
  } catch {
    return bodySnippet.includes(`\"host\":\"${ATTACKER_HOST}\"`) ||
      bodySnippet.includes(`\"host\":\"${ATTACKER_HOST}:`);
  }
}

function responseContainsOriginEvidence(bodySnippet, headers) {
  if (headers.get("x-observed-origin") === ATTACKER_ORIGIN) {
    return true;
  }

  if (!bodySnippet) {
    return false;
  }

  try {
    const parsed = JSON.parse(bodySnippet);
    return parsed.origin === ATTACKER_ORIGIN || parsed.headers?.origin === ATTACKER_ORIGIN;
  } catch {
    return bodySnippet.includes(`\"origin\":\"${ATTACKER_ORIGIN}\"`);
  }
}

function isMcpCandidateEndpoint(endpoint) {
  return endpoint.state === "responsive" &&
    (endpoint.sseDetected ||
      endpoint.jsonRpcDetected ||
      endpoint.mcpKeywordDetected ||
      endpoint.streamableHttpPostRequired ||
      endpoint.path === "/" ||
      endpoint.path === "/mcp");
}

function isSseResponse(contentType, bodySnippet) {
  return Boolean(contentType?.includes("text/event-stream") || bodySnippet?.toLowerCase().includes("event:"));
}

function hasJsonRpcSignal(bodySnippet) {
  if (!bodySnippet) {
    return false;
  }

  return parseJsonPayloads(bodySnippet).some((parsed) => parsed?.jsonrpc === "2.0" ||
    Boolean(parsed?.result) ||
    Boolean(parsed?.error)) ||
    bodySnippet.includes("\"jsonrpc\"") ||
    bodySnippet.includes("\"result\"") ||
    bodySnippet.includes("\"error\"");
}

function hasMcpKeywordSignal(bodySnippet) {
  return Boolean(bodySnippet && /\bmcp\b|tools\/list|initialize|protocolVersion|text\/event-stream/i.test(bodySnippet));
}

function hasStreamableHttpPostRequired(bodySnippet) {
  return Boolean(bodySnippet &&
    /method not allowed/i.test(bodySnippet) &&
    /streamable_http|streamable http/i.test(bodySnippet) &&
    /use post|post to communicate|post request/i.test(bodySnippet));
}

function parseJsonPayloads(bodySnippet) {
  const payloads = [];
  const direct = tryParseJson(bodySnippet);

  if (direct) {
    payloads.push(direct);
  }

  for (const data of extractSseDataPayloads(bodySnippet)) {
    const parsed = tryParseJson(data);

    if (parsed) {
      payloads.push(parsed);
    }
  }

  return payloads;
}

function tryParseJson(value) {
  try {
    return JSON.parse(value);
  } catch {
    return null;
  }
}

function extractSseDataPayloads(bodySnippet) {
  if (!bodySnippet) {
    return [];
  }

  const normalized = bodySnippet.replace(/\r\n/g, "\n");
  const events = normalized.split(/\n\n+/);
  const payloads = [];

  for (const event of events) {
    const dataLines = event
      .split("\n")
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).trimStart());

    if (dataLines.length > 0) {
      payloads.push(dataLines.join("\n"));
    }
  }

  const inlineMatches = normalized.matchAll(/data:\s*({.*?})(?=\s*(?:event:|id:|data:|$))/g);

  for (const match of inlineMatches) {
    payloads.push(match[1]);
  }

  return payloads;
}

function extractLegacyMessageEndpoint(bodySnippet, baseUrl) {
  const normalized = bodySnippet.replace(/\r\n/g, "\n");
  const events = normalized.split(/\n\n+/);

  for (const event of events) {
    if (!event.includes("event: endpoint") && !event.includes("event:endpoint")) {
      continue;
    }

    const dataLine = event.split("\n").find((line) => line.startsWith("data:"));

    if (!dataLine) {
      continue;
    }

    return new URL(dataLine.slice(5).trim(), baseUrl).toString();
  }

  const inlineEndpoint = normalized.match(/event:\s*endpoint\s+data:\s*([^\s]+)/);
  return inlineEndpoint ? new URL(inlineEndpoint[1], baseUrl).toString() : null;
}

function buildInitializeRequest(protocolVersion) {
  return {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion,
      capabilities: {},
      clientInfo: {
        name: "mcp_binder",
        version: "0.1.0"
      }
    }
  };
}

function extractProtocolVersion(bodySnippet) {
  for (const parsed of parseJsonPayloads(bodySnippet)) {
    const protocolVersion = parsed?.result?.protocolVersion;

    if (typeof protocolVersion === "string") {
      return protocolVersion;
    }
  }

  return null;
}

function buildSessionHeaders(initialize, protocolVersion) {
  const headers = buildProtocolHeaders(protocolVersion || MCP_PROTOCOL_VERSION);

  if (initialize?.sessionId) {
    headers["Mcp-Session-Id"] = initialize.sessionId;
  }

  return headers;
}

function buildProtocolHeaders(protocolVersion) {
  return {
    "MCP-Protocol-Version": protocolVersion
  };
}

function extractTools(bodySnippet) {
  if (!bodySnippet) {
    return [];
  }

  for (const parsed of parseJsonPayloads(bodySnippet)) {
    const tools = parsed?.result?.tools;

    if (!Array.isArray(tools)) {
      continue;
    }

    return tools
      .filter((tool) => tool && typeof tool.name === "string")
      .map((tool) => ({
        name: tool.name,
        description: typeof tool.description === "string" ? tool.description : ""
      }));
  }

  return [];
}

function dedupeTools(tools) {
  const seen = new Set();
  const unique = [];

  for (const tool of tools) {
    if (seen.has(tool.name)) {
      continue;
    }

    seen.add(tool.name);
    unique.push(tool);
  }

  return unique;
}

function classifyConfidence(result) {
  if (result.toolListingDetected || result.fingerprint?.exposure?.authenticatedContext) {
    return "high";
  }

  if (result.fingerprint?.errors?.jsonRpc?.length) {
    return "medium";
  }

  if (result.jsonRpcDetected || result.sseDetected) {
    return "medium";
  }

  if (result.mcpDetected) {
    return "low";
  }

  return "unknown";
}

function classifySeverity(result) {
  if (result.toolListingDetected || result.tools?.length > 0 || result.fingerprint?.exposure?.authenticatedContext) {
    return "high";
  }

  if (result.fingerprint?.auth?.required) {
    return "medium";
  }

  if (result.fingerprint?.errors?.jsonRpc?.length) {
    return "medium";
  }

  if (result.headerValidation?.result === "likely_vulnerable" || result.headerValidation?.result === "weak_signal") {
    return "medium";
  }

  return "informational";
}

function describeEndpointSignal(endpoint) {
  if (endpoint.sseDetected) {
    return "SSE endpoint detected.";
  }

  if (endpoint.jsonRpcDetected) {
    return "JSON-RPC response detected.";
  }

  if (endpoint.mcpKeywordDetected) {
    return "MCP keyword signal detected.";
  }

  return `HTTP service responded in ${endpoint.elapsedMs}ms.`;
}
