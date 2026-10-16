import type { NativeLayoutMetrics } from "./reserved-regions";

/**
 * Hardware family for device-specific chrome. Column count still comes from
 * `deriveLayout`: an iPad in Slide Over or a narrow window on the Duo's inner
 * display keeps its device type but has no room for a sidebar.
 *
 * iOS only. Android has no layout metrics observer and always reads "phone".
 */
export type DeviceType = "phone" | "duo-folded" | "duo-unfolded" | "pad";

export function deriveDeviceType(input: {
  readonly isPad: boolean;
  readonly metrics: NativeLayoutMetrics | null;
}): DeviceType {
  if (input.isPad) return "pad";
  // The hinge arrives with the first native layout pass, so a Duo reads as a
  // phone until then. Compact width also covers a narrow inner-display window.
  if (input.metrics?.hasHinge !== true) return "phone";
  return input.metrics.horizontalSizeClass === "regular" ? "duo-unfolded" : "duo-folded";
}

export function isDuoDevice(deviceType: DeviceType): boolean {
  return deviceType === "duo-folded" || deviceType === "duo-unfolded";
}
