const RESULT_VALUES = new Set([
  "not_tested",
  "rebind_confirmed",
  "blocked_by_host_validation",
  "blocked_by_lna",
  "blocked_by_cors",
  "dns_not_rebound",
  "mcp_not_detected",
  "inconclusive"
]);

export function normalizeRebindEvidence(rawEvidence, selectedFinding = {}) {
  const raw = typeof rawEvidence === "string" ? JSON.parse(rawEvidence) : rawEvidence;
  const request = firstRequest(raw);
  const errors = Array.isArray(raw?.errors) ? raw.errors.map(String) : [];
  const result = classifyRebindResult(raw, request, errors);

  return {
    tested: true,
    result,
    source: "operator_import",
    importedAt: new Date().toISOString(),
    campaignId: stringOrNull(raw?.campaignId),
    victimId: stringOrNull(raw?.victimId),
    origin: stringOrNull(raw?.origin),
    targetPort: numberOrFallback(firstPort(raw), selectedFinding.port),
    transport: stringOrFallback(raw?.transport, selectedFinding.fingerprint?.transport),
    path: stringOrFallback(raw?.path, pathFromEndpoint(selectedFinding.fingerprint?.endpoint)),
    hostname: stringOrNull(raw?.hostname),
    firstAddress: stringOrNull(raw?.dns?.firstAddress),
    reboundAddress: stringOrNull(raw?.dns?.reboundAddress),
    httpStatus: Number.isInteger(request?.status) ? request.status : null,
    mcp: {
      detected: Boolean(raw?.mcp?.detected),
      protocolVersion: stringOrNull(raw?.mcp?.protocolVersion),
      serverName: stringOrNull(raw?.mcp?.serverName),
      tools: Array.isArray(raw?.mcp?.tools) ? raw.mcp.tools.map(String) : []
    },
    evidence: buildEvidence(result, raw, request, errors),
    limitations: buildLimitations(raw, request, errors)
  };
}

export function emptyRebindProof() {
  return {
    tested: false,
    result: "not_tested",
    source: null,
    importedAt: null,
    evidence: [],
    limitations: []
  };
}

function classifyRebindResult(raw, request, errors) {
  const explicit = stringOrNull(raw?.result);
  if (RESULT_VALUES.has(explicit)) {
    return explicit;
  }

  const body = String(request?.bodySnippet || "").toLowerCase();
  const errorText = errors.join(" ").toLowerCase();

  if (raw?.mcp?.detected && Array.isArray(raw?.mcp?.tools)) {
    return "rebind_confirmed";
  }

  if (body.includes("invalid host") || errorText.includes("host validation")) {
    return "blocked_by_host_validation";
  }

  if (errorText.includes("private network access") || errorText.includes("lna")) {
    return "blocked_by_lna";
  }

  if (errorText.includes("cors")) {
    return "blocked_by_cors";
  }

  if (raw?.dns?.reboundAddress && raw.dns.reboundAddress !== "127.0.0.1") {
    return "dns_not_rebound";
  }

  if (request && !raw?.mcp?.detected) {
    return "mcp_not_detected";
  }

  return "inconclusive";
}

function firstRequest(raw) {
  return Array.isArray(raw?.requests) ? raw.requests[0] : null;
}

function firstPort(raw) {
  return Array.isArray(raw?.ports) ? raw.ports[0] : raw?.port;
}

function buildEvidence(result, raw, request, errors) {
  const evidence = [`rebind lab result: ${result}`];

  if (raw?.dns?.firstAddress || raw?.dns?.reboundAddress) {
    evidence.push(`dns ${raw.dns.firstAddress || "unknown"} -> ${raw.dns.reboundAddress || "unknown"}`);
  }

  if (request?.url) {
    evidence.push(`request ${request.status || "unknown"} ${request.url}`);
  }

  if (raw?.mcp?.detected) {
    evidence.push(`MCP detected${raw.mcp.serverName ? `: ${raw.mcp.serverName}` : ""}`);
  }

  if (Array.isArray(raw?.mcp?.tools) && raw.mcp.tools.length) {
    evidence.push(`tools/list returned ${raw.mcp.tools.length} tool(s)`);
  }

  for (const error of errors) {
    evidence.push(error);
  }

  return evidence;
}

function buildLimitations(raw, request, errors) {
  const limitations = [];

  if (!raw?.dns?.firstAddress || !raw?.dns?.reboundAddress) {
    limitations.push("DNS transition evidence was not present in the imported lab result.");
  }

  if (!request) {
    limitations.push("No browser request evidence was present in the imported lab result.");
  }

  if (errors.length && !raw?.mcp?.detected) {
    limitations.push("The lab reported browser or server errors before MCP was confirmed.");
  }

  return limitations;
}

function stringOrNull(value) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function stringOrFallback(value, fallback) {
  return stringOrNull(value) || stringOrNull(fallback);
}

function numberOrFallback(value, fallback) {
  return Number.isInteger(value) ? value : Number.isInteger(fallback) ? fallback : null;
}

function pathFromEndpoint(endpoint) {
  try {
    return endpoint ? new URL(endpoint).pathname : null;
  } catch {
    return null;
  }
}
