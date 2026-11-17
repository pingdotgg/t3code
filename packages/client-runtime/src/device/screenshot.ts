// @effect-diagnostics globalFetch:off - This browser transport runs without an Effect runtime, like the live stream.
import * as Schema from "effect/Schema";
import { extractPng } from "@t3tools/shared/png";
import { withDeviceHubQuery } from "./hubAccess.ts";
import type { DeviceStreamTarget } from "./stream.ts";

export class DeviceScreenshotError extends Schema.TaggedError<DeviceScreenshotError>()(
  "DeviceScreenshotError",
  { status: Schema.Number },
) {
  override get message(): string {
    return `Screenshot capture failed (${this.status}). Try again.`;
  }
}

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
  if (!response.ok) throw new DeviceScreenshotError({ status: response.status });
  const png = extractPng(new Uint8Array(await response.arrayBuffer()));
  if (!png) throw new Error("The device returned an incomplete screenshot. Try again.");
  return new Blob([png], { type: "image/png" });
}
