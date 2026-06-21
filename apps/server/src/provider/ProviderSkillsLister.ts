import {
  CodexSettings,
  ServerProviderSkillsListError,
  type ProviderInstanceId,
  type ServerProviderSkillsListFailureReason,
  type ServerProviderSkillsListResult,
} from "@t3tools/contracts";
import * as Cache from "effect/Cache";
import * as Cause from "effect/Cause";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { ChildProcessSpawner } from "effect/unstable/process";

import {
  CodexShadowHomeEntryConflictError,
  CodexShadowHomeFileSystemError,
  CodexShadowHomePathConflictError,
  CodexShadowHomePrivateEntrySymlinkError,
  materializeCodexShadowHome,
  resolveCodexHomeLayout,
} from "./Drivers/CodexHomeLayout.ts";
import { listCodexProviderSkills } from "./Layers/CodexProvider.ts";
import { deriveProviderInstanceConfigMap } from "./Layers/ProviderInstanceRegistryHydration.ts";
import { mergeProviderInstanceEnvironment } from "./ProviderInstanceEnvironment.ts";
import { ProviderRegistry } from "./Services/ProviderRegistry.ts";
import { sanitizeErrorCause } from "../diagnostics/ErrorCause.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import {
  WorkspacePaths,
  WorkspaceRootCreateFailedError,
  WorkspaceRootNotDirectoryError,
  WorkspaceRootNotExistsError,
  WorkspaceRootStatFailedError,
} from "../workspace/WorkspacePaths.ts";

const CODEX_SKILL_LIST_TIMEOUT = Duration.seconds(15);
const PROVIDER_SKILLS_CACHE_CAPACITY = 64;
const PROVIDER_SKILLS_CACHE_TTL = Duration.seconds(1);
const PROVIDER_SKILLS_MAX_CONCURRENCY = 4;
const decodeCodexSettings = Schema.decodeUnknownEffect(CodexSettings);
const isWorkspaceRootNotExistsError = Schema.is(WorkspaceRootNotExistsError);
const isWorkspaceRootNotDirectoryError = Schema.is(WorkspaceRootNotDirectoryError);
const isWorkspaceRootCreateFailedError = Schema.is(WorkspaceRootCreateFailedError);
const isWorkspaceRootStatFailedError = Schema.is(WorkspaceRootStatFailedError);
const isCodexShadowHomePathConflictError = Schema.is(CodexShadowHomePathConflictError);
const isCodexShadowHomeEntryConflictError = Schema.is(CodexShadowHomeEntryConflictError);
const isCodexShadowHomePrivateEntrySymlinkError = Schema.is(
  CodexShadowHomePrivateEntrySymlinkError,
);
const isCodexShadowHomeFileSystemError = Schema.is(CodexShadowHomeFileSystemError);

export interface ProviderSkillsListInput {
  readonly instanceId: ProviderInstanceId;
  readonly cwd: string;
}

export interface BoundedRequestCache<Key, A, E> {
  readonly get: (key: Key) => Effect.Effect<A, E>;
}

export const makeBoundedRequestCache = Effect.fn("makeBoundedRequestCache")(function* <
  Key,
  A,
  E,
  R,
>(options: {
  readonly capacity: number;
  readonly concurrency: number;
  readonly timeToLive: Duration.Input;
  readonly lookup: (key: Key) => Effect.Effect<A, E, R>;
}): Effect.fn.Return<BoundedRequestCache<Key, A, E>, never, R> {
  const semaphore = yield* Semaphore.make(options.concurrency);
  const cache = yield* Cache.make({
    capacity: options.capacity,
    timeToLive: options.timeToLive,
    lookup: (key: Key) => semaphore.withPermits(1)(options.lookup(key)),
  });
  return {
    get: (key) => Cache.get(cache, key),
  };
});

function optionalTrimmedNonEmptyString(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? value : undefined;
}

function providerSkillsListError(input: {
  readonly reason: ServerProviderSkillsListFailureReason;
  readonly operation: string;
  readonly message: string;
  readonly detail?: string | undefined;
  readonly instanceId?: ProviderInstanceId | undefined;
  readonly cwd?: string | undefined;
  readonly cause?: unknown;
}) {
  const cwd = optionalTrimmedNonEmptyString(input.cwd);
  return new ServerProviderSkillsListError({
    reason: input.reason,
    operation: input.operation,
    message: input.message,
    ...(input.detail === undefined ? {} : { detail: input.detail }),
    ...(input.instanceId === undefined ? {} : { instanceId: input.instanceId }),
    ...(cwd === undefined ? {} : { cwd }),
    ...(input.cause === undefined ? {} : { cause: sanitizeErrorCause(input.cause) }),
  });
}

function workspaceCwdFailureDetail(cause: unknown): string {
  if (isWorkspaceRootNotExistsError(cause)) {
    return `Workspace root does not exist: ${cause.normalizedWorkspaceRoot}.`;
  }
  if (isWorkspaceRootNotDirectoryError(cause)) {
    return `Workspace root is not a directory: ${cause.normalizedWorkspaceRoot}.`;
  }
  if (isWorkspaceRootCreateFailedError(cause)) {
    return `Failed to create workspace root: ${cause.normalizedWorkspaceRoot}.`;
  }
  if (isWorkspaceRootStatFailedError(cause)) {
    return `Failed to stat workspace root '${cause.normalizedWorkspaceRoot}' during '${cause.phase}'.`;
  }
  return "Check the requested workspace path and filesystem permissions.";
}

function codexHomePrepareFailureDetail(cause: unknown): string {
  if (isCodexShadowHomePathConflictError(cause)) {
    return `Codex shadow home path '${cause.effectiveHomePath}' must be different from shared home path '${cause.sharedHomePath}'.`;
  }
  if (isCodexShadowHomeEntryConflictError(cause)) {
    return `Codex shadow home entry '${cause.entryName}' already exists and is not a symlink.`;
  }
  if (isCodexShadowHomePrivateEntrySymlinkError(cause)) {
    return `Codex shadow home private entry '${cause.entryName}' must be a real file.`;
  }
  if (isCodexShadowHomeFileSystemError(cause)) {
    return `Codex shadow home filesystem operation '${cause.operation}' failed for '${cause.path}'.`;
  }
  return "Check the configured Codex home paths and filesystem permissions.";
}

function codexSkillListFailure(input: {
  readonly cause: unknown;
  readonly instanceId: ProviderInstanceId;
  readonly cwd: string;
}) {
  if (Cause.isTimeoutError(input.cause)) {
    return providerSkillsListError({
      reason: "probe-timeout",
      operation: "ProviderSkillsLister.listCodexProviderSkills",
      instanceId: input.instanceId,
      cwd: input.cwd,
      message: `Timed out listing Codex skills after ${Duration.toSeconds(CODEX_SKILL_LIST_TIMEOUT)}s (provider: '${input.instanceId}', cwd: '${input.cwd}').`,
      cause: input.cause,
    });
  }
  return providerSkillsListError({
    reason: "probe-failed",
    operation: "ProviderSkillsLister.listCodexProviderSkills",
    instanceId: input.instanceId,
    cwd: input.cwd,
    message: `Failed to list Codex skills (provider: '${input.instanceId}', cwd: '${input.cwd}').`,
    cause: input.cause,
  });
}

export const listCodexProviderSkillsWithTimeout = Effect.fn("listCodexProviderSkillsWithTimeout")(
  function* (input: {
    readonly instanceId: ProviderInstanceId;
    readonly binaryPath: string;
    readonly homePath?: string;
    readonly cwd: string;
    readonly environment: NodeJS.ProcessEnv;
  }) {
    return yield* listCodexProviderSkills({
      binaryPath: input.binaryPath,
      ...(input.homePath ? { homePath: input.homePath } : {}),
      cwd: input.cwd,
      environment: input.environment,
    }).pipe(
      Effect.scoped,
      Effect.timeout(CODEX_SKILL_LIST_TIMEOUT),
      Effect.mapError((cause) =>
        codexSkillListFailure({
          cause,
          instanceId: input.instanceId,
          cwd: input.cwd,
        }),
      ),
    );
  },
);

function requestKey(input: ProviderSkillsListInput): string {
  return JSON.stringify([input.instanceId, input.cwd]);
}

function parseRequestKey(key: string): ProviderSkillsListInput {
  const [instanceId, cwd] = JSON.parse(key) as [ProviderInstanceId, string];
  return { instanceId, cwd };
}

export const makeProviderSkillsLister = Effect.fn("makeProviderSkillsLister")(function* () {
  const providerRegistry = yield* ProviderRegistry;
  const serverSettings = yield* ServerSettingsService;
  const workspacePaths = yield* WorkspacePaths;
  const childProcessSpawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;

  const listUncached = Effect.fn("ProviderSkillsLister.listUncached")(function* (
    input: ProviderSkillsListInput,
  ): Effect.fn.Return<ServerProviderSkillsListResult, ServerProviderSkillsListError> {
    const providers = yield* providerRegistry.getProviders;
    const snapshot = providers.find((provider) => provider.instanceId === input.instanceId);
    if (!snapshot) {
      return yield* providerSkillsListError({
        reason: "provider-not-found",
        operation: "ProviderSkillsLister.list",
        instanceId: input.instanceId,
        cwd: input.cwd,
        message: `Provider instance '${input.instanceId}' was not found.`,
      });
    }
    if (snapshot.driver !== "codex") {
      return { skills: snapshot.skills };
    }

    const settings = yield* serverSettings.getSettings.pipe(
      Effect.mapError((cause) =>
        providerSkillsListError({
          reason: "settings-read-failed",
          operation: "ProviderSkillsLister.readSettings",
          instanceId: input.instanceId,
          cwd: input.cwd,
          message: "Failed to read provider settings.",
          cause,
        }),
      ),
    );
    const instanceConfig = deriveProviderInstanceConfigMap(settings)[input.instanceId];
    if (!instanceConfig || instanceConfig.driver !== "codex") {
      return yield* providerSkillsListError({
        reason: "provider-not-configured",
        operation: "ProviderSkillsLister.resolveCodexInstance",
        instanceId: input.instanceId,
        cwd: input.cwd,
        message: `Codex provider instance '${input.instanceId}' is not configured.`,
      });
    }

    const decodedConfig = yield* decodeCodexSettings(instanceConfig.config ?? {}).pipe(
      Effect.mapError((cause) =>
        providerSkillsListError({
          reason: "settings-decode-failed",
          operation: "ProviderSkillsLister.decodeCodexSettings",
          instanceId: input.instanceId,
          cwd: input.cwd,
          message: `Failed to decode Codex provider settings for '${input.instanceId}'.`,
          cause,
        }),
      ),
    );
    const effectiveConfig = {
      ...decodedConfig,
      enabled: instanceConfig.enabled ?? decodedConfig.enabled,
    };
    if (!effectiveConfig.enabled) {
      return { skills: snapshot.skills };
    }

    const normalizedCwd = yield* workspacePaths.normalizeWorkspaceRoot(input.cwd).pipe(
      Effect.mapError((cause) =>
        providerSkillsListError({
          reason: "invalid-cwd",
          operation: "ProviderSkillsLister.normalizeCwd",
          instanceId: input.instanceId,
          cwd: input.cwd,
          message: `Invalid Codex skills cwd '${input.cwd}'.`,
          detail: workspaceCwdFailureDetail(cause),
          cause,
        }),
      ),
    );
    const homeLayout = yield* resolveCodexHomeLayout(effectiveConfig).pipe(
      Effect.provideService(Path.Path, path),
    );
    yield* materializeCodexShadowHome(homeLayout).pipe(
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
      Effect.mapError((cause) =>
        providerSkillsListError({
          reason: "home-prepare-failed",
          operation: "ProviderSkillsLister.prepareCodexHome",
          instanceId: input.instanceId,
          cwd: input.cwd,
          message: `Failed to prepare Codex home for '${input.instanceId}'.`,
          detail: codexHomePrepareFailureDetail(cause),
          cause,
        }),
      ),
    );
    const skills = yield* listCodexProviderSkillsWithTimeout({
      instanceId: input.instanceId,
      binaryPath: effectiveConfig.binaryPath,
      ...(homeLayout.effectiveHomePath ? { homePath: homeLayout.effectiveHomePath } : {}),
      cwd: normalizedCwd,
      environment: mergeProviderInstanceEnvironment(instanceConfig.environment ?? []),
    }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, childProcessSpawner));
    return { skills };
  });

  const requests = yield* makeBoundedRequestCache({
    capacity: PROVIDER_SKILLS_CACHE_CAPACITY,
    concurrency: PROVIDER_SKILLS_MAX_CONCURRENCY,
    timeToLive: PROVIDER_SKILLS_CACHE_TTL,
    lookup: (key: string) => listUncached(parseRequestKey(key)),
  });

  return Effect.fn("ProviderSkillsLister.list")(function* (input: ProviderSkillsListInput) {
    return yield* requests.get(requestKey(input));
  });
});
