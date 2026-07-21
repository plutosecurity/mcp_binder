const RUNTIME_CONFIG_PATH = "generated/runtime-config.json";

export async function loadRuntimeConfig(options = {}) {
  const fetchImpl = options.fetchImpl || fetch;
  const runtime = options.runtime || globalThis.chrome?.runtime;
  const url = runtime?.getURL ? runtime.getURL(RUNTIME_CONFIG_PATH) : RUNTIME_CONFIG_PATH;

  try {
    const response = await fetchImpl(url, { cache: "no-store" });
    if (!response.ok) {
      return defaultRuntimeConfig();
    }
    return normalizeRuntimeConfig(await response.json());
  } catch {
    return defaultRuntimeConfig();
  }
}

export function dashboardBaseFromRuntimeConfig(config) {
  return String(config?.dashboardBaseUrl || config?.dashboardUrl || "").trim();
}

export function labSettingsFromRuntimeConfig(config) {
  return {
    provider: config?.defaultProvider || "singularity-compatible",
    labDomain: config?.rebindDomain || "example.test",
    attackerIp: config?.attackerIp || "127.0.0.1",
    targetIp: "127.0.0.1",
    launcherPort: String(config?.launcherPort || "8080"),
    customRebindUrl: ""
  };
}

function normalizeRuntimeConfig(config = {}) {
  return {
    name: String(config.name || "MCP Binder"),
    version: String(config.version || "0.1.0"),
    dashboardMode: "remote-http",
    dashboardBaseUrl: String(config.dashboardBaseUrl || config.dashboardUrl || "").replace(/\/+$/, ""),
    dashboardUrl: String(config.dashboardUrl || config.dashboardBaseUrl || "").replace(/\/+$/, ""),
    rebindDomain: String(config.rebindDomain || ""),
    attackerIp: String(config.attackerIp || ""),
    defaultProvider: String(config.defaultProvider || "singularity-compatible"),
    launcherPort: Number(config.launcherPort || 8080),
    hostPermissions: Array.isArray(config.hostPermissions) ? config.hostPermissions : [],
    ingestToken: String(config.ingestToken || ""),
    tokenPolicy: String(config.tokenPolicy || "none")
  };
}

function defaultRuntimeConfig() {
  return normalizeRuntimeConfig({
    dashboardMode: "remote-http"
  });
}
