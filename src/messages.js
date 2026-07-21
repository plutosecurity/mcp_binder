export const MessageType = Object.freeze({
  StartScan: "scan.start",
  CancelScan: "scan.cancel",
  ScanProgress: "scan.progress",
  ScanResult: "scan.result",
  ScanCancelled: "scan.cancelled",
  ScanError: "scan.error",
  StartRebindBridge: "rebind.bridge.start",
  StopRebindBridge: "rebind.bridge.stop",
  OffscreenStartRebindBridge: "rebind.bridge.offscreen.start",
  OffscreenStopRebindBridge: "rebind.bridge.offscreen.stop",
  RebindBridgeLog: "rebind.bridge.log",
  RebindBridgeAlreadyRunning: "rebind.bridge.alreadyRunning",
  RebindBridgeResult: "rebind.bridge.result",
  RebindBridgeError: "rebind.bridge.error"
});

export const Stage = Object.freeze({
  Skeleton: "stage-0",
  LocalPortScanner: "stage-1",
  McpEndpointProbing: "stage-2",
  HeaderValidation: "stage-3",
  RebindValidation: "stage-5"
});
