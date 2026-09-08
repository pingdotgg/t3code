/**
 * A device host is a machine with simulators or emulators on it. The service
 * layer only ever talks to this interface, so a future SSH or cloud host slots
 * in beside `LocalDeviceHost` without touching discovery, the proxy, or the
 * MCP tools.
 *
 * Every host presents the same two things once it is ready: a loopback origin
 * where expo-device-hub answers, and an agent-device daemon endpoint. For the
 * local host both run on this machine; a remote host would forward them here.
 */
import type {
  DeviceHostId,
  DeviceHostSummary,
  DevicePlatform,
  DevicePlatformAvailability,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export class DeviceHostError extends Schema.TaggedError<DeviceHostError>()("DeviceHostError", {
  hostId: Schema.String,
  step: Schema.String,
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message(): string {
    return `Device host ${this.hostId} failed while ${this.step}: ${this.detail}`;
  }
}

export interface DeviceHubEndpoint {
  /** Loopback origin of expo-device-hub, e.g. `http://127.0.0.1:3400`. */
  readonly origin: string;
}

export interface AgentDeviceEndpoint {
  readonly baseUrl: string;
  readonly token: string;
  /** Absolute path of the agent-device entry script for the provider PATH shim. */
  readonly entryPath: string;
}

export interface DeviceHostReady {
  readonly hub: DeviceHubEndpoint;
  readonly agentDevice: AgentDeviceEndpoint;
  /**
   * Runs a host command (`xcrun`, `adb`, or a helper bundled with the hub)
   * where the devices live. On the local host this is a plain spawn; a
   * remote host would run it over its transport.
   */
  readonly run: (
    command: string,
    args: ReadonlyArray<string>,
    options?: { readonly timeoutMs?: number; readonly stdin?: string },
  ) => Effect.Effect<{ readonly stdout: string; readonly stderr: string; readonly code: number }>;
  /** Absolute paths of helper binaries vendored with the hub, when present. */
  readonly helpers: {
    readonly serveSimAxSettings: string | null;
    readonly serveSimCli: string | null;
  };
}

export interface DeviceHost {
  readonly id: DeviceHostId;
  readonly summary: Effect.Effect<DeviceHostSummary>;
  readonly platformAvailability: (
    platform: DevicePlatform,
  ) => Effect.Effect<DevicePlatformAvailability>;
  /**
   * Installs tools on first use and starts the helper processes. Idempotent:
   * concurrent callers share one start, and a ready host returns immediately.
   */
  readonly ensureReady: (
    onPhase: (phase: "installing" | "starting") => Effect.Effect<void>,
  ) => Effect.Effect<DeviceHostReady, DeviceHostError>;
  /** Current endpoints when already running, without starting anything. */
  readonly current: Effect.Effect<DeviceHostReady | null>;
  /** Stops helpers. Devices themselves keep running; the user owns those. */
  readonly stop: Effect.Effect<void>;
}
