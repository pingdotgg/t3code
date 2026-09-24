// @effect-diagnostics globalFetch:off - This browser transport runs without an Effect runtime, like the live stream.
import { withDeviceHubQuery } from "./hubAccess.ts";
import type { DeviceStreamTarget } from "./stream.ts";

export class DeviceScreenshotError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Screenshot capture failed (${status}). Try again.`);
    this.status = status;
  }
}

/** Captures native pixels through the same host and credentials as the live stream, in either presentation. */
export async function captureDeviceScreenshot(target: DeviceStreamTarget, signal: AbortSignal) {
  const vendor = target.platform === "ios" ? "serve-sim" : "serve-emu";
  const url = withDeviceHubQuery(
    `${target.access.httpBase}/vendor/${vendor}/api/screenshot?device=${encodeURIComponent(target.deviceId)}`,
    target.access,
  );
  const response = await fetch(url, {
    method: "POST",
    credentials: target.access.credentials ? "include" : "omit",
    signal: AbortSignal.any([signal, AbortSignal.timeout(20_000)]),
  });
  if (!response.ok) throw new DeviceScreenshotError(response.status);
  const image = await response.blob();
  if (!image.size) throw new Error("The device returned an empty screenshot. Try again.");
  return image;
}
