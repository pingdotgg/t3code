import type { BackgroundConnectionStatus } from "../../native/backgroundConnection";

export type BackgroundConnectionStatusLabel =
  | "Running"
  | "Starting"
  | "Stopped"
  | "Battery optimization enabled";

export function backgroundConnectionStatusLabel(
  status: BackgroundConnectionStatus,
): BackgroundConnectionStatusLabel {
  if (!status.supported || !status.enabled) {
    return "Stopped";
  }
  if (!status.batteryOptimizationIgnored) {
    return "Battery optimization enabled";
  }
  return status.serviceRunning && status.runtimeReady ? "Running" : "Starting";
}

export function shouldRequestBackgroundConnectionBatteryExemption(
  status: BackgroundConnectionStatus,
): boolean {
  return status.supported && status.enabled && !status.batteryOptimizationIgnored;
}
