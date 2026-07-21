import { MessageType } from "../src/messages.js";
import { formatScanStage } from "../src/reporting-labels.js";
import { buildCustomUrlDescriptor, buildSingularityDescriptor } from "../src/rebind-url.js";
import { attachSnapBackInteractions } from "./interactions.js";
import { labSettingsFromRuntimeConfig, loadRuntimeConfig } from "../src/runtime-config.js";
import { scanTargetPermissionCandidates, validateScanTargetAccess } from "../src/scanner.js";

const form = document.querySelector("#scanForm");
const scanButton = document.querySelector("#scanButton");
const cancelButton = document.querySelector("#cancelButton");
const exportButton = document.querySelector("#exportButton");
const sortSelect = document.querySelector("#sortSelect");
const statusBadge = document.querySelector("#statusBadge");
const stageValue = document.querySelector("#stageValue");
const scannedValue = document.querySelector("#scannedValue");
const responsiveValue = document.querySelector("#responsiveValue");
const mcpValue = document.querySelector("#mcpValue");
const findingsValue = document.querySelector("#findingsValue");
const authValue = document.querySelector("#authValue");
const findingsList = document.querySelector("#findingsList");
const detailPanel = document.querySelector("#detailPanel");
const rebindStatus = document.querySelector("#rebindStatus");
const labDomainValue = document.querySelector("#labDomainValue");
const vmIpValue = document.querySelector("#vmIpValue");
const toggleVmIpButton = document.querySelector("#toggleVmIpButton");
const vmIpEyeIcon = document.querySelector("#vmIpEyeIcon");
const dashboardBaseValue = document.querySelector("#dashboardBaseValue");
const openDashboardButton = document.querySelector("#openDashboardButton");
const stopRebindButton = document.querySelector("#stopRebindButton");
const activityPanel = document.querySelector("#activityPanel");
const activityDragHandle = document.querySelector(".activityDragHandle");
const activityResizeHandle = document.querySelector(".activityResizeHandle");
const activityTitle = document.querySelector("#activityTitle");
const activityState = document.querySelector("#activityState");
const activityMeterFill = document.querySelector("#activityMeterFill");
const activityDetail = document.querySelector("#activityDetail");
const activityTimeline = document.querySelector("#activityTimeline");

let lastResult = null;
let selectedFindingKey = null;
let lastLaunch = null;
let activeBridge = null;
let runtimeConfig = null;
let activityItems = [];
let operatorNoticeTimer = null;
let bridgeRunNonce = 0;
let activityPanelDrag = null;
let activityPanelResize = null;
let snapBackInteractions = null;
let vmIpVisible = false;
const dashboardStateKeys = ["dashboardLastResult", "dashboardSelectedFindingKey", "dashboardActiveBridge"];
const ACTIVITY_MIN_WIDTH = 280;
const ACTIVITY_MIN_HEIGHT = 185;
const OPEN_EYE_ICON = `
  <svg class="eyeIconSvg open" viewBox="0 0 24 24" focusable="false">
    <path class="eyeIconLine" d="M2.5 12s3.7-5.6 9.5-5.6S21.5 12 21.5 12s-3.7 5.6-9.5 5.6S2.5 12 2.5 12Z"/>
    <circle class="eyeIconPupil" cx="12" cy="12" r="2.4"/>
  </svg>
`;
const CLOSED_EYE_ICON = `
  <svg class="eyeIconSvg closed" viewBox="0 0 24 24" focusable="false">
    <path class="eyeIconLine" d="M3.2 9.3c2.2 3.4 5.1 5.1 8.8 5.1s6.6-1.7 8.8-5.1"/>
    <path class="eyeIconLine" d="M7 14.2 5.7 17"/>
    <path class="eyeIconLine" d="M12 15.1v3"/>
    <path class="eyeIconLine" d="m17 14.2 1.3 2.8"/>
  </svg>
`;

chrome.runtime.onMessage.addListener((message) => {
  if (message?.type === MessageType.ScanProgress) {
    renderScanProgress(message.payload || {});
  }

  if (message?.type === MessageType.RebindBridgeLog) {
    renderRebindProgress(message.payload || {});
  }
});

form.addEventListener("submit", async (event) => {
  event.preventDefault();

  const formData = new FormData(form);
  const payload = {
    target: String(formData.get("target") || "localtest.me").trim(),
    ports: String(formData.get("ports") || "8000-9000").trim()
  };

  try {
    payload.allowedHostPermissions = await currentHostPermissionsForTarget(payload.target);
    payload.target = validateScanTargetAccess(payload.target, {
      allowedHostPermissions: payload.allowedHostPermissions
    }).target;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (error?.name === "ScanTargetAccessError") {
      renderBlockedScan(error);
    } else {
      renderError(new Error(message));
    }
    setStatus("Blocked", "error");
    resetActivity("Scan blocked", "error", message, 100);
    return;
  }

  setStatus("Running", "running");
  resetActivity("Scanning", "running", "Preparing local port scan.", 0);
  scanButton.disabled = true;
  cancelButton.disabled = false;
  exportButton.disabled = true;

  try {
    const response = await chrome.runtime.sendMessage({
      type: MessageType.StartScan,
      payload
    });

    if (response?.type === MessageType.ScanCancelled) {
      setStatus("Cancelled", "idle");
      updateActivity({
        title: "Scan cancelled",
        state: "idle",
        detail: "The scan was cancelled.",
        percent: 100,
        item: "Scan cancelled by operator."
      });
      return;
    }

    if (!response || response.type !== MessageType.ScanResult) {
      throw new Error(response?.error || "Background worker returned an unexpected response.");
    }

    lastResult = response.payload;
    selectedFindingKey = firstFindingKey(lastResult.findings);
    renderResult();
    await persistDashboardState();
    setStatus("Done", "done");
    updateActivity({
      title: "Scan complete",
      state: "done",
      detail: `${lastResult.summary.scanned} ports scanned, ${lastResult.summary.findings} findings.`,
      percent: 100,
      item: `Scan complete: ${lastResult.summary.responsive} responsive, ${lastResult.summary.mcpDetected} MCP, ${lastResult.summary.findings} findings.`
    });
  } catch (error) {
    renderError(error);
    setStatus("Error", "error");
    updateActivity({
      title: "Scan error",
      state: "error",
      detail: error instanceof Error ? error.message : String(error),
      percent: 100,
      item: `Scan error: ${error instanceof Error ? error.message : String(error)}`
    });
  } finally {
    scanButton.disabled = false;
    cancelButton.disabled = true;
    exportButton.disabled = !lastResult;
  }
});

cancelButton.addEventListener("click", async () => {
  cancelButton.disabled = true;
  await chrome.runtime.sendMessage({
    type: MessageType.CancelScan
  });
});

sortSelect.addEventListener("change", () => {
  selectedFindingKey = firstFindingKey(filteredFindings());
  renderFindings();
  persistDashboardState();
});

exportButton.addEventListener("click", () => {
  if (!lastResult) {
    return;
  }

  const blob = new Blob([JSON.stringify(lastResult, null, 2)], {
    type: "application/json"
  });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  anchor.href = url;
  anchor.download = `mcp-scan-${timestamp}.json`;
  anchor.click();
  URL.revokeObjectURL(url);
});

openDashboardButton.addEventListener("click", openDashboardDashboard);
stopRebindButton.addEventListener("click", stopRebindBridge);
statusBadge.addEventListener("click", highlightActivityPanel);
toggleVmIpButton.addEventListener("click", toggleVmIpVisibility);
enableActivityPanelDrag();
enableActivityPanelResize();
enableSnapBackInteractions();

async function startRebindForSelectedFinding() {
  const finding = selectedFinding();

  if (!finding) {
    return;
  }

  return startRebindForFinding(finding);
}

async function startRebindForFinding(finding, options = {}) {
  if (activeBridge) {
    if (!options.replaceConfirmed && !await confirmReplaceBridge(activeBridge, finding)) {
      showActiveBridgeNotice(activeBridge);
      renderRebindControls();
      return;
    }
    return replaceActiveBridgeWithFinding(finding);
  }

  try {
    const runNonce = ++bridgeRunNonce;
    lastLaunch = buildProviderDescriptor(finding);
    activeBridge = {
      descriptor: lastLaunch,
      mcpName: findingTitle(finding),
      clientRunId: runNonce
    };
    const previousActivity = snapshotActivity();
    rebindStatus.textContent = "Rebinding running";
    setStatus("Rebinding", "running");
    resetActivity("DNS Rebind", "running", `Starting bridge for ${lastLaunch.host}:${lastLaunch.port}${lastLaunch.path}.`, 0);
    appendActivity(`Internal target: ${lastLaunch.host}:${lastLaunch.port}${lastLaunch.path}`);
    renderRebindControls();

    const response = await chrome.runtime.sendMessage({
      type: MessageType.StartRebindBridge,
      payload: {
        finding,
        descriptor: lastLaunch,
        mcpName: findingTitle(finding),
        clientRunId: runNonce
      }
    });

    if (runNonce !== bridgeRunNonce) {
      return;
    }

    if (response?.type === MessageType.RebindBridgeAlreadyRunning) {
      activeBridge = response.payload || {};
      setStatus("Bridge busy", "running");
      restoreActivity(previousActivity);
      if (await confirmReplaceBridge(activeBridge, finding)) {
        return replaceActiveBridgeWithFinding(finding);
      }
      showActiveBridgeNotice(activeBridge);
      renderRebindControls();
      return;
    }

    if (!response || response.type !== MessageType.RebindBridgeResult) {
      throw new Error(response?.error || "Bridge returned an unexpected response.");
    }

    activeBridge = response.payload.proof?.result === "rebind_confirmed" ? {
      sessionId: response.payload.session?.id,
      descriptor: lastLaunch,
      mcpName: findingTitle(finding),
      clientRunId: runNonce
    } : null;
    clearRebindSessionsExcept(activeBridge ? finding : null);
    finding.rebindProof = {
      ...finding.rebindProof,
      ...response.payload.proof,
      campaignId: lastLaunch.campaignId,
      origin: originForProof(response.payload.proof, lastLaunch),
      targetPort: lastLaunch.port,
      transport: lastLaunch.transport,
      path: pathForProof(response.payload.proof, lastLaunch),
      hostname: hostnameForProof(response.payload.proof, lastLaunch)
    };
    finding.rebindSession = activeBridge ? response.payload.session || finding.rebindSession : null;
    const proofResult = response.payload.proof?.result || "inconclusive";
    setStatus(proofResult === "stopped" ? "Rebinding stopped" : "Rebinding complete", proofResult === "stopped" ? "idle" : "done");
    updateActivity({
      title: proofResult === "stopped" ? "DNS Rebind stopped" : "DNS Rebind complete",
      state: proofResult === "rebind_confirmed" ? "done" : proofResult === "stopped" ? "idle" : "error",
      detail: rebindProofLabel(proofResult),
      percent: 100,
      item: proofResult === "stopped" ? "Rebinding stopped by operator." : `Rebinding finished: ${rebindProofLabel(proofResult)}.`
    });
    renderResult();
    await persistDashboardState();
  } catch (error) {
    activeBridge = null;
    setStatus("Rebinding error", "error");
    rebindStatus.textContent = error instanceof Error ? error.message : String(error);
    updateActivity({
      title: "DNS Rebind error",
      state: "error",
      detail: rebindStatus.textContent,
      percent: 100,
      item: `Rebinding error: ${rebindStatus.textContent}`
    });
    renderRebindControls();
    persistDashboardState();
  }
}

async function replaceActiveBridgeWithFinding(finding) {
  await stopRebindBridge({ quiet: true });
  activeBridge = null;
  setStatus("Replacing rebind", "running");
  resetActivity("DNS Rebind", "running", `Starting replacement for ${findingTitle(finding)}.`, 0);
  return startRebindForFinding(finding, { replaceConfirmed: true });
}

async function stopRebindBridge(options = {}) {
  try {
    bridgeRunNonce += 1;
    await chrome.runtime.sendMessage({
      type: MessageType.StopRebindBridge
    });
    activeBridge = null;
    clearRebindSessionsExcept(null);
    setStatus("Rebinding stopped", "idle");
    rebindStatus.textContent = "Rebinding stopped";
    if (!options.quiet) {
      updateActivity({
        title: "DNS Rebind stopped",
        state: "idle",
        detail: "The active DNS rebind bridge was stopped.",
        percent: 100,
        item: "Rebinding stopped by operator."
      });
    }
    renderRebindControls();
    await persistDashboardState();
  } catch (error) {
    setStatus("Stop error", "error");
    rebindStatus.textContent = error instanceof Error ? error.message : String(error);
    updateActivity({
      title: "Stop error",
      state: "error",
      detail: rebindStatus.textContent,
      percent: 100,
      item: `Stop error: ${rebindStatus.textContent}`
    });
  }
}

function confirmReplaceBridge(bridge, nextFinding) {
  const current = activeBridgeMcpName(bridge) || activeBridgeTarget(bridge) || "current MCP attack";
  const next = findingTitle(nextFinding);
  return showDecisionDialog({
    title: "DNS rebind already running",
    body: "Stop the current bridge and start the selected attack?",
    current,
    next,
    confirmLabel: "Stop and Start",
    cancelLabel: "Keep Current"
  });
}

function showDecisionDialog(options = {}) {
  return new Promise((resolve) => {
    const existing = document.querySelector("#operatorDialogOverlay");
    existing?.remove();

    const overlay = document.createElement("div");
    overlay.id = "operatorDialogOverlay";
    overlay.className = "operatorDialogOverlay";

    const dialog = document.createElement("section");
    dialog.className = "operatorDialog";
    dialog.setAttribute("role", "dialog");
    dialog.setAttribute("aria-modal", "true");
    dialog.setAttribute("aria-labelledby", "operatorDialogTitle");

    const eyebrow = document.createElement("p");
    eyebrow.className = "eyebrow";
    eyebrow.textContent = "Confirm";

    const title = document.createElement("h2");
    title.id = "operatorDialogTitle";
    title.textContent = options.title || "Confirm action";

    const body = document.createElement("p");
    body.className = "operatorDialogBody";
    body.textContent = options.body || "";

    const facts = document.createElement("dl");
    facts.className = "operatorDialogFacts";
    appendDialogFact(facts, "Current", options.current);
    appendDialogFact(facts, "New", options.next);

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
      if (event.key === "Escape") {
        finish(false);
      }
    }

    cancel.addEventListener("click", () => finish(false));
    confirm.addEventListener("click", () => finish(true));
    overlay.addEventListener("click", (event) => {
      if (event.target === overlay) {
        finish(false);
      }
    });
    document.addEventListener("keydown", onKeydown);

    actions.append(cancel, confirm);
    dialog.append(eyebrow, title, body, facts, actions);
    overlay.append(dialog);
    document.body.append(overlay);
    cancel.focus();
  });
}

function appendDialogFact(parent, label, value) {
  const wrapper = document.createElement("div");
  const term = document.createElement("dt");
  const description = document.createElement("dd");

  term.textContent = label;
  description.textContent = value || "-";
  wrapper.append(term, description);
  parent.append(wrapper);
}

async function openDashboardDashboard() {
  const url = dashboardDashboardUrl();
  if (!url) {
    showOperatorNotice("Dashboard not configured", "Pack the extension with a dashboard URL.", "error");
    return;
  }

  await chrome.tabs.create({
    active: true,
    url
  });
}

async function openDashboardForFinding(finding) {
  const sessionId = activeBridgeSessionId(finding);
  const base = dashboardDashboardUrl();
  if (!base || !sessionId) {
    return;
  }

  const url = new URL("/ops", base.replace(/\/+$/, ""));
  url.searchParams.set("session", sessionId);

  await chrome.tabs.create({
    active: true,
    url: url.toString()
  });
}

function renderResult() {
  const result = lastResult;
  stageValue.textContent = formatScanStage(result.stage);
  scannedValue.textContent = String(result.summary?.scanned ?? "-");
  responsiveValue.textContent = String(result.summary?.responsive ?? "-");
  mcpValue.textContent = String(result.summary?.mcpDetected ?? "-");
  findingsValue.textContent = String(result.summary?.findings ?? "-");
  authValue.textContent = String(result.summary?.authRequired ?? "-");
  exportButton.disabled = false;
  renderFindings();
}

function renderFindings() {
  const findings = filteredFindings();
  findingsList.classList.remove("empty");
  findingsList.textContent = "";

  if (!findings.length) {
    findingsList.classList.add("empty");
    findingsList.textContent = lastResult?.findings?.length ? "No findings match the selected filter." : "No confirmed MCP services detected.";
    renderDetail(null);
    renderRebindControls();
    return;
  }

  if (!findings.some((finding) => findingKey(finding) === selectedFindingKey)) {
    selectedFindingKey = firstFindingKey(findings);
  }

  for (const finding of findings) {
    const item = document.createElement("div");
    item.className = "finding";
    item.tabIndex = 0;

    if (findingKey(finding) === selectedFindingKey) {
      item.classList.add("selected");
    }

    const header = document.createElement("div");
    header.className = "findingHeader";

    const title = document.createElement("strong");
    title.textContent = findingTitle(finding);

    const port = document.createElement("span");
    port.className = "port";
    port.textContent = `:${finding.port}`;

    header.append(title, port);
    item.append(header);

    const verdict = document.createElement("div");
    verdict.className = `verdict ${verdictClass(finding)}`;
    verdict.textContent = verdictLabel(finding);
    item.append(verdict);

    const meta = document.createElement("p");
    meta.className = "endpoint";
    meta.textContent = finding.fingerprint?.endpoint || finding.baseUrl || `${finding.target}:${finding.port}`;
    item.append(meta);

    const actions = document.createElement("div");
    actions.className = "findingActions";

    const rebindButton = document.createElement("button");
    rebindButton.type = "button";
    rebindButton.className = "miniAction";
    rebindButton.textContent = "DNS Rebind";
    rebindButton.addEventListener("click", (event) => {
      event.stopPropagation();
      selectedFindingKey = findingKey(finding);
      renderFindings();
      persistDashboardState();
      startRebindForSelectedFinding();
    });
    actions.append(rebindButton);

    if (isFindingActiveRebind(finding)) {
      const dashboardButton = document.createElement("button");
      dashboardButton.type = "button";
      dashboardButton.className = "miniAction secondaryMini";
      dashboardButton.textContent = "Open Dashboard";
      dashboardButton.addEventListener("click", (event) => {
        event.stopPropagation();
        selectedFindingKey = findingKey(finding);
        renderFindings();
        persistDashboardState();
        openDashboardForFinding(finding);
      });
      actions.append(dashboardButton);
    }
    item.append(actions);

    item.addEventListener("click", () => {
      selectedFindingKey = findingKey(finding);
      renderFindings();
      persistDashboardState();
    });
    item.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" && event.key !== " ") {
        return;
      }
      event.preventDefault();
      selectedFindingKey = findingKey(finding);
      renderFindings();
      persistDashboardState();
    });

    findingsList.append(item);
  }

  renderDetail(findings.find((finding) => findingKey(finding) === selectedFindingKey));
  renderRebindControls();
  snapBackInteractions?.refresh(findingsList);
}

function renderDetail(finding) {
  detailPanel.classList.toggle("empty", !finding);
  detailPanel.textContent = "";

  if (!finding) {
    detailPanel.textContent = "Select a finding to inspect raw evidence.";
    return;
  }

  detailPanel.append(
    section("MCP Target", keyValueRows({
      Server: [finding.fingerprint?.serverName, finding.fingerprint?.serverVersion].filter(Boolean).join(" ") || findingTitle(finding),
      Endpoint: finding.fingerprint?.endpoint || finding.baseUrl,
      Transport: finding.fingerprint?.transport,
      "Protocol version": finding.fingerprint?.protocolVersion,
      Capabilities: finding.fingerprint?.capabilities?.join(", ")
    })),
    section("Tool Exposure", toolExposureContent(finding)),
    section("Rebinding", keyValueRows(rebindSummary(finding))),
    section("Signals", keyValueRows(signalSummary(finding))),
    detailsSection("Raw Evidence", rawJson(finding))
  );
  snapBackInteractions?.refresh(detailPanel);
}

function filteredFindings() {
  const findings = lastResult?.findings || [];
  return sortFindings(findings);
}

function renderError(error) {
  lastResult = null;
  selectedFindingKey = null;
  activeBridge = null;
  stageValue.textContent = "-";
  scannedValue.textContent = "-";
  responsiveValue.textContent = "-";
  mcpValue.textContent = "-";
  findingsValue.textContent = "-";
  authValue.textContent = "-";
  exportButton.disabled = true;
  findingsList.classList.add("empty");
  findingsList.textContent = error instanceof Error ? error.message : String(error);
  renderDetail(null);
  clearPersistedDashboardState();
}

async function currentHostPermissions() {
  try {
    const permissions = await chrome.permissions.getAll();
    return Array.isArray(permissions.origins) ? permissions.origins : [];
  } catch {
    return [];
  }
}

async function currentHostPermissionsForTarget(target) {
  return uniquePermissions([
    ...await currentHostPermissions(),
    ...await grantedTargetHostPermissions(target)
  ]);
}

async function grantedTargetHostPermissions(target) {
  try {
    const { origins } = scanTargetPermissionCandidates(target);
    const granted = [];

    for (const origin of origins) {
      if (await chrome.permissions.contains({ origins: [origin] })) {
        granted.push(origin);
      }
    }

    return granted;
  } catch {
    return [];
  }
}

function uniquePermissions(permissions) {
  return [...new Set(permissions.map(String).filter(Boolean))];
}

function renderBlockedScan(error) {
  lastResult = null;
  selectedFindingKey = null;
  activeBridge = null;
  stageValue.textContent = "-";
  scannedValue.textContent = "-";
  responsiveValue.textContent = "-";
  mcpValue.textContent = "-";
  findingsValue.textContent = "-";
  authValue.textContent = "-";
  exportButton.disabled = true;
  detailPanel.classList.add("empty");
  detailPanel.textContent = "Select a finding to inspect raw evidence.";
  findingsList.classList.add("empty");
  findingsList.textContent = "";

  const card = document.createElement("div");
  card.className = "blockedScan";

  const eyebrow = document.createElement("p");
  eyebrow.className = "eyebrow";
  eyebrow.textContent = "Scan blocked";

  const title = document.createElement("strong");
  title.textContent = error.operatorSummary || "This target is outside the extension scan policy.";

  const body = document.createElement("p");
  body.textContent = `Target: ${error.target || "unknown"}. Chrome only allows this extension to fetch origins declared in its manifest host permissions.`;

  const allowed = document.createElement("div");
  allowed.className = "permissionList";
  for (const permission of error.allowedHostPermissions || []) {
    const item = document.createElement("code");
    item.textContent = permission;
    allowed.append(item);
  }

  const action = document.createElement("p");
  action.className = "blockedAction";
  action.textContent = error.operatorSuggestion
    ? `Did you mean ${error.operatorSuggestion}?`
    : error.operatorAction || "Use an allowed target or rebuild the extension with the required permission.";

  card.append(eyebrow, title, body, allowed, action);
  findingsList.append(card);
  snapBackInteractions?.refresh(findingsList);
  clearPersistedDashboardState();
}

function setStatus(label, state) {
  statusBadge.textContent = label;
  statusBadge.className = `badge statusButton ${state}`;
}

function highlightActivityPanel() {
  activityPanel.classList.remove("highlight");
  void activityPanel.offsetWidth;
  activityPanel.classList.add("highlight");
  activityPanel.focus?.({ preventScroll: true });
}

function toggleVmIpVisibility() {
  vmIpVisible = !vmIpVisible;
  renderVmIpValue();
}

function renderScanProgress(progress) {
  const phase = {
    ports: "Port scan",
    endpoints: "MCP probe",
    headers: "Header probe"
  }[progress.phase] || "Scan";
  const completed = Number(progress.completed || 0);
  const total = Number(progress.total || 0);
  const percent = Number.isFinite(progress.percent) ? progress.percent : total ? Math.round((completed / total) * 100) : 0;
  const detail = total ? `${phase}: ${completed}/${total}` : `${phase}: no targets`;
  const suffix = [
    progress.lastPort ? `port ${progress.lastPort}` : "",
    progress.mcpDetected ? "MCP signal" : "",
    progress.findingDetected ? "finding" : ""
  ].filter(Boolean).join(", ");

  updateActivity({
    title: "Scanning",
    state: "running",
    detail: suffix ? `${detail}, ${suffix}` : detail,
    percent,
    item: suffix ? `${detail}, ${suffix}` : detail
  });
}

function renderRebindProgress(progress) {
  if (progress.clientRunId && Number(progress.clientRunId) !== bridgeRunNonce) {
    return;
  }

  if (!activeBridge && progress.status !== "stopped") {
    return;
  }

  const attempt = Number(progress.attempt || 0);
  const attempts = Number(progress.attempts || 120);
  const status = String(progress.status || "attempt");
  const percent = attempt ? Math.min(99, Math.round((attempt / attempts) * 100)) : 0;
  const debugDetail = bridgeDebugDetail(progress.details);
  const path = progress.path ? ` ${progress.path}` : "";
  const detail = progress.error ? `${status}${path}: ${progress.error}${debugDetail ? ` (${debugDetail})` : ""}` : `${status}${path}`;
  const state = status === "mcp-initialized" ? "done" : status === "stopped" ? "idle" : "running";

  updateActivity({
    title: status === "stopped" ? "DNS Rebind stopped" : "DNS Rebind",
    state,
    detail: attempt ? `Attempt ${attempt}: ${detail}` : detail,
    percent: status === "mcp-initialized" ? 100 : percent,
    item: attempt ? `Attempt ${attempt}: ${detail}` : detail
  });
}

function bridgeDebugDetail(details) {
  if (!details || typeof details !== "object") {
    return "";
  }

  const parts = [];
  if (details.contentType) {
    parts.push(`content-type ${details.contentType}`);
  }
  if (details.bodyPreview) {
    parts.push(`body ${String(details.bodyPreview).slice(0, 120)}`);
  }
  return parts.join("; ");
}

function resetActivity(title, state, detail, percent = 0) {
  activityItems = [];
  updateActivity({
    title,
    state,
    detail,
    percent,
    item: detail
  });
}

function snapshotActivity() {
  return {
    title: activityTitle.textContent,
    state: activityState.textContent,
    detail: activityDetail.textContent,
    className: activityPanel.className,
    percent: activityMeterFill.style.width,
    items: [...activityItems]
  };
}

function restoreActivity(snapshot) {
  if (!snapshot) {
    return;
  }

  activityTitle.textContent = snapshot.title || "Idle";
  activityState.textContent = snapshot.state || "ready";
  activityDetail.textContent = snapshot.detail || "No active scan or DNS rebind attack.";
  activityPanel.className = snapshot.className || "activityPanel idle";
  activityMeterFill.style.width = snapshot.percent || "0%";
  activityItems = [...(snapshot.items || [])];
  activityTimeline.textContent = "";

  for (const item of activityItems) {
    const entry = document.createElement("li");
    entry.textContent = item;
    activityTimeline.append(entry);
  }
}

function updateActivity({ title, state, detail, percent, item }) {
  activityTitle.textContent = title || "Activity";
  activityState.textContent = state || "ready";
  activityDetail.textContent = detail || "";
  const interactiveClasses = [
    activityPanel.classList.contains("dragging") ? "dragging" : "",
    activityPanel.classList.contains("resizing") ? "resizing" : ""
  ].filter(Boolean).join(" ");
  activityPanel.className = `activityPanel ${state || "idle"}${interactiveClasses ? ` ${interactiveClasses}` : ""}`;
  activityMeterFill.style.width = `${clampPercent(percent)}%`;

  if (item) {
    appendActivity(item);
  }
}

function appendActivity(text) {
  const value = String(text || "").trim();
  if (!value) {
    return;
  }

  if (activityItems[0] === value) {
    return;
  }

  activityItems.unshift(value);
  activityItems = activityItems.slice(0, 8);
  activityTimeline.textContent = "";

  for (const item of activityItems) {
    const entry = document.createElement("li");
    entry.textContent = item;
    activityTimeline.append(entry);
  }
}

function enableActivityPanelDrag() {
  if (!activityDragHandle) {
    return;
  }

  activityDragHandle.addEventListener("pointerdown", startActivityPanelDrag);
  activityDragHandle.addEventListener("keydown", resetActivityPanelPosition);
}

function enableActivityPanelResize() {
  if (!activityResizeHandle) {
    return;
  }

  activityResizeHandle.addEventListener("pointerdown", startActivityPanelResize);
}

function startActivityPanelDrag(event) {
  if (event.button !== 0) {
    return;
  }

  event.preventDefault();
  const rect = activityPanel.getBoundingClientRect();
  activityPanelDrag = {
    offsetX: event.clientX - rect.left,
    offsetY: event.clientY - rect.top
  };
  activityPanel.classList.add("dragging");
  activityPanel.style.left = `${rect.left}px`;
  activityPanel.style.top = `${rect.top}px`;
  activityPanel.style.right = "auto";
  activityPanel.style.bottom = "auto";
  activityDragHandle.setPointerCapture(event.pointerId);
  activityDragHandle.addEventListener("pointermove", moveActivityPanel);
  activityDragHandle.addEventListener("pointerup", stopActivityPanelDrag);
  activityDragHandle.addEventListener("pointercancel", stopActivityPanelDrag);
}

function moveActivityPanel(event) {
  if (!activityPanelDrag) {
    return;
  }

  const nextLeft = event.clientX - activityPanelDrag.offsetX;
  const nextTop = event.clientY - activityPanelDrag.offsetY;
  activityPanel.style.left = `${nextLeft}px`;
  activityPanel.style.top = `${nextTop}px`;
}

function stopActivityPanelDrag(event) {
  activityPanelDrag = null;
  activityPanel.classList.remove("dragging");
  if (event?.pointerId !== undefined && activityDragHandle.hasPointerCapture(event.pointerId)) {
    activityDragHandle.releasePointerCapture(event.pointerId);
  }
  activityDragHandle.removeEventListener("pointermove", moveActivityPanel);
  activityDragHandle.removeEventListener("pointerup", stopActivityPanelDrag);
  activityDragHandle.removeEventListener("pointercancel", stopActivityPanelDrag);
}

function resetActivityPanelPosition(event) {
  if (event.key !== "Escape") {
    return;
  }

  activityPanel.style.left = "";
  activityPanel.style.top = "";
  activityPanel.style.right = "";
  activityPanel.style.bottom = "";
  activityPanel.style.width = "";
  activityPanel.style.height = "";
  activityPanel.style.maxHeight = "";
}

function startActivityPanelResize(event) {
  if (event.button !== 0) {
    return;
  }

  event.preventDefault();
  event.stopPropagation();
  const rect = activityPanel.getBoundingClientRect();
  activityPanelResize = {
    left: rect.left,
    top: rect.top,
    startX: event.clientX,
    startY: event.clientY,
    startWidth: rect.width,
    startHeight: rect.height
  };
  activityPanel.classList.add("resizing");
  activityPanel.style.left = `${rect.left}px`;
  activityPanel.style.top = `${rect.top}px`;
  activityPanel.style.right = "auto";
  activityPanel.style.bottom = "auto";
  activityPanel.style.width = `${rect.width}px`;
  activityPanel.style.height = `${rect.height}px`;
  activityPanel.style.maxHeight = "none";
  activityResizeHandle.setPointerCapture(event.pointerId);
  activityResizeHandle.addEventListener("pointermove", resizeActivityPanel);
  activityResizeHandle.addEventListener("pointerup", stopActivityPanelResize);
  activityResizeHandle.addEventListener("pointercancel", stopActivityPanelResize);
}

function resizeActivityPanel(event) {
  if (!activityPanelResize) {
    return;
  }

  const nextWidth = Math.max(ACTIVITY_MIN_WIDTH, activityPanelResize.startWidth + event.clientX - activityPanelResize.startX);
  const nextHeight = Math.max(ACTIVITY_MIN_HEIGHT, activityPanelResize.startHeight + event.clientY - activityPanelResize.startY);
  activityPanel.style.width = `${nextWidth}px`;
  activityPanel.style.height = `${nextHeight}px`;
}

function stopActivityPanelResize(event) {
  activityPanelResize = null;
  activityPanel.classList.remove("resizing");
  if (event?.pointerId !== undefined && activityResizeHandle.hasPointerCapture(event.pointerId)) {
    activityResizeHandle.releasePointerCapture(event.pointerId);
  }
  activityResizeHandle.removeEventListener("pointermove", resizeActivityPanel);
  activityResizeHandle.removeEventListener("pointerup", stopActivityPanelResize);
  activityResizeHandle.removeEventListener("pointercancel", stopActivityPanelResize);
}

function enableSnapBackInteractions() {
  snapBackInteractions = attachSnapBackInteractions();
}

function showActiveBridgeNotice(bridge) {
  const target = activeBridgeTarget(bridge);
  const mcpName = activeBridgeMcpName(bridge);
  const session = bridge?.sessionId ? `Session: ${bridge.sessionId}.` : "";
  const detail = [
    mcpName ? `MCP: ${mcpName}.` : "",
    target ? `Current bridge: ${target}.` : "A DNS rebind bridge is already running.",
    session,
    "Stop it before launching another MCP attack."
  ].filter(Boolean).join(" ");

  showOperatorNotice("DNS rebind already running", detail, "running");
}

function showOperatorNotice(title, detail, state = "running") {
  let notice = document.querySelector("#operatorNotice");
  if (!notice) {
    notice = document.createElement("aside");
    notice.id = "operatorNotice";
    notice.className = "operatorNotice";
    notice.setAttribute("role", "status");
    notice.setAttribute("aria-live", "polite");
    document.body.append(notice);
  }

  notice.className = `operatorNotice ${state}`;
  notice.textContent = "";

  const heading = document.createElement("strong");
  heading.textContent = title;

  const body = document.createElement("p");
  body.textContent = detail;

  notice.append(heading, body);
  window.clearTimeout(operatorNoticeTimer);
  operatorNoticeTimer = window.setTimeout(() => {
    notice.remove();
  }, 6500);
}

function activeBridgeTarget(bridge) {
  const descriptor = bridge?.descriptor;
  if (!descriptor) {
    return "";
  }

  const host = descriptor.host || descriptor.hostname || "";
  const port = descriptor.port ? `:${descriptor.port}` : "";
  const path = descriptor.path || "/";

  if (!host) {
    return "";
  }

  return `${host}${port}${path}`;
}

function activeBridgeMcpName(bridge) {
  return String(bridge?.mcpName || bridge?.serverName || "").trim();
}

function clampPercent(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return 0;
  }
  return Math.max(0, Math.min(100, number));
}

function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function firstFindingKey(findings = []) {
  return findings[0] ? findingKey(findings[0]) : null;
}

function findingKey(finding) {
  return `${finding.target}:${finding.port}:${finding.fingerprint?.transport || "unknown"}`;
}

function selectedFinding() {
  const findings = lastResult?.findings || [];
  return findings.find((finding) => findingKey(finding) === selectedFindingKey) || null;
}

function renderRebindControls() {
  const finding = selectedFinding();
  const hasFinding = Boolean(finding);
  const proof = finding?.rebindProof;
  const bridgeRunning = Boolean(activeBridge);

  stopRebindButton.disabled = !bridgeRunning;

  if (bridgeRunning) {
    const session = activeBridge.sessionId ? ` (${activeBridge.sessionId})` : "";
    const target = activeBridgeTarget(activeBridge);
    const mcpName = activeBridgeMcpName(activeBridge);
    const prefix = mcpName ? `${mcpName}${session}` : `Rebinding running${session}`;
    rebindStatus.textContent = target
      ? `${prefix}: ${target}`
      : `One DNS rebind bridge is already running${session}. Stop it before launching another MCP attack.`;
    return;
  }

  if (!hasFinding) {
    rebindStatus.textContent = "";
    return;
  }

  rebindStatus.textContent = proof?.tested ? rebindProofLabel(proof.result) : "";
}

function section(title, content) {
  const wrapper = document.createElement("section");
  wrapper.className = "detailSection";

  const heading = document.createElement("h3");
  heading.textContent = title;

  wrapper.append(heading, content);
  return wrapper;
}

function detailsSection(title, content) {
  const wrapper = document.createElement("details");
  wrapper.className = "detailSection";

  const heading = document.createElement("summary");
  heading.textContent = title;

  wrapper.append(heading, content);
  return wrapper;
}

function keyValueRows(values) {
  const list = document.createElement("dl");
  list.className = "kv";

  for (const [key, rawValue] of Object.entries(values)) {
    const value = rawValue === undefined || rawValue === null || rawValue === "" ? "-" : String(rawValue);
    const row = document.createElement("div");
    const term = document.createElement("dt");
    const description = document.createElement("dd");
    term.textContent = key;
    description.textContent = value;
    row.append(term, description);
    list.append(row);
  }

  return list;
}

function evidenceDigest(finding) {
  const list = document.createElement("div");
  list.className = "evidenceList";
  const entries = compactEvidence(finding);

  for (const item of entries) {
    const block = document.createElement("div");
    block.className = "evidenceItem";

    const label = document.createElement("strong");
    label.textContent = item.label;

    const value = document.createElement("p");
    value.textContent = item.value || "-";

    block.append(label, value);
    list.append(block);
  }

  return list;
}

function toolExposureContent(finding) {
  const wrapper = document.createElement("div");
  wrapper.className = "toolExposure";

  wrapper.append(keyValueRows({
    Result: toolAccessResult(finding),
    "Tool count": finding.tools?.length || finding.fingerprint?.tools?.count || 0
  }));

  const tools = toolList((finding.tools || []).slice(0, 8));
  wrapper.append(tools);
  return wrapper;
}

function rebindSummary(finding) {
  const proof = finding.rebindProof || {};
  if (!proof.tested) {
    return {
      Result: "not run",
      Dashboard: isFindingActiveRebind(finding) ? "connected" : "-"
    };
  }

  return {
    Result: rebindProofLabel(proof.result),
    Hostname: proof.hostname,
    Origin: proof.origin,
    "DNS transition": dnsTransition(proof),
    Dashboard: isFindingActiveRebind(finding) ? "connected" : "-"
  };
}

function signalSummary(finding) {
  return {
    "Header validation": headerProbeLabel(finding),
    Auth: finding.fingerprint?.auth?.required ? authSummary(finding) : "not required",
    Session: finding.fingerprint?.session?.supported ? (finding.fingerprint.session.id || "supported") : "not required",
    "RPC errors": jsonRpcErrorSummary(finding)
  };
}

function compactEvidence(finding) {
  const evidence = [];
  const rpcEvidence = (finding.evidence || []).find((item) => item.bodySnippet?.includes("initialize: request=POST"));

  evidence.push({
    label: "MCP identity",
    value: [finding.fingerprint?.serverName, finding.fingerprint?.serverVersion, finding.fingerprint?.protocolVersion]
      .filter(Boolean)
      .join(" ")
  });

  if (finding.fingerprint?.session?.supported) {
    evidence.push({
      label: "Session",
      value: finding.fingerprint.session.id || "session established"
    });
  }

  evidence.push({
    label: "Tool access",
    value: toolAccessResult(finding)
  });

  if (finding.fingerprint?.auth?.required && !finding.tools?.length) {
    evidence.push({
      label: "Auth block",
      value: authSummary(finding)
    });
  }

  if (rpcEvidence) {
    evidence.push({
      label: "RPC status",
      value: formatRpcStatus(rpcEvidence.bodySnippet)
    });
  }

  evidence.push({
    label: "Header probe",
    value: finding.headerValidation?.evidence || "not tested"
  });

  return evidence.filter((item) => item.value);
}

function findingTitle(finding) {
  return finding.fingerprint?.serverName || finding.baseUrl || `${finding.target}:${finding.port}`;
}

function verdictLabel(finding) {
  if (finding.tools?.length || finding.fingerprint?.exposure?.authenticatedContext) {
    return "Vulnerable";
  }

  if (finding.fingerprint?.auth?.required) {
    return "Needs auth";
  }

  if (finding.mcpDetected) {
    return "Vulnerable";
  }

  if (hasJsonRpcErrors(finding)) {
    return "Broken MCP";
  }

  return "Not vulnerable";
}

function verdictClass(finding) {
  if (finding.tools?.length || finding.fingerprint?.exposure?.authenticatedContext) {
    return "vulnerable";
  }

  if (finding.fingerprint?.auth?.required) {
    return "authRequired";
  }

  if (finding.mcpDetected) {
    return "vulnerable";
  }

  if (hasJsonRpcErrors(finding)) {
    return "broken";
  }

  return "notVulnerable";
}

function authSummary(finding) {
  return (finding.fingerprint?.auth?.evidence || ["tools blocked by auth"])[0];
}

function toolAccessResult(finding) {
  if (finding.tools?.length) {
    return `tools/list returned ${finding.tools.length} tool${finding.tools.length === 1 ? "" : "s"}`;
  }

  if (finding.fingerprint?.exposure?.authenticatedContext) {
    return "authenticated MCP context exposed";
  }

  if (finding.fingerprint?.auth?.required) {
    return "blocked by auth";
  }

  return "no tools returned";
}

function toolList(tools) {
  const wrapper = document.createElement("div");
  wrapper.className = "toolList";

  if (!tools.length) {
    wrapper.classList.add("empty");
    wrapper.textContent = "No tools listed.";
    return wrapper;
  }

  for (const tool of tools) {
    const item = document.createElement("div");
    item.className = "toolItem";

    const name = document.createElement("strong");
    name.textContent = tool.name;

    const description = document.createElement("p");
    description.textContent = tool.description || "No description.";

    item.append(name, description);
    wrapper.append(item);
  }

  return wrapper;
}

function hasJsonRpcErrors(finding) {
  return Boolean(finding.fingerprint?.errors?.jsonRpc?.length);
}

function jsonRpcErrorSummary(finding) {
  const errors = finding.fingerprint?.errors?.jsonRpc || [];

  if (!errors.length) {
    return "";
  }

  return errors
    .map((error) => `${error.stage}: ${error.code ?? "error"} ${error.message}`)
    .join(" | ");
}

function headerProbeLabel(finding) {
  const result = finding.headerValidation?.result || "unknown";

  return {
    likely_vulnerable: "forged headers accepted",
    weak_signal: "weak header signal",
    not_vulnerable: "header probe blocked",
    unknown: "header probe unknown"
  }[result] || result.replace(/_/g, " ");
}

function rebindProofLabel(result) {
  return {
    not_tested: "Not tested",
    rebind_confirmed: "Rebind confirmed",
    blocked_by_host_validation: "Blocked by Host validation",
    blocked_by_lna: "Blocked by Local Network Access",
    blocked_by_cors: "Blocked by CORS",
    dns_not_rebound: "DNS did not rebound",
    mcp_not_detected: "MCP not detected",
    stopped: "Stopped",
    inconclusive: "Inconclusive"
  }[result] || "Inconclusive";
}

function rebindSessionId(finding) {
  return String(finding?.rebindSession?.id || finding?.rebindProof?.sessionId || "").trim();
}

function activeBridgeSessionId(finding) {
  if (!isFindingActiveRebind(finding)) {
    return "";
  }

  return rebindSessionId(finding);
}

function isFindingActiveRebind(finding) {
  return Boolean(activeBridge?.sessionId && rebindSessionId(finding) === activeBridge.sessionId);
}

function clearRebindSessionsExcept(findingToKeep) {
  const keepKey = findingToKeep ? findingKey(findingToKeep) : "";
  for (const finding of lastResult?.findings || []) {
    if (keepKey && findingKey(finding) === keepKey) {
      continue;
    }
    finding.rebindSession = null;
  }
}

function dnsTransition(proof) {
  if (!proof?.firstAddress && !proof?.reboundAddress) {
    return "";
  }

  return `${proof.firstAddress || "unknown"} -> ${proof.reboundAddress || "unknown"}`;
}

function formatRpcStatus(text) {
  const parts = [];
  const initialize = text.match(/initialize: request=POST .*? status=([^ ]+)/);
  const initialized = text.match(/initialized: request=POST .*? status=([^ ]+)/);
  const tools = text.match(/tools\/list: request=POST .*? status=([^ ]+)/);

  if (initialize) {
    parts.push(`initialize ${initialize[1]}`);
  }

  if (initialized) {
    parts.push(`initialized ${initialized[1]}`);
  }

  if (tools) {
    parts.push(`tools/list ${tools[1]}`);
  }

  return parts.join(", ");
}

function sortFindings(findings) {
  const sorted = [...findings];

  switch (sortSelect.value) {
    case "port":
      return sorted.sort((a, b) => a.port - b.port);
    case "server":
      return sorted.sort((a, b) => findingTitle(a).localeCompare(findingTitle(b)) || a.port - b.port);
    default:
      return sorted.sort((a, b) => riskScore(b) - riskScore(a) || a.port - b.port);
  }
}

function riskScore(finding) {
  return [
    severityScore(finding.severity),
    finding.tools?.length ? 20 : 0,
    finding.fingerprint?.auth?.required ? 12 : 0,
    finding.headerValidation?.result === "likely_vulnerable" ? 10 : 0,
    finding.headerValidation?.result === "weak_signal" ? 5 : 0
  ].reduce((sum, value) => sum + value, 0);
}

function severityScore(severity) {
  return {
    high: 40,
    medium: 25,
    informational: 10
  }[severity] || 0;
}

function rawJson(value) {
  const pre = document.createElement("pre");
  pre.className = "rawJson";
  pre.textContent = JSON.stringify(value, null, 2);
  return pre;
}

async function loadDeploymentSettings() {
  runtimeConfig = await loadRuntimeConfig();
  const runtimeDefaults = labSettingsFromRuntimeConfig(runtimeConfig);
  labDomainValue.textContent = runtimeDefaults.labDomain || "-";
  labDomainValue.title = runtimeDefaults.labDomain || "";
  renderVmIpValue();
  dashboardBaseValue.textContent = dashboardHost(runtimeConfig.dashboardBaseUrl || runtimeConfig.dashboardUrl || "-");
  dashboardBaseValue.title = runtimeConfig.dashboardBaseUrl || runtimeConfig.dashboardUrl || "";
  openDashboardButton.disabled = !dashboardDashboardUrl();
}

function renderVmIpValue() {
  const runtimeDefaults = runtimeConfig ? labSettingsFromRuntimeConfig(runtimeConfig) : {};
  const attackerIp = runtimeDefaults.attackerIp || "";
  const wrapper = vmIpValue.closest(".vmIpSecret");
  wrapper?.classList.toggle("masked", !vmIpVisible);
  vmIpValue.textContent = vmIpVisible ? attackerIp || "-" : maskVmIp(attackerIp);
  vmIpValue.title = vmIpVisible ? attackerIp || "" : "VM IP hidden";
  toggleVmIpButton.setAttribute("aria-label", vmIpVisible ? "Hide VM IP" : "Reveal VM IP");
  toggleVmIpButton.title = vmIpVisible ? "Hide VM IP" : "Reveal VM IP";
  vmIpEyeIcon.innerHTML = vmIpVisible ? OPEN_EYE_ICON : CLOSED_EYE_ICON;
}

function maskVmIp(value) {
  if (!value) {
    return "hidden";
  }

  return "hidden";
}

function dashboardDashboardUrl() {
  return String(runtimeConfig?.dashboardUrl || runtimeConfig?.dashboardBaseUrl || "").trim();
}

function dashboardHost(value) {
  try {
    const url = new URL(value);
    return url.host || "-";
  } catch {
    return String(value || "").trim() || "-";
  }
}

async function restoreDashboardState() {
  try {
    const stored = await chrome.storage.local.get(dashboardStateKeys);
    const storedResult = stored.dashboardLastResult;
    if (!storedResult?.summary || !Array.isArray(storedResult.findings)) {
      return;
    }

    lastResult = storedResult;
    selectedFindingKey = stored.dashboardSelectedFindingKey || firstFindingKey(lastResult.findings);
    activeBridge = stored.dashboardActiveBridge || null;
    if (activeBridge?.sessionId) {
      clearRebindSessionsExcept(findingByBridgeSession(activeBridge.sessionId));
    }
    renderResult();
    setStatus("Done", "done");
    resetActivity(
      "Scan complete",
      "done",
      `${lastResult.summary?.scanned ?? 0} ports scanned, ${lastResult.summary?.findings ?? 0} findings.`,
      100
    );
  } catch {
    // A fresh dashboard is still usable without restored state.
  }
}

function findingByBridgeSession(sessionId) {
  return (lastResult?.findings || []).find((finding) => rebindSessionId(finding) === sessionId) || null;
}

async function persistDashboardState() {
  try {
    if (!lastResult) {
      await clearPersistedDashboardState();
      return;
    }

    await chrome.storage.local.set({
      dashboardLastResult: lastResult,
      dashboardSelectedFindingKey: selectedFindingKey,
      dashboardActiveBridge: activeBridge || null
    });
  } catch {
    // Persistence is an operator convenience. Scanning still works without it.
  }
}

async function clearPersistedDashboardState() {
  try {
    await chrome.storage.local.remove(dashboardStateKeys);
  } catch {
    // Ignore storage failures in UI-only cleanup paths.
  }
}

function buildProviderDescriptor(finding) {
  const settings = labSettingsFromRuntimeConfig(runtimeConfig);
  if (settings.provider === "custom-url") {
    return buildCustomUrlDescriptor(settings.customRebindUrl, {
      port: finding.port,
      path: pathFromFinding(finding),
      transport: finding.fingerprint?.transport
    });
  }

  return buildSingularityDescriptor(finding, settings);
}

function pathFromFinding(finding) {
  try {
    return new URL(finding.fingerprint?.endpoint || finding.baseUrl || "").pathname;
  } catch {
    return "";
  }
}

function originForProof(proof, fallbackDescriptor) {
  try {
    return new URL(proof?.probeUrl || fallbackDescriptor.probeUrl).origin;
  } catch {
    return "";
  }
}

function pathForProof(proof, fallbackDescriptor) {
  try {
    return new URL(proof?.probeUrl || fallbackDescriptor.probeUrl).pathname;
  } catch {
    return fallbackDescriptor.path || "";
  }
}

function hostnameForProof(proof, fallbackDescriptor) {
  try {
    return new URL(proof?.probeUrl || fallbackDescriptor.probeUrl).hostname;
  } catch {
    return fallbackDescriptor.host || "";
  }
}

loadDeploymentSettings()
  .then(restoreDashboardState)
  .then(renderRebindControls)
  .catch(() => {});
