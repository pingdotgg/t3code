import type {
  SandboxProviderAvailability,
  SandboxProviderKind,
  SandboxState,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { SandboxError } from "./errors.ts";

export interface SandboxCreateInput {
  readonly name: string;
  readonly snapshotId?: string | undefined;
  readonly idleTimeoutMinutes: number;
  readonly port: number;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly gitToken?: string | undefined;
}

export interface SandboxCreateResult {
  readonly providerSandboxId: string;
  readonly state: SandboxState;
  readonly connectionUrl?: string | undefined;
  readonly snapshotId?: string | undefined;
}

export interface SandboxExecInput {
  readonly providerSandboxId: string;
  readonly command: string;
  readonly cwd?: string | undefined;
  readonly env?: Readonly<Record<string, string>> | undefined;
  readonly detached?: boolean | undefined;
}

export interface SandboxExecResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface SandboxSnapshotInput {
  readonly providerSandboxId: string;
  readonly name: string;
}

export interface SandboxSnapshotResult {
  readonly snapshotId: string;
  readonly stoppedAfterSnapshot: boolean;
}

export interface SandboxPauseOrStopResult {
  readonly state: "paused" | "stopped";
  readonly snapshotId?: string | undefined;
}

export interface SandboxResumeResult {
  readonly providerSandboxId: string;
  readonly state: SandboxState;
  readonly connectionUrl?: string | undefined;
}

export interface SandboxStatusResult {
  readonly providerSandboxId: string;
  readonly state: SandboxState;
  readonly snapshotId?: string | undefined;
  readonly expiresAt?: string | undefined;
}

export class SandboxProvider extends Context.Service<
  SandboxProvider,
  {
    readonly kind: SandboxProviderKind;
    readonly create: (
      input: SandboxCreateInput,
    ) => Effect.Effect<SandboxCreateResult, SandboxError>;
    readonly exec: (input: SandboxExecInput) => Effect.Effect<SandboxExecResult, SandboxError>;
    readonly snapshot: (
      input: SandboxSnapshotInput,
    ) => Effect.Effect<SandboxSnapshotResult, SandboxError>;
    readonly pauseOrStop: (
      providerSandboxId: string,
    ) => Effect.Effect<SandboxPauseOrStopResult, SandboxError>;
    readonly resume: (
      providerSandboxId: string,
      options?: { readonly port?: number | undefined },
    ) => Effect.Effect<SandboxResumeResult, SandboxError>;
    readonly getStatus: (
      providerSandboxId: string,
    ) => Effect.Effect<SandboxStatusResult, SandboxError>;
    readonly destroy: (providerSandboxId: string) => Effect.Effect<void, SandboxError>;
    readonly getPublicUrl: (
      providerSandboxId: string,
      port: number,
    ) => Effect.Effect<string | null, SandboxError>;
  }
>()("@t3tools/sandbox-providers/SandboxProvider") {}

export interface SandboxProviderRegistration {
  readonly provider: SandboxProviderKind;
  readonly driver: SandboxProvider["Service"] | null;
  readonly defaultSnapshotId: string | null;
  readonly unconfiguredReason?: string | undefined;
}

export class SandboxProviderRegistry extends Context.Service<
  SandboxProviderRegistry,
  {
    readonly get: (
      provider: SandboxProviderKind,
    ) => Effect.Effect<SandboxProvider["Service"], SandboxError>;
    readonly listAvailability: () => Effect.Effect<ReadonlyArray<SandboxProviderAvailability>>;
    readonly defaultSnapshotFor: (provider: SandboxProviderKind) => string | null;
  }
>()("@t3tools/sandbox-providers/SandboxProvider/SandboxProviderRegistry") {}

function makeSandboxProviderRegistry(
  registrations: ReadonlyArray<SandboxProviderRegistration>,
): SandboxProviderRegistry["Service"] {
  const byKind = new Map<SandboxProviderKind, SandboxProviderRegistration>(
    registrations.map((entry) => [entry.provider, entry]),
  );

  return SandboxProviderRegistry.of({
    get: Effect.fn("SandboxProviderRegistry.get")(function* (provider) {
      const registration = byKind.get(provider);
      if (registration === undefined || registration.driver === null) {
        return yield* new SandboxError({
          provider,
          operation: "create",
          category: "unconfigured",
        });
      }
      return registration.driver;
    }),
    listAvailability: Effect.fn("SandboxProviderRegistry.listAvailability")(() =>
      Effect.succeed(
        registrations.map((entry) => ({
          provider: entry.provider,
          configured: entry.driver !== null,
          defaultSnapshotId: entry.defaultSnapshotId,
          ...(entry.driver === null && entry.unconfiguredReason !== undefined
            ? { reason: entry.unconfiguredReason }
            : {}),
        })),
      ),
    ),
    defaultSnapshotFor: (provider) => byKind.get(provider)?.defaultSnapshotId ?? null,
  });
}

export function layerSandboxProviderRegistry(
  registrations: ReadonlyArray<SandboxProviderRegistration>,
): Layer.Layer<SandboxProviderRegistry> {
  return Layer.succeed(SandboxProviderRegistry, makeSandboxProviderRegistry(registrations));
}
