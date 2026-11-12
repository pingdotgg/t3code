import type { NativeLayoutMetrics } from "./reserved-regions";

/** Hardware type does not imply column space. Android lacks metrics and reports phone. */
export type DeviceType = "phone" | "duo-folded" | "duo-unfolded" | "pad";

export function deriveDeviceType(input: {
  readonly isPad: boolean;
  readonly metrics: NativeLayoutMetrics | null;
}): DeviceType {
  if (input.isPad) return "pad";
  // Duo reads as phone until the first native hinge layout; compact width includes narrow inner windows.
  if (input.metrics?.hasHinge !== true) return "phone";
  return input.metrics.horizontalSizeClass === "regular" ? "duo-unfolded" : "duo-folded";
}

export function isDuoDevice(deviceType: DeviceType): boolean {
  return deviceType === "duo-folded" || deviceType === "duo-unfolded";
}
