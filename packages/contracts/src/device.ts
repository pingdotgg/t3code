/**
 * Device - Schemas for first-class iOS Simulator and Android Emulator support.
 *
 * The server owns device discovery, the streaming helper (expo-device-hub),
 * and the agent driver (agent-device). Clients render the live screen from the
 * server-proxied stream, and agents reach devices through the `device_*` MCP
 * tools plus the `agent-device` CLI the server preconfigures for them.
 *
 * Devices live on a *host*. Only the local host (the machine the server runs
 * on) exists today; the host id is carried everywhere so SSH and cloud hosts
 * can be added without changing the client contract.
 *
 * @module Device
 */
import { Schema } from "effect";

import { ThreadId, TrimmedNonEmptyString } from "./baseSchemas.ts";

export const DevicePlatform = Schema.Literals(["ios", "android"]);
export type DevicePlatform = typeof DevicePlatform.Type;

export const DeviceHostId = TrimmedNonEmptyString.check(Schema.isMaxLength(128));
export type DeviceHostId = typeof DeviceHostId.Type;

/** The server machine. Always present; other host kinds are future work. */
export const LOCAL_DEVICE_HOST_ID = "local" as DeviceHostId;

/** Simulator udid or adb serial (an AVD name while it is not running). */
export const DeviceId = TrimmedNonEmptyString.check(Schema.isMaxLength(256));
export type DeviceId = typeof DeviceId.Type;

export const DeviceSummary = Schema.Struct({
  hostId: DeviceHostId,
  id: DeviceId,
  platform: DevicePlatform,
  name: TrimmedNonEmptyString,
  /** OS label such as "iOS 18.0" or "Android 15.0". */
  version: Schema.String,
  booted: Schema.Boolean,
  physical: Schema.Boolean,
});
export type DeviceSummary = typeof DeviceSummary.Type;

/**
 * What the host can do right now. Platforms missing their toolchain are
 * reported rather than hidden so the picker and the agent can explain why a
 * platform is absent instead of showing an empty list.
 */
export const DevicePlatformAvailability = Schema.Struct({
  platform: DevicePlatform,
  available: Schema.Boolean,
  reason: Schema.optional(Schema.String),
});
export type DevicePlatformAvailability = typeof DevicePlatformAvailability.Type;

export const DeviceHostSummary = Schema.Struct({
  id: DeviceHostId,
  kind: Schema.Literals(["local"]),
  label: TrimmedNonEmptyString,
  platforms: Schema.Array(DevicePlatformAvailability),
});
export type DeviceHostSummary = typeof DeviceHostSummary.Type;

/**
 * Lifecycle of the helper processes on a host. Tools are installed on first
 * use, so a fresh install spends a while in `installing` before any device can
 * stream; the UI shows that instead of an empty picker.
 */
export const DeviceHostStatus = Schema.Literals([
  "idle",
  "installing",
  "starting",
  "ready",
  "failed",
]);
export type DeviceHostStatus = typeof DeviceHostStatus.Type;

/**
 * A device a thread is looking at. One session per (thread, device); the same
 * device may be open in several threads, since the stream is shared.
 */
export const DeviceSession = Schema.Struct({
  threadId: ThreadId,
  hostId: DeviceHostId,
  deviceId: DeviceId,
  platform: DevicePlatform,
  openedAt: Schema.String,
});
export type DeviceSession = typeof DeviceSession.Type;

export const DeviceServiceState = Schema.Struct({
  hosts: Schema.Array(DeviceHostSummary),
  hostStatus: DeviceHostStatus,
  hostStatusDetail: Schema.optional(Schema.String),
  devices: Schema.Array(DeviceSummary),
  sessions: Schema.Array(DeviceSession),
  /** Origin-relative path the client prefixes to hub routes. */
  hubBasePath: Schema.String,
  revision: Schema.Int,
});
export type DeviceServiceState = typeof DeviceServiceState.Type;

export const DeviceListInput = Schema.Struct({});
export type DeviceListInput = typeof DeviceListInput.Type;

export const DeviceOpenInput = Schema.Struct({
  threadId: ThreadId,
  hostId: Schema.optional(DeviceHostId),
  deviceId: DeviceId,
  platform: DevicePlatform,
  /** Boot the simulator or emulator when it is not running. Defaults to true. */
  boot: Schema.optional(Schema.Boolean),
});
export type DeviceOpenInput = typeof DeviceOpenInput.Type;

export const DeviceCloseInput = Schema.Struct({
  threadId: ThreadId,
  /** Omit to close every device session for the thread. */
  deviceId: Schema.optional(DeviceId),
  /** Also shut the simulator or emulator down. Defaults to false. */
  shutdown: Schema.optional(Schema.Boolean),
});
export type DeviceCloseInput = typeof DeviceCloseInput.Type;

export const DeviceShutdownInput = Schema.Struct({
  hostId: Schema.optional(DeviceHostId),
  deviceId: DeviceId,
  platform: DevicePlatform,
});
export type DeviceShutdownInput = typeof DeviceShutdownInput.Type;

export class DeviceHostUnavailableError extends Schema.TaggedError<DeviceHostUnavailableError>()(
  "DeviceHostUnavailableError",
  {
    hostId: DeviceHostId,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `Device host ${this.hostId} is unavailable: ${this.reason}`;
  }
}

export class DevicePlatformUnavailableError extends Schema.TaggedError<DevicePlatformUnavailableError>()(
  "DevicePlatformUnavailableError",
  {
    hostId: DeviceHostId,
    platform: DevicePlatform,
    reason: Schema.String,
  },
) {
  override get message(): string {
    return `${this.platform} devices are unavailable on host ${this.hostId}: ${this.reason}`;
  }
}

export class DeviceNotFoundError extends Schema.TaggedError<DeviceNotFoundError>()(
  "DeviceNotFoundError",
  {
    hostId: DeviceHostId,
    deviceId: DeviceId,
  },
) {
  override get message(): string {
    return `Device ${this.deviceId} was not found on host ${this.hostId}.`;
  }
}

export class DeviceBootError extends Schema.TaggedError<DeviceBootError>()("DeviceBootError", {
  hostId: DeviceHostId,
  deviceId: DeviceId,
  detail: Schema.String,
}) {
  override get message(): string {
    return `Device ${this.deviceId} failed to boot: ${this.detail}`;
  }
}

export class DeviceOperationError extends Schema.TaggedError<DeviceOperationError>()(
  "DeviceOperationError",
  {
    operation: Schema.String,
    detail: Schema.String,
  },
) {
  override get message(): string {
    return `Device ${this.operation} failed: ${this.detail}`;
  }
}

export const DeviceError = Schema.Union([
  DeviceHostUnavailableError,
  DevicePlatformUnavailableError,
  DeviceNotFoundError,
  DeviceBootError,
  DeviceOperationError,
]);
export type DeviceError = typeof DeviceError.Type;

// MCP tool shapes. Kept next to the RPC shapes so the tool surface and the
// panel describe devices the same way.

export const DeviceToolListResult = Schema.Struct({
  hosts: Schema.Array(DeviceHostSummary),
  devices: Schema.Array(DeviceSummary),
  /** Devices already open in this thread's Device panel. */
  open: Schema.Array(Schema.Struct({ hostId: DeviceHostId, deviceId: DeviceId })),
});
export type DeviceToolListResult = typeof DeviceToolListResult.Type;

export const DeviceToolOpenInput = Schema.Struct({
  deviceId: Schema.optional(
    DeviceId.annotate({
      description:
        "Simulator udid or emulator serial from device_list. Omit to use the booted device for the platform, or the most recently used one.",
    }),
  ),
  platform: Schema.optional(
    DevicePlatform.annotate({
      description: "Required when deviceId is omitted and both platforms are available.",
    }),
  ),
  hostId: Schema.optional(
    DeviceHostId.annotate({ description: "Device host from device_list. Defaults to local." }),
  ),
}).annotate({
  description:
    "Boots the device if needed, starts its live stream, and opens the Device panel so the user can watch. Returns how to drive it with the agent-device CLI.",
});
export type DeviceToolOpenInput = typeof DeviceToolOpenInput.Type;

export const DeviceToolOpenResult = Schema.Struct({
  device: DeviceSummary,
  /** Ready-to-run agent-device invocation pinned to this device. */
  agentDevice: Schema.Struct({
    command: Schema.String,
    /** Flags that pin every command to this device, e.g. `--udid <id>`. */
    targetArgs: Schema.Array(Schema.String),
  }),
  quickStart: Schema.String,
});
export type DeviceToolOpenResult = typeof DeviceToolOpenResult.Type;

export const DeviceToolTargetInput = Schema.Struct({
  deviceId: Schema.optional(
    DeviceId.annotate({
      description:
        "Device from device_list. Omit to use the device most recently opened in this thread.",
    }),
  ),
  hostId: Schema.optional(DeviceHostId),
});
export type DeviceToolTargetInput = typeof DeviceToolTargetInput.Type;

export const DeviceToolScreenshotResult = Schema.Struct({
  device: DeviceSummary,
  screenshot: Schema.Struct({
    mimeType: Schema.Literal("image/png"),
    data: Schema.String,
    width: Schema.Int,
    height: Schema.Int,
  }),
});
export type DeviceToolScreenshotResult = typeof DeviceToolScreenshotResult.Type;

export const DeviceToolCloseInput = Schema.Struct({
  deviceId: Schema.optional(
    DeviceId.annotate({
      description: "Device to close. Omit to close every device in this thread.",
    }),
  ),
  hostId: Schema.optional(DeviceHostId),
  shutdown: Schema.optional(
    Schema.Boolean.annotate({
      description: "Also power the simulator or emulator off. Defaults to false.",
    }),
  ),
});
export type DeviceToolCloseInput = typeof DeviceToolCloseInput.Type;

export class DeviceToolUnavailableError extends Schema.TaggedError<DeviceToolUnavailableError>()(
  "DeviceToolUnavailableError",
  {
    reason: Schema.String,
  },
) {
  override get message(): string {
    return this.reason;
  }
}

export const DeviceToolError = Schema.Union([
  DeviceToolUnavailableError,
  DeviceHostUnavailableError,
  DevicePlatformUnavailableError,
  DeviceNotFoundError,
  DeviceBootError,
  DeviceOperationError,
]);
export type DeviceToolError = typeof DeviceToolError.Type;
