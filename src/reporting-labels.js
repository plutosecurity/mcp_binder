export function formatScanStage(stage) {
  return {
    "stage-0": "Initialized",
    "stage-1": "Port scan",
    "stage-2": "MCP probing",
    "stage-3": "Scan complete",
    "stage-5": "DNS rebind attack"
  }[stage] || String(stage || "-");
}
