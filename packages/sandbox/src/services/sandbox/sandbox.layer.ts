import { posix as path } from "node:path";
import { loadEnv } from "@repo/config/env";
import type { Sandbox } from "@daytonaio/sdk";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { DaytonaClient, type CreateDaytonaClientError } from "../../client";
import {
  createJevinAiSnapshotImage,
  JEVIN_AI_SNAPSHOT_NAME,
  JEVIN_AI_SNAPSHOT_USER,
} from "../snapshot";
import {
  type CreateSandboxError,
  InvalidSandboxMountPathError,
  ManagedSandboxCreateError,
  ManagedSandboxDeleteError,
  ManagedSandboxLookupError,
  ManagedSandboxStartError,
  ManagedSandboxStopError,
  SandboxSnapshotLookupError,
} from "./sandbox.errors";
import {
  type CheckSandboxHealthOptions,
  type CreateSandboxOptions,
  type DeleteSandboxOptions,
  type ManagedSandboxHealthStatus,
  type ManagedSandboxLifecycleStatus,
  type SandboxHealthCheckResult,
  type SandboxOperationOptions,
  SandboxService,
  type SandboxServiceShape,
} from "./sandbox.service";

interface SnapshotSummary {
  readonly name: string;
}

interface SandboxClient {
  readonly create: (
    params: Record<string, unknown>,
    options?: {
      readonly timeout?: number;
    },
  ) => Promise<Sandbox>;
  readonly get: (sandboxIdOrName: string) => Promise<Sandbox>;
  readonly delete: (sandbox: Sandbox, timeout?: number) => Promise<void>;
  readonly snapshot: {
    readonly list: (
      page?: number,
      limit?: number,
    ) => Promise<{
      readonly items: ReadonlyArray<SnapshotSummary>;
    }>;
  };
}

export interface SandboxServiceOptions {
  readonly client: SandboxClient;
  readonly autoStopInterval: number;
  readonly defaultMountPath: string;
}

interface SandboxVolumeMount {
  readonly volumeId: string;
  readonly mountPath: string;
  readonly subpath?: string;
}

type SandboxCommandResult = Awaited<ReturnType<Sandbox["process"]["executeCommand"]>>;

type SandboxProbeOutcome =
  | {
      readonly ok: true;
      readonly result: SandboxCommandResult;
    }
  | {
      readonly ok: false;
      readonly cause: unknown;
    };

const DEFAULT_HEALTH_CHECK_TIMEOUT_SECONDS = 5;
const HEALTH_CHECK_SUCCESS_TOKEN = "__jevin_sandbox_healthcheck_ok__";

function isNonEmptyString(value: string | undefined): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function quoteShellArg(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function messageFromUnknown(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }

  if (typeof error === "string" && error.trim().length > 0) {
    return error;
  }

  return "An unknown sandbox error occurred.";
}

function buildSandboxHealthProbeCommand(mountPath: string): string {
  return `test -d ${quoteShellArg(mountPath)} && printf ${quoteShellArg(HEALTH_CHECK_SUCCESS_TOKEN)}`;
}

function mapSandboxStateToLifecycleStatus(
  state: string | undefined,
): ManagedSandboxLifecycleStatus {
  switch (state) {
    case "creating":
    case "restoring":
    case "pending_build":
    case "pulling_snapshot":
    case "building_snapshot":
    case "resizing":
      return "creating";
    case "starting":
      return "starting";
    case "started":
      return "ready";
    case "stopping":
    case "archiving":
      return "stopping";
    case "stopped":
    case "archived":
      return "stopped";
    case "destroyed":
    case "destroying":
    case "error":
    case "build_failed":
    case "unknown":
    default:
      return "error";
  }
}

function healthStatusForLifecycleStatus(
  lifecycleStatus: ManagedSandboxLifecycleStatus,
): ManagedSandboxHealthStatus {
  return lifecycleStatus === "error" ? "unhealthy" : "unknown";
}

function buildLifecycleResult(input: {
  readonly sandbox: Sandbox;
  readonly lifecycleStatus: ManagedSandboxLifecycleStatus;
  readonly healthStatus: ManagedSandboxHealthStatus;
  readonly message: string | null;
  readonly checkedAt: number;
}): SandboxHealthCheckResult {
  return {
    sandbox: input.sandbox,
    sandboxId: input.sandbox.id,
    lifecycleStatus: input.lifecycleStatus,
    healthStatus: input.healthStatus,
    daytonaState: input.sandbox.state ?? null,
    message: input.message,
    checkedAt: input.checkedAt,
  };
}

function describeProbeFailure(result: SandboxCommandResult): string {
  const output = result.result.trim();
  if (output.length > 0) {
    return output;
  }

  return `Sandbox health probe exited with code ${result.exitCode}.`;
}

export function validateSandboxMountPath(
  mountPath: string,
): Effect.Effect<string, InvalidSandboxMountPathError> {
  const trimmedPath = mountPath.trim();

  if (trimmedPath.length === 0) {
    return Effect.fail(
      new InvalidSandboxMountPathError({
        message: "Sandbox volume mount path must not be empty.",
        mountPath,
      }),
    );
  }

  if (!path.isAbsolute(trimmedPath)) {
    return Effect.fail(
      new InvalidSandboxMountPathError({
        message: `Sandbox volume mount path "${trimmedPath}" must be absolute.`,
        mountPath: trimmedPath,
      }),
    );
  }

  if (trimmedPath === "/") {
    return Effect.fail(
      new InvalidSandboxMountPathError({
        message: 'Sandbox volume mount path "/" is not allowed.',
        mountPath: trimmedPath,
      }),
    );
  }

  if (
    trimmedPath.includes("//") ||
    trimmedPath.includes("/./") ||
    trimmedPath.includes("/../") ||
    trimmedPath.endsWith("/.") ||
    trimmedPath.endsWith("/..")
  ) {
    return Effect.fail(
      new InvalidSandboxMountPathError({
        message: `Sandbox volume mount path "${trimmedPath}" contains unsupported path segments.`,
        mountPath: trimmedPath,
      }),
    );
  }

  return Effect.succeed(trimmedPath);
}

export function resolveSandboxVolumeMount(
  options: CreateSandboxOptions,
  defaultMountPath: string,
): Effect.Effect<SandboxVolumeMount | undefined, InvalidSandboxMountPathError> {
  if (!options.volume) {
    return Effect.succeed(undefined);
  }

  const volumeId = options.volume.volumeId.trim();

  if (volumeId.length === 0) {
    return Effect.fail(
      new InvalidSandboxMountPathError({
        message: "Sandbox volumeId must not be empty.",
        mountPath: options.volume.mountPath ?? defaultMountPath,
      }),
    );
  }

  const requestedMountPath = options.volume.mountPath ?? defaultMountPath;

  return validateSandboxMountPath(requestedMountPath).pipe(
    Effect.map((mountPath) => {
      const subpath = options.volume?.subpath?.trim();

      if (isNonEmptyString(subpath)) {
        return {
          volumeId,
          mountPath,
          subpath,
        } satisfies SandboxVolumeMount;
      }

      return {
        volumeId,
        mountPath,
      } satisfies SandboxVolumeMount;
    }),
  );
}

function hasJevinAiSnapshot(
  client: SandboxClient,
): Effect.Effect<boolean, SandboxSnapshotLookupError> {
  return Effect.tryPromise({
    try: () => client.snapshot.list(1, 200),
    catch: (cause) =>
      new SandboxSnapshotLookupError({
        message: `Failed to list Daytona snapshots while checking for "${JEVIN_AI_SNAPSHOT_NAME}".`,
        snapshotName: JEVIN_AI_SNAPSHOT_NAME,
        cause,
      }),
  }).pipe(
    Effect.map((result) =>
      result.items.some((snapshot) => snapshot.name === JEVIN_AI_SNAPSHOT_NAME),
    ),
  );
}

export function buildSandboxCreateParams(
  options: CreateSandboxOptions,
  resolvedVolume: SandboxVolumeMount | undefined,
  defaultAutoStopInterval: number,
  useSnapshot: boolean,
): Record<string, unknown> {
  const baseParams: Record<string, unknown> = {
    name: options.sandboxName,
    user: JEVIN_AI_SNAPSHOT_USER,
    envVars: options.envVars,
    labels: {
      app: "jevin-ai",
      ...(options.labels ?? {}),
    },
    public: options.public,
    autoStopInterval: options.autoStopInterval ?? defaultAutoStopInterval,
    autoArchiveInterval: options.autoArchiveInterval,
    autoDeleteInterval: options.autoDeleteInterval,
    volumes: resolvedVolume ? [resolvedVolume] : undefined,
    networkBlockAll: options.networkBlockAll,
    networkAllowList: options.networkAllowList,
    ephemeral: options.ephemeral ?? false,
  };

  if (useSnapshot) {
    return {
      ...baseParams,
      snapshot: JEVIN_AI_SNAPSHOT_NAME,
    };
  }

  return {
    ...baseParams,
    image: createJevinAiSnapshotImage(),
  };
}

function createSandbox(
  client: SandboxClient,
  sandboxOptions: SandboxServiceOptions,
  options: CreateSandboxOptions,
): Effect.Effect<Sandbox, CreateSandboxError> {
  return Effect.gen(function* () {
    const resolvedVolume = yield* resolveSandboxVolumeMount(
      options,
      sandboxOptions.defaultMountPath,
    );
    const snapshotExists = yield* hasJevinAiSnapshot(client);
    const params = buildSandboxCreateParams(
      options,
      resolvedVolume,
      sandboxOptions.autoStopInterval,
      snapshotExists,
    );

    return yield* Effect.tryPromise({
      try: () =>
        client.create(params, {
          timeout: options.timeoutSeconds,
        }),
      catch: (cause) =>
        new ManagedSandboxCreateError({
          message: "Failed to create the Daytona sandbox.",
          cause,
        }),
    });
  });
}

function getSandbox(
  client: SandboxClient,
  sandboxId: string,
): Effect.Effect<Sandbox, ManagedSandboxLookupError> {
  return Effect.tryPromise({
    try: () => client.get(sandboxId),
    catch: (cause) =>
      new ManagedSandboxLookupError({
        message: `Failed to find Daytona sandbox ${sandboxId}.`,
        sandboxId,
        cause,
      }),
  });
}

function resolveSandbox(
  client: SandboxClient,
  target: Sandbox | string,
): Effect.Effect<Sandbox, ManagedSandboxLookupError> {
  return typeof target === "string" ? getSandbox(client, target) : Effect.succeed(target);
}

function refreshSandboxData(sandbox: Sandbox): Effect.Effect<Sandbox> {
  return Effect.tryPromise({
    try: () => sandbox.refreshData(),
    catch: () => null,
  }).pipe(
    Effect.matchEffect({
      onFailure: () => Effect.succeed(sandbox),
      onSuccess: () => Effect.succeed(sandbox),
    }),
  );
}

function startSandbox(
  client: SandboxClient,
  target: Sandbox | string,
  options: SandboxOperationOptions = {},
): Effect.Effect<Sandbox, ManagedSandboxLookupError | ManagedSandboxStartError> {
  return Effect.gen(function* () {
    const sandbox = yield* resolveSandbox(client, target);

    if (sandbox.state === "started") {
      return sandbox;
    }

    yield* Effect.tryPromise({
      try: () => sandbox.start(options.timeoutSeconds),
      catch: (cause) =>
        new ManagedSandboxStartError({
          message: `Failed to start Daytona sandbox ${sandbox.id}.`,
          sandboxId: sandbox.id,
          cause,
        }),
    });

    return yield* refreshSandboxData(sandbox);
  });
}

function stopSandbox(
  client: SandboxClient,
  target: Sandbox | string,
  options: SandboxOperationOptions = {},
): Effect.Effect<Sandbox, ManagedSandboxLookupError | ManagedSandboxStopError> {
  return Effect.gen(function* () {
    const sandbox = yield* resolveSandbox(client, target);

    if (
      sandbox.state === "stopped" ||
      sandbox.state === "destroyed" ||
      sandbox.state === "archived"
    ) {
      return sandbox;
    }

    yield* Effect.tryPromise({
      try: () => sandbox.stop(options.timeoutSeconds),
      catch: (cause) =>
        new ManagedSandboxStopError({
          message: `Failed to stop Daytona sandbox ${sandbox.id}.`,
          sandboxId: sandbox.id,
          cause,
        }),
    });

    return yield* refreshSandboxData(sandbox);
  });
}

function runSandboxHealthProbe(
  sandbox: Sandbox,
  mountPath: string,
  timeoutSeconds: number,
): Effect.Effect<SandboxProbeOutcome> {
  return Effect.tryPromise({
    try: () =>
      sandbox.process.executeCommand(
        buildSandboxHealthProbeCommand(mountPath),
        mountPath,
        undefined,
        timeoutSeconds,
      ),
    catch: (cause) => cause,
  }).pipe(
    Effect.match({
      onFailure: (cause): SandboxProbeOutcome => ({
        ok: false,
        cause,
      }),
      onSuccess: (result): SandboxProbeOutcome => ({
        ok: true,
        result,
      }),
    }),
  );
}

function checkSandboxHealth(
  client: SandboxClient,
  target: Sandbox | string,
  defaultMountPath: string,
  options: CheckSandboxHealthOptions = {},
): Effect.Effect<SandboxHealthCheckResult, ManagedSandboxLookupError> {
  return Effect.gen(function* () {
    const sandbox = yield* resolveSandbox(client, target);
    const checkedAt = Date.now();
    const lifecycleStatus = mapSandboxStateToLifecycleStatus(sandbox.state);

    if (sandbox.state !== "started") {
      const message =
        lifecycleStatus === "error"
          ? (sandbox.errorReason ??
            `Daytona reported sandbox ${sandbox.id} as ${sandbox.state ?? "unknown"}.`)
          : null;

      return buildLifecycleResult({
        sandbox,
        lifecycleStatus,
        healthStatus: healthStatusForLifecycleStatus(lifecycleStatus),
        message,
        checkedAt,
      });
    }

    const probe = yield* runSandboxHealthProbe(
      sandbox,
      defaultMountPath,
      options.timeoutSeconds ?? DEFAULT_HEALTH_CHECK_TIMEOUT_SECONDS,
    );

    if (!probe.ok) {
      return buildLifecycleResult({
        sandbox,
        lifecycleStatus: "error",
        healthStatus: "unhealthy",
        message: `Failed to run sandbox health probe: ${messageFromUnknown(probe.cause)}`,
        checkedAt,
      });
    }

    if (probe.result.exitCode !== 0 || !probe.result.result.includes(HEALTH_CHECK_SUCCESS_TOKEN)) {
      return buildLifecycleResult({
        sandbox,
        lifecycleStatus: "error",
        healthStatus: "unhealthy",
        message: describeProbeFailure(probe.result),
        checkedAt,
      });
    }

    return buildLifecycleResult({
      sandbox,
      lifecycleStatus: "ready",
      healthStatus: "healthy",
      message: null,
      checkedAt,
    });
  });
}

function deleteSandbox(
  client: SandboxClient,
  target: Sandbox | string,
  options: DeleteSandboxOptions = {},
): Effect.Effect<void, ManagedSandboxDeleteError | ManagedSandboxLookupError> {
  return Effect.gen(function* () {
    const sandbox = typeof target === "string" ? yield* getSandbox(client, target) : target;

    return yield* Effect.tryPromise({
      try: () => client.delete(sandbox, options.timeoutSeconds),
      catch: (cause) =>
        new ManagedSandboxDeleteError({
          message: `Failed to delete Daytona sandbox ${sandbox.id}.`,
          sandboxId: sandbox.id,
          cause,
        }),
    });
  });
}

export function makeSandboxService(options: SandboxServiceOptions): SandboxServiceShape {
  return {
    createSandbox(createOptions: CreateSandboxOptions = {}) {
      return createSandbox(options.client, options, createOptions);
    },
    getSandbox(sandboxId) {
      return getSandbox(options.client, sandboxId);
    },
    deleteSandbox(target, deleteOptions) {
      return deleteSandbox(options.client, target, deleteOptions);
    },
    startSandbox(target, operationOptions) {
      return startSandbox(options.client, target, operationOptions);
    },
    stopSandbox(target, operationOptions) {
      return stopSandbox(options.client, target, operationOptions);
    },
    checkSandboxHealth(target, healthOptions) {
      return checkSandboxHealth(options.client, target, options.defaultMountPath, healthOptions);
    },
  } satisfies SandboxServiceShape;
}

export function makeSandboxServiceLayer(): Layer.Layer<
  SandboxService,
  CreateDaytonaClientError,
  DaytonaClient
> {
  return Layer.effect(
    SandboxService,
    Effect.gen(function* () {
      const env = yield* loadEnv();
      const daytonaClient = yield* DaytonaClient;

      return makeSandboxService({
        client: daytonaClient.client,
        autoStopInterval: env.DAYTONA_AUTO_STOP_INTERVAL,
        defaultMountPath: env.DAYTONA_ORG_VOLUME_MOUNT_PATH,
      });
    }),
  );
}

export const SandboxServiceLive = makeSandboxServiceLayer;
