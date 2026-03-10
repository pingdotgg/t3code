import type { Sandbox } from "@daytonaio/sdk";
import type * as Effect from "effect/Effect";
import * as ServiceMap from "effect/ServiceMap";

import type {
  CreateSandboxError,
  DeleteSandboxError,
  ManagedSandboxLookupError,
  StartSandboxError,
  StopSandboxError,
} from "./sandbox.errors";

export interface SandboxVolumeMountOptions {
  readonly volumeId: string;
  readonly mountPath?: string;
  readonly subpath?: string;
}

export interface CreateSandboxOptions {
  readonly sandboxName?: string;
  readonly labels?: Record<string, string>;
  readonly envVars?: Record<string, string>;
  readonly autoStopInterval?: number;
  readonly autoArchiveInterval?: number;
  readonly autoDeleteInterval?: number;
  readonly ephemeral?: boolean;
  readonly public?: boolean;
  readonly networkBlockAll?: boolean;
  readonly networkAllowList?: string;
  readonly timeoutSeconds?: number;
  readonly volume?: SandboxVolumeMountOptions;
}

export interface DeleteSandboxOptions {
  readonly timeoutSeconds?: number;
}

export interface SandboxOperationOptions {
  readonly timeoutSeconds?: number;
}

export interface CheckSandboxHealthOptions {
  readonly timeoutSeconds?: number;
}

export type ManagedSandboxLifecycleStatus =
  | "creating"
  | "starting"
  | "ready"
  | "stopping"
  | "stopped"
  | "error";

export type ManagedSandboxHealthStatus = "unknown" | "healthy" | "unhealthy";

export interface SandboxHealthCheckResult {
  readonly sandbox: Sandbox;
  readonly sandboxId: string;
  readonly lifecycleStatus: ManagedSandboxLifecycleStatus;
  readonly healthStatus: ManagedSandboxHealthStatus;
  readonly daytonaState: string | null;
  readonly message: string | null;
  readonly checkedAt: number;
}

export interface SandboxServiceShape {
  readonly createSandbox: (
    options?: CreateSandboxOptions,
  ) => Effect.Effect<Sandbox, CreateSandboxError>;
  readonly getSandbox: (sandboxId: string) => Effect.Effect<Sandbox, ManagedSandboxLookupError>;
  readonly deleteSandbox: (
    sandbox: Sandbox | string,
    options?: DeleteSandboxOptions,
  ) => Effect.Effect<void, DeleteSandboxError>;
  readonly startSandbox: (
    sandbox: Sandbox | string,
    options?: SandboxOperationOptions,
  ) => Effect.Effect<Sandbox, StartSandboxError>;
  readonly stopSandbox: (
    sandbox: Sandbox | string,
    options?: SandboxOperationOptions,
  ) => Effect.Effect<Sandbox, StopSandboxError>;
  readonly checkSandboxHealth: (
    sandbox: Sandbox | string,
    options?: CheckSandboxHealthOptions,
  ) => Effect.Effect<SandboxHealthCheckResult, ManagedSandboxLookupError>;
}

export class SandboxService extends ServiceMap.Service<SandboxService, SandboxServiceShape>()(
  "@repo/sandbox/services/sandbox/SandboxService",
) {}
