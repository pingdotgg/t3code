import type {
  SandboxSnapshot,
  SandboxUsage,
  SandboxRecording,
  SandboxDeletionOperation,
  CloudSandboxDetails,
  CloudSandboxCapabilities,
  CloudSandboxDriverKind,
  CloudSandboxSummary,
  DesktopSshEnvironmentTarget,
  SandboxDesktopStreamSession,
  SandboxForkOptions,
  SandboxHostedPortResult,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import type * as Effect from "effect/Effect";

export class CloudSandboxError extends Schema.TaggedError<CloudSandboxError>()(
  "CloudSandboxError",
  {
    reason: Schema.Literals([
      "authentication",
      "permission",
      "configuration",
      "unavailable",
      "not-found",
    ]),
    cause: Schema.Defect(),
    rateLimit: Schema.optionalKey(
      Schema.Struct({
        scope: Schema.Literals(["paced", "capped", "capacity"]),
        window: Schema.optionalKey(Schema.Literals(["minute", "hour", "day"])),
        waitMs: Schema.optionalKey(Schema.Number),
      }),
    ),
  },
) {
  override get message() {
    switch (this.reason) {
      case "not-found":
        return "The cloud resource does not exist.";
      case "authentication":
        return "Invalid API key for cloud sandbox provider.";
      case "permission":
        return "Cloud sandbox API key lacks permission. Check its scope and organization.";
      case "configuration":
        return "Cloud sandbox configuration is invalid or unsupported.";
      case "unavailable":
        return "Cloud sandbox provider is unavailable. Please try again.";
    }
  }
}

export interface CreateSandboxParams {
  readonly name: string;
  readonly requestId?: string;
  readonly size?: string;
  readonly autoStopMinutes?: number;
  readonly template?: string;
}

export interface ForkableSandbox {
  readonly forkSandbox: (
    sandboxId: string,
    options?: SandboxForkOptions,
  ) => Effect.Effect<CloudSandboxDetails, CloudSandboxError>;
}
export interface StreamableSandbox {
  readonly getBrowserStreamSession?: (
    sandboxId: string,
  ) => Effect.Effect<SandboxDesktopStreamSession, CloudSandboxError>;
  readonly getDesktopStreamSession: (
    sandboxId: string,
    theme?: "dark" | "light",
  ) => Effect.Effect<SandboxDesktopStreamSession, CloudSandboxError>;
}
export interface KeepaliveSandbox {
  readonly extendAutoStop: (
    sandboxId: string,
    hours: number,
  ) => Effect.Effect<CloudSandboxDetails, CloudSandboxError>;
}
export interface HostableSandbox {
  readonly protectedAccess: boolean;
  readonly exposePort: (
    sandboxId: string,
    port: number,
    isPublic?: boolean,
  ) => Effect.Effect<SandboxHostedPortResult, CloudSandboxError>;
}
export interface SnapshotSandbox {
  readonly capture: (input: {
    readonly sandboxId: string;
    readonly name: string;
  }) => Effect.Effect<SandboxSnapshot, CloudSandboxError>;
  readonly get: (name: string) => Effect.Effect<SandboxSnapshot, CloudSandboxError>;
  readonly waitReady: (name: string) => Effect.Effect<SandboxSnapshot, CloudSandboxError>;
  readonly delete: (name: string) => Effect.Effect<void, CloudSandboxError>;
}
export interface DeletableSandbox {
  readonly start: (sandboxId: string) => Effect.Effect<SandboxDeletionOperation, CloudSandboxError>;
  readonly get: (operationId: string) => Effect.Effect<SandboxDeletionOperation, CloudSandboxError>;
  readonly wait: (
    operationId: string,
  ) => Effect.Effect<SandboxDeletionOperation, CloudSandboxError>;
}
export interface RecordingSandbox {
  readonly start: (
    sandboxId: string,
    recordingId: string,
  ) => Effect.Effect<SandboxRecording, CloudSandboxError>;
  readonly status: (
    sandboxId: string,
    recordingId: string,
  ) => Effect.Effect<SandboxRecording, CloudSandboxError>;
  readonly stop: (
    sandboxId: string,
    recordingId: string,
  ) => Effect.Effect<SandboxRecording, CloudSandboxError>;
  readonly getArtifact: (
    sandboxId: string,
    recordingId: string,
  ) => Effect.Effect<Uint8Array, CloudSandboxError>;
}
export interface UsageSandbox {
  readonly getUsage: (sandboxId: string) => Effect.Effect<SandboxUsage, CloudSandboxError>;
}
export interface ResizableSandbox {
  readonly mode: "restart" | "hot";
  readonly resize: (
    sandboxId: string,
    size: string,
  ) => Effect.Effect<CloudSandboxDetails, CloudSandboxError>;
}
export interface BaseCloudSandboxDriver {
  readonly kind: CloudSandboxDriverKind;
  readonly rootAccess: boolean;
  readonly pricing?: {
    readonly hourlyUsd: (size: string) => number | null;
  };
  readonly forking?: ForkableSandbox;
  readonly snapshots?: SnapshotSandbox;
  readonly deletion?: DeletableSandbox;
  readonly recording?: RecordingSandbox;
  readonly usage?: UsageSandbox;
  readonly streaming?: StreamableSandbox;
  readonly keepalive?: KeepaliveSandbox;
  readonly hosting?: HostableSandbox;
  readonly resizing?: ResizableSandbox;
  readonly list: () => Effect.Effect<readonly CloudSandboxSummary[], CloudSandboxError>;
  readonly get: (sandboxId: string) => Effect.Effect<CloudSandboxDetails, CloudSandboxError>;
  readonly create: (
    input: CreateSandboxParams,
  ) => Effect.Effect<CloudSandboxDetails, CloudSandboxError>;
  readonly resume: (sandboxId: string) => Effect.Effect<CloudSandboxDetails, CloudSandboxError>;
  readonly stop: (sandboxId: string) => Effect.Effect<CloudSandboxDetails, CloudSandboxError>;
  readonly delete: (sandboxId: string) => Effect.Effect<void, CloudSandboxError>;
  readonly registerSshKey: (
    sandboxId: string,
    publicKey: string,
  ) => Effect.Effect<
    { readonly target: DesktopSshEnvironmentTarget; readonly hostKey: string },
    CloudSandboxError
  >;
}

export function cloudSandboxCapabilities(driver: BaseCloudSandboxDriver) {
  return {
    diskForking: driver.forking !== undefined,
    desktopStreaming: driver.streaming !== undefined,
    browserStreaming: driver.streaming?.getBrowserStreamSession !== undefined,
    autoStopKeepalive: driver.keepalive !== undefined,
    publicPortHosting: driver.hosting !== undefined,
    protectedPortHosting: driver.hosting?.protectedAccess === true,
    recording: driver.recording !== undefined,
    usage: driver.usage !== undefined,
    resizeMode: driver.resizing?.mode ?? "none",
    hotResize: driver.resizing?.mode === "hot",
    rootAccess: driver.rootAccess,
  } satisfies CloudSandboxCapabilities;
}
