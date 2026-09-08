import {
  type DeviceError,
  type DeviceHostId,
  type DeviceId,
  type DevicePlatform,
  type DeviceSummary,
  DeviceToolUnavailableError,
  LOCAL_DEVICE_HOST_ID,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import * as DeviceService from "../../../device/DeviceService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { DeviceScreenshotToolkit, DeviceStandardToolkit, DeviceToolkit } from "./tools.ts";

/** The flags that pin every agent-device command to one device. */
export function agentDeviceTargetArgs(device: DeviceSummary): ReadonlyArray<string> {
  return device.platform === "ios"
    ? ["--platform", "ios", "--udid", device.id]
    : ["--platform", "android", "--serial", device.id];
}

/**
 * Just-in-time guidance returned from `device_open`. This is the one place
 * the agent learns how to drive the device, so it lives with the tool result
 * rather than in the always-on prompt block; threads that never open a device
 * never pay for it.
 */
export function agentDeviceQuickStart(device: DeviceSummary): string {
  const target = agentDeviceTargetArgs(device).join(" ");
  const platformNotes =
    device.platform === "ios"
      ? "First use builds an XCTest runner and can take a couple of minutes; later commands are fast."
      : "The Android snapshot helper installs itself on first use.";
  return [
    `The user is watching ${device.name} (${device.version}) in the Device panel.`,
    `Drive it with the agent-device CLI, which is on PATH and already connected to this environment. Always pass ${target}.`,
    "Typical loop:",
    `  agent-device open <bundle-or-package-id> ${target}     # or: open <app> <deep-link-url>`,
    `  agent-device snapshot -i ${target}                     # accessibility tree with @eN refs`,
    `  agent-device click @e3 ${target}`,
    `  agent-device fill @e5 "text" ${target}`,
    `  agent-device screenshot /tmp/shot.png ${target}        # or call device_screenshot`,
    `  agent-device install <app> <path-to-.app-or-.apk> ${target}`,
    "Prefer snapshot refs over coordinates. Run `agent-device help` for workflow guides and `agent-device <command> --help` for flags.",
    "Do not call simctl, adb, xcrun, or serve-sim directly while these tools are attached; use agent-device.",
    platformNotes,
  ].join("\n");
}

const requireDeviceAccess = McpInvocationContext.requireMcpCapability("device").pipe(
  Effect.mapError(
    () =>
      new DeviceToolUnavailableError({
        reason: "Agent device access is turned off for this environment.",
      }),
  ),
);

const pickDevice = (
  devices: ReadonlyArray<DeviceSummary>,
  input: {
    readonly deviceId?: DeviceId | undefined;
    readonly platform?: DevicePlatform | undefined;
    readonly hostId?: DeviceHostId | undefined;
  },
): Effect.Effect<DeviceSummary, DeviceToolUnavailableError> =>
  Effect.gen(function* () {
    const hostId = input.hostId ?? LOCAL_DEVICE_HOST_ID;
    if (input.deviceId !== undefined) {
      const match = devices.find(
        (device) => device.hostId === hostId && device.id === input.deviceId,
      );
      if (match) return match;
      return yield* new DeviceToolUnavailableError({
        reason: `No device ${input.deviceId} on host ${hostId}. Call device_list for current ids.`,
      });
    }
    const candidates = devices.filter(
      (device) =>
        device.hostId === hostId &&
        (input.platform === undefined || device.platform === input.platform),
    );
    if (candidates.length === 0) {
      return yield* new DeviceToolUnavailableError({
        reason:
          input.platform === undefined
            ? "No simulators or emulators were found. Call device_list to see why."
            : `No ${input.platform} devices were found on host ${hostId}. Call device_list to see why.`,
      });
    }
    const platforms = new Set(candidates.map((device) => device.platform));
    if (input.platform === undefined && platforms.size > 1) {
      return yield* new DeviceToolUnavailableError({
        reason: "Both iOS and Android devices are available; pass platform or deviceId.",
      });
    }
    return candidates.find((device) => device.booted) ?? candidates[0]!;
  });

const toolError = (error: DeviceError | DeviceToolUnavailableError) => error;

const handlers = {
  device_list: (input) =>
    Effect.gen(function* () {
      const scope = yield* requireDeviceAccess;
      const devices = yield* DeviceService.DeviceService;
      const state = yield* devices.list;
      const hostId = input?.hostId;
      const open = state.sessions
        .filter((session) => session.threadId === scope.threadId)
        .map((session) => ({ hostId: session.hostId, deviceId: session.deviceId }));
      return {
        hosts: hostId ? state.hosts.filter((host) => host.id === hostId) : state.hosts,
        devices: hostId
          ? state.devices.filter((device) => device.hostId === hostId)
          : state.devices,
        open,
      };
    }).pipe(Effect.mapError(toolError)),
  device_open: (input) =>
    Effect.gen(function* () {
      const scope = yield* requireDeviceAccess;
      const devices = yield* DeviceService.DeviceService;
      const state = yield* devices.list;
      const target = yield* pickDevice(state.devices, input);
      const session = yield* devices.open({
        threadId: scope.threadId,
        hostId: target.hostId,
        deviceId: target.id,
        platform: target.platform,
      });
      const after = yield* devices.state;
      const device =
        after.devices.find(
          (candidate) => candidate.hostId === session.hostId && candidate.id === session.deviceId,
        ) ?? target;
      return {
        device,
        agentDevice: { command: "agent-device", targetArgs: agentDeviceTargetArgs(device) },
        quickStart: agentDeviceQuickStart(device),
      };
    }).pipe(Effect.mapError(toolError)),
  device_screenshot: (input) =>
    Effect.gen(function* () {
      const scope = yield* requireDeviceAccess;
      const devices = yield* DeviceService.DeviceService;
      const sessions = yield* devices.sessionsForThread(scope.threadId);
      const target =
        input.deviceId !== undefined
          ? { hostId: input.hostId ?? LOCAL_DEVICE_HOST_ID, deviceId: input.deviceId }
          : sessions.at(-1);
      if (!target) {
        return yield* new DeviceToolUnavailableError({
          reason: "No device is open in this thread. Call device_open first.",
        });
      }
      const shot = yield* devices.screenshot(target);
      return {
        device: shot.device,
        screenshot: {
          mimeType: "image/png" as const,
          data: Buffer.from(shot.png).toString("base64"),
          ...pngDimensions(shot.png),
        },
      };
    }).pipe(Effect.mapError(toolError)),
  device_close: (input) =>
    Effect.gen(function* () {
      const scope = yield* requireDeviceAccess;
      const devices = yield* DeviceService.DeviceService;
      yield* devices.close({
        threadId: scope.threadId,
        ...(input.deviceId === undefined ? {} : { deviceId: input.deviceId }),
        ...(input.shutdown === undefined ? {} : { shutdown: input.shutdown }),
      });
      return {};
    }).pipe(Effect.mapError(toolError)),
} satisfies Parameters<typeof DeviceToolkit.toLayer>[0];

/** Width and height from the IHDR chunk; a PNG that lacks one reports 0×0. */
export function pngDimensions(png: Uint8Array): { width: number; height: number } {
  if (png.length < 24) return { width: 0, height: 0 };
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  const isPng =
    view.getUint32(0) === 0x89504e47 &&
    view.getUint32(4) === 0x0d0a1a0a &&
    view.getUint32(12) === 0x49484452;
  return isPng
    ? { width: view.getUint32(16), height: view.getUint32(20) }
    : { width: 0, height: 0 };
}

const { device_screenshot, ...standardHandlers } = handlers;

export const DeviceStandardToolkitHandlersLive = DeviceStandardToolkit.toLayer(standardHandlers);

export const DeviceScreenshotToolkitHandlersLive = DeviceScreenshotToolkit.toLayer({
  device_screenshot,
});
