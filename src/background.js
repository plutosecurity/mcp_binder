import { MessageType } from "./messages.js";
import { runLocalPortScan, scanTargetPermissionCandidates } from "./scanner.js";

let activeScan = null;
const OFFSCREEN_URL = chrome.runtime.getURL("ui/offscreen.html");

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({
    url: chrome.runtime.getURL("ui/dashboard.html")
  });
});

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message) {
    return false;
  }

  if (message.type === MessageType.CancelScan) {
    if (activeScan) {
      activeScan.controller.abort();
    }

    sendResponse({
      type: MessageType.ScanCancelled,
      payload: {
        status: activeScan ? "cancelling" : "idle"
      }
    });

    return false;
  }

  if (message.type === MessageType.StartRebindBridge) {
    startOffscreenBridge(message.payload)
      .then((result) => sendResponse(result))
      .catch((error) => {
        sendResponse({
          type: MessageType.RebindBridgeError,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    return true;
  }

  if (message.type === MessageType.StopRebindBridge) {
    stopOffscreenBridge()
      .then((payload) => {
        sendResponse({
          type: MessageType.StopRebindBridge,
          payload
        });
      })
      .catch((error) => {
        sendResponse({
          type: MessageType.RebindBridgeError,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    return true;
  }

  if (message.type !== MessageType.StartScan) {
    return false;
  }

  if (activeScan) {
    sendResponse({
      type: MessageType.ScanError,
      error: "A scan is already running."
    });
    return false;
  }

  const scanId = crypto.randomUUID();
  const controller = new AbortController();
  activeScan = { id: scanId, controller };

  currentHostPermissionsForTarget(message.payload?.target)
    .then((allowedHostPermissions) => runLocalPortScan({
      ...(message.payload || {}),
      allowedHostPermissions
    }, controller.signal, {
      onProgress: (progress) => {
        chrome.runtime.sendMessage({
          type: MessageType.ScanProgress,
          payload: {
            scanId,
            ...progress
          }
        }).catch(() => {});
      }
    }))
    .then((result) => {
      sendResponse({
        type: MessageType.ScanResult,
        payload: result
      });
    })
    .catch((error) => {
      if (error instanceof DOMException && error.name === "AbortError") {
        sendResponse({
          type: MessageType.ScanCancelled,
          payload: {
            stage: "stage-3",
            status: "cancelled"
          }
        });
        return;
      }

      sendResponse({
        type: MessageType.ScanError,
        error: error instanceof Error ? error.message : String(error)
      });
    })
    .finally(() => {
      if (activeScan?.id === scanId) {
        activeScan = null;
      }
    });

  return true;
});

async function startOffscreenBridge(payload = {}) {
  await ensureOffscreenDocument();
  return chrome.runtime.sendMessage({
    type: MessageType.OffscreenStartRebindBridge,
    payload
  });
}

async function stopOffscreenBridge() {
  await ensureOffscreenDocument();
  return chrome.runtime.sendMessage({
    type: MessageType.OffscreenStopRebindBridge
  });
}

async function hasOffscreenDocument() {
  if (!chrome.runtime.getContexts) {
    return false;
  }

  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [OFFSCREEN_URL]
  });
  return contexts.length > 0;
}

async function ensureOffscreenDocument() {
  if (await hasOffscreenDocument()) {
    return;
  }

  await chrome.offscreen.createDocument({
    url: "ui/offscreen.html",
    reasons: ["WORKERS"],
    justification: "Maintain an authorized MCP DNS rebinding bridge after the dashboard closes."
  });
  await new Promise((resolve) => setTimeout(resolve, 150));
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
