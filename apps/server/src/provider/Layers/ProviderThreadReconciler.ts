// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";

import {
  CommandId,
  DEFAULT_MODEL_BY_PROVIDER,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import { normalizeProjectPathForComparison } from "@t3tools/shared/path";

import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ServerConfig } from "../../config.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import type { ProviderPersistedThread } from "../Services/ProviderAdapter.ts";

const CODEX = ProviderDriverKind.make("codex");
const UNASSIGNED_CODEX_PROJECT_ID = ProjectId.make("codex-unassigned-threads");
const UNASSIGNED_CODEX_PROJECT_TITLE = "Unassigned Codex threads";
const UNASSIGNED_CODEX_DIRECTORY = "unassigned-codex-threads";
const ResumeCursor = Schema.Struct({ threadId: Schema.String });
const isResumeCursor = Schema.is(ResumeCursor);
const ImportedRuntimePayload = Schema.Struct({
  continuationKey: Schema.optional(Schema.String),
  cwd: Schema.optional(Schema.String),
  providerUpdatedAt: Schema.optional(Schema.String),
  providerDiscoveryCursor: Schema.optional(Schema.String),
});
const isImportedRuntimePayload = Schema.is(ImportedRuntimePayload);

export function continuationIdentityDigest(continuationKey: string): string {
  return NodeCrypto.createHash("sha256").update(continuationKey).digest("hex").slice(0, 24);
}

function diagnosticErrorType(cause: unknown): string {
  if (cause instanceof Error) return cause.name;
  if (typeof cause === "object" && cause !== null && "_tag" in cause) {
    return String(cause._tag);
  }
  return typeof cause;
}

export function recoverReconciliationCause<A, E>(
  cause: Cause.Cause<E>,
  message: string,
  annotations: Record<string, unknown>,
  fallback: A,
): Effect.Effect<A, E> {
  return Cause.hasInterrupts(cause)
    ? Effect.failCause(cause)
    : Effect.logWarning(message, annotations).pipe(Effect.as(fallback));
}

export function resolvePersistedContinuationKey(
  providerInstanceId: string,
  runtimePayload: unknown,
  continuationKeyByInstanceId: ReadonlyMap<string, string>,
): string | undefined {
  return (
    (isImportedRuntimePayload(runtimePayload) ? runtimePayload.continuationKey : undefined) ??
    continuationKeyByInstanceId.get(providerInstanceId)
  );
}

export function providerThreadDiscoveryExclusions(
  unresolvedNativeProviderThreadIds: ReadonlySet<string>,
  continuationProviderThreadIds: ReadonlySet<string> | undefined,
): ReadonlySet<string> {
  return new Set([...unresolvedNativeProviderThreadIds, ...(continuationProviderThreadIds ?? [])]);
}

function providerIdentityKey(continuationKey: string, providerThreadId: string): string {
  return `${continuationKey.length}:${continuationKey}${providerThreadId}`;
}

function importedThreadIdFor(continuationKey: string, providerThreadId: string): ThreadId {
  return ThreadId.make(
    `imported:${continuationIdentityDigest(continuationKey)}:${providerThreadId}`,
  );
}

function importedThreadId(instance: ProviderInstance, providerThreadId: string): ThreadId {
  return importedThreadIdFor(instance.continuationIdentity.continuationKey, providerThreadId);
}

function importCommandId(...parts: ReadonlyArray<string>): CommandId {
  return CommandId.make(`provider-import:${parts.join(":")}`);
}

function importedMessageId(
  continuationKey: string,
  providerThreadId: string,
  providerMessageId: string,
  sourceOrdinal: number,
): MessageId {
  const orderedOrdinal = String(sourceOrdinal).padStart(10, "0");
  return MessageId.make(
    `provider:${continuationIdentityDigest(continuationKey)}:${providerThreadId}:message:${orderedOrdinal}:${providerMessageId}`,
  );
}

function providerThreadMetadataEqual(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

export function groupPersistedThreadDiscoveryCandidates(
  instances: ReadonlyArray<ProviderInstance>,
): ReadonlyArray<ReadonlyArray<ProviderInstance>> {
  const candidatesByContinuationKey = new Map<string, ProviderInstance[]>();
  const discoverable = instances
    .filter(
      (instance) =>
        instance.enabled &&
        instance.driverKind === CODEX &&
        instance.adapter.discoverPersistedThreads !== undefined,
    )
    .sort((left, right) => left.instanceId.localeCompare(right.instanceId));
  for (const instance of discoverable) {
    const continuationKey = instance.continuationIdentity.continuationKey;
    const candidates = candidatesByContinuationKey.get(continuationKey) ?? [];
    candidates.push(instance);
    candidatesByContinuationKey.set(continuationKey, candidates);
  }
  return Array.from(candidatesByContinuationKey.entries())
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, candidates]) => candidates);
}

export const reconcilePersistedProviderThreads = Effect.fn("reconcilePersistedProviderThreads")(
  function* () {
    const registry = yield* ProviderInstanceRegistry;
    const directory = yield* ProviderSessionDirectory;
    const snapshots = yield* ProjectionSnapshotQuery;
    const engine = yield* OrchestrationEngineService;
    const config = yield* ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const instances = yield* registry.listInstances;
    const bindings = yield* directory.listBindings();
    const shellSnapshot = yield* snapshots.getShellSnapshot();
    const unassignedWorkspaceRoot = path.join(config.stateDir, UNASSIGNED_CODEX_DIRECTORY);
    const unassignedProjectReady = yield* Ref.make(
      shellSnapshot.projects.some((project) => project.id === UNASSIGNED_CODEX_PROJECT_ID),
    );
    const unassignedProjectSemaphore = yield* Semaphore.make(1);
    const ensureUnassignedProject = unassignedProjectSemaphore.withPermits(1)(
      Effect.gen(function* () {
        if (yield* Ref.get(unassignedProjectReady)) return;

        yield* fileSystem.makeDirectory(unassignedWorkspaceRoot, { recursive: true });
        yield* engine.dispatch({
          type: "project.create",
          commandId: importCommandId("unassigned-project", "create"),
          projectId: UNASSIGNED_CODEX_PROJECT_ID,
          title: UNASSIGNED_CODEX_PROJECT_TITLE,
          workspaceRoot: unassignedWorkspaceRoot,
          createWorkspaceRootIfMissing: true,
          defaultModelSelection: null,
          createdAt: DateTime.formatIso(yield* DateTime.now),
        });
        yield* Ref.set(unassignedProjectReady, true);
      }),
    );
    const projectWorkspaceRoots = new Set(
      shellSnapshot.projects
        .filter((project) => project.id !== UNASSIGNED_CODEX_PROJECT_ID)
        .map((project) => normalizeProjectPathForComparison(project.workspaceRoot)),
    );
    const projectIdByThreadId = new Map(
      shellSnapshot.threads.map((thread) => [thread.id, thread.projectId] as const),
    );
    const discoveryCandidateGroups = groupPersistedThreadDiscoveryCandidates(instances);
    const continuationKeyByInstanceId = new Map(
      instances
        .filter((instance) => instance.driverKind === CODEX)
        .map(
          (instance) =>
            [instance.instanceId, instance.continuationIdentity.continuationKey] as const,
        ),
    );
    const threadByProviderIdentity = new Map<string, ThreadId>();
    const excludedThreadIdsByContinuation = new Map<string, Set<string>>();
    const cursorByThreadIdByContinuation = new Map<string, Map<string, string>>();
    const forceReadProviderThreadIdsByContinuation = new Map<string, Set<string>>();
    const unresolvedNativeProviderThreadIds = new Set<string>();

    for (const binding of bindings) {
      if (
        binding.provider !== CODEX ||
        !binding.providerInstanceId ||
        !isResumeCursor(binding.resumeCursor)
      ) {
        continue;
      }
      const continuationKey = resolvePersistedContinuationKey(
        binding.providerInstanceId,
        binding.runtimePayload,
        continuationKeyByInstanceId,
      );
      if (!continuationKey) {
        unresolvedNativeProviderThreadIds.add(binding.resumeCursor.threadId);
        continue;
      }
      threadByProviderIdentity.set(
        providerIdentityKey(continuationKey, binding.resumeCursor.threadId),
        binding.threadId,
      );
      const expectedImportedId = importedThreadIdFor(
        continuationKey,
        binding.resumeCursor.threadId,
      );
      if (binding.threadId !== expectedImportedId) {
        const excluded = excludedThreadIdsByContinuation.get(continuationKey) ?? new Set();
        excluded.add(binding.resumeCursor.threadId);
        excludedThreadIdsByContinuation.set(continuationKey, excluded);
      }
      if (
        binding.threadId === expectedImportedId &&
        isImportedRuntimePayload(binding.runtimePayload)
      ) {
        if (
          binding.runtimePayload.cwd &&
          projectIdByThreadId.get(binding.threadId) === UNASSIGNED_CODEX_PROJECT_ID &&
          projectWorkspaceRoots.has(normalizeProjectPathForComparison(binding.runtimePayload.cwd))
        ) {
          const forceRead =
            forceReadProviderThreadIdsByContinuation.get(continuationKey) ?? new Set();
          forceRead.add(binding.resumeCursor.threadId);
          forceReadProviderThreadIdsByContinuation.set(continuationKey, forceRead);
        }
        const providerCursor =
          binding.runtimePayload.providerDiscoveryCursor ??
          binding.runtimePayload.providerUpdatedAt;
        if (providerCursor) {
          const cursors = cursorByThreadIdByContinuation.get(continuationKey) ?? new Map();
          cursors.set(binding.resumeCursor.threadId, providerCursor);
          cursorByThreadIdByContinuation.set(continuationKey, cursors);
        }
      }
    }

    const discoveredCounts = yield* Effect.forEach(
      discoveryCandidateGroups,
      (candidates) =>
        Effect.gen(function* () {
          let selected:
            | {
                readonly instance: ProviderInstance;
                readonly model: string;
                readonly discovered: ReadonlyArray<ProviderPersistedThread>;
              }
            | undefined;
          for (const instance of candidates) {
            const attempt = yield* Effect.gen(function* () {
              const discover = instance.adapter.discoverPersistedThreads;
              if (!discover) return undefined;
              const providerSnapshot = yield* instance.snapshot.getSnapshot;
              const model =
                providerSnapshot.models.find((entry) => entry.isDefault)?.slug ??
                providerSnapshot.models[0]?.slug ??
                DEFAULT_MODEL_BY_PROVIDER[CODEX] ??
                "default";
              const continuationKey = instance.continuationIdentity.continuationKey;
              const forceReadProviderThreadIds =
                forceReadProviderThreadIdsByContinuation.get(continuationKey);
              const discovered = yield* discover({
                excludeProviderThreadIds: providerThreadDiscoveryExclusions(
                  unresolvedNativeProviderThreadIds,
                  excludedThreadIdsByContinuation.get(continuationKey),
                ),
                cursorByProviderThreadId:
                  cursorByThreadIdByContinuation.get(continuationKey) ?? new Map(),
                ...(forceReadProviderThreadIds ? { forceReadProviderThreadIds } : {}),
              });
              return { instance, model, discovered } as const;
            }).pipe(
              Effect.catch((cause) =>
                Effect.logWarning("persisted provider thread discovery candidate failed", {
                  provider: instance.driverKind,
                  providerInstanceId: instance.instanceId,
                  continuationIdentity: continuationIdentityDigest(
                    instance.continuationIdentity.continuationKey,
                  ),
                  errorType: diagnosticErrorType(cause),
                }).pipe(Effect.as(undefined)),
              ),
            );
            if (attempt) {
              selected = attempt;
              break;
            }
          }
          if (!selected) return 0;
          const { instance, model, discovered } = selected;
          const continuationKey = instance.continuationIdentity.continuationKey;

          yield* Effect.forEach(
            bindings.filter(
              (binding) =>
                binding.provider === CODEX &&
                binding.providerInstanceId !== undefined &&
                binding.providerInstanceId !== instance.instanceId &&
                isResumeCursor(binding.resumeCursor) &&
                binding.threadId ===
                  importedThreadIdFor(continuationKey, binding.resumeCursor.threadId) &&
                resolvePersistedContinuationKey(
                  binding.providerInstanceId,
                  binding.runtimePayload,
                  continuationKeyByInstanceId,
                ) === continuationKey,
            ),
            (binding) =>
              directory.upsert({
                ...binding,
                providerInstanceId: instance.instanceId,
              }),
            { concurrency: 1, discard: true },
          );

          yield* Effect.forEach(
            discovered,
            (thread) =>
              Effect.gen(function* () {
                if (!projectWorkspaceRoots.has(normalizeProjectPathForComparison(thread.cwd))) {
                  yield* ensureUnassignedProject;
                }
                yield* reconcilePersistedThread({
                  instance,
                  thread,
                  model,
                  threadByProviderIdentity,
                  directory,
                  snapshots,
                  engine,
                  unassignedProjectId: UNASSIGNED_CODEX_PROJECT_ID,
                });
              }).pipe(
                Effect.catchCause((cause) =>
                  recoverReconciliationCause(
                    cause,
                    "skipped persisted provider thread during reconciliation",
                    {
                      provider: instance.driverKind,
                      providerInstanceId: instance.instanceId,
                      providerThreadId: thread.providerThreadId,
                    },
                    undefined,
                  ),
                ),
              ),
            { concurrency: 1, discard: true },
          );
          return discovered.length;
        }).pipe(
          Effect.catchCause((cause) =>
            recoverReconciliationCause(
              cause,
              "persisted provider thread discovery failed",
              {
                provider: CODEX,
                continuationIdentity: candidates[0]
                  ? continuationIdentityDigest(candidates[0].continuationIdentity.continuationKey)
                  : undefined,
              },
              0,
            ),
          ),
        ),
      { concurrency: "unbounded" },
    );
    return discoveredCounts.reduce((total, count) => total + count, 0);
  },
);

export const reconcilePersistedThread = Effect.fn("reconcilePersistedProviderThread")(
  function* (input: {
    readonly instance: ProviderInstance;
    readonly thread: ProviderPersistedThread;
    readonly model: string;
    readonly threadByProviderIdentity: Map<string, ThreadId>;
    readonly directory: ProviderSessionDirectory["Service"];
    readonly snapshots: ProjectionSnapshotQuery["Service"];
    readonly engine: OrchestrationEngineService["Service"];
    readonly unassignedProjectId?: ProjectId;
  }) {
    const continuationKey = input.instance.continuationIdentity.continuationKey;
    const continuationIdentity = continuationIdentityDigest(continuationKey);
    const identity = providerIdentityKey(continuationKey, input.thread.providerThreadId);
    const expectedThreadId = importedThreadId(input.instance, input.thread.providerThreadId);
    const boundThreadId = input.threadByProviderIdentity.get(identity);

    // A non-imported T3 thread already owns this Codex identity. Its transcript
    // is projected from live runtime events and must never be imported again.
    if (boundThreadId !== undefined && boundThreadId !== expectedThreadId) return;

    const existingThread = yield* input.snapshots.getThreadShellById(expectedThreadId);
    const matchingProject = yield* input.snapshots.getActiveProjectByWorkspaceRoot(
      input.thread.cwd,
    );
    const projectId = Option.isSome(matchingProject)
      ? matchingProject.value.id
      : input.unassignedProjectId;
    if (projectId === undefined) return;
    const providerThreadMetadata = {
      provider: input.instance.driverKind,
      providerThreadId: input.thread.providerThreadId,
      updatedAt: input.thread.updatedAt,
      status: input.thread.status,
      sourceMetadata: input.thread.sourceMetadata,
    } as const;
    const projectChanged =
      Option.isSome(existingThread) &&
      existingThread.value.projectId !== undefined &&
      existingThread.value.projectId !== projectId;

    if (Option.isNone(existingThread)) {
      yield* input.engine.dispatch({
        type: "thread.create",
        commandId: importCommandId(continuationIdentity, input.thread.providerThreadId, "create"),
        threadId: expectedThreadId,
        projectId,
        title: input.thread.title,
        modelSelection: { instanceId: input.instance.instanceId, model: input.model },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        providerThreadMetadata,
        createdAt: input.thread.createdAt,
      });
    } else if (
      projectChanged ||
      existingThread.value.modelSelection.instanceId !== input.instance.instanceId ||
      existingThread.value.modelSelection.model !== input.model ||
      !providerThreadMetadataEqual(
        existingThread.value.providerThreadMetadata,
        providerThreadMetadata,
      )
    ) {
      yield* input.engine.dispatch({
        type: "thread.meta.update",
        commandId: importCommandId(
          continuationIdentity,
          input.thread.providerThreadId,
          "owner",
          input.instance.instanceId,
          input.model,
          input.thread.discoveryCursor,
        ),
        threadId: expectedThreadId,
        ...(projectChanged ? { projectId, worktreePath: null } : {}),
        modelSelection: { instanceId: input.instance.instanceId, model: input.model },
        providerThreadMetadata,
      });
    }

    const existingDetail = Option.isSome(existingThread)
      ? yield* input.snapshots.getThreadDetailById(expectedThreadId)
      : Option.none();
    const projectedMessages = Option.isSome(existingDetail) ? existingDetail.value.messages : [];
    const projectedIndexById = new Map(
      projectedMessages.map((message, index) => [message.id, index]),
    );
    const projectedIndexesByContent = new Map<string, Map<string, number[]>>();
    for (const [index, message] of projectedMessages.entries()) {
      const indexesByText = projectedIndexesByContent.get(message.role) ?? new Map();
      const indexes = indexesByText.get(message.text) ?? [];
      indexes.push(index);
      indexesByText.set(message.text, indexes);
      projectedIndexesByContent.set(message.role, indexesByText);
    }
    const nextContentPosition = new Map<string, Map<string, number>>();
    let projectedIndex = 0;
    const missingMessages = input.thread.messages.filter((message) => {
      const deterministicId = importedMessageId(
        continuationKey,
        input.thread.providerThreadId,
        message.id,
        message.sourceOrdinal,
      );
      const exactIndex = projectedIndexById.get(deterministicId);
      if (exactIndex !== undefined && exactIndex >= projectedIndex) {
        projectedIndex = exactIndex + 1;
        return false;
      }

      const indexes = projectedIndexesByContent.get(message.role)?.get(message.text) ?? [];
      const positionsByText = nextContentPosition.get(message.role) ?? new Map();
      let contentPosition = positionsByText.get(message.text) ?? 0;
      while (contentPosition < indexes.length && indexes[contentPosition]! < projectedIndex) {
        contentPosition += 1;
      }
      positionsByText.set(message.text, contentPosition + 1);
      nextContentPosition.set(message.role, positionsByText);
      const matchingIndex = indexes[contentPosition];
      if (matchingIndex !== undefined) {
        projectedIndex = matchingIndex + 1;
        return false;
      }
      return true;
    });

    yield* Effect.forEach(
      missingMessages,
      (message) =>
        input.engine.dispatch({
          type: "thread.message.import",
          commandId: importCommandId(
            continuationIdentity,
            input.thread.providerThreadId,
            "message",
            message.id,
          ),
          threadId: expectedThreadId,
          messageId: importedMessageId(
            continuationKey,
            input.thread.providerThreadId,
            message.id,
            message.sourceOrdinal,
          ),
          role: message.role,
          text: message.text,
          turnId: TurnId.make(message.turnId),
          createdAt: message.createdAt,
        }),
      { concurrency: 1, discard: true },
    );

    // Advance the discovery watermark only after every deterministic message
    // command has landed. A crash mid-import then retries safely on the next
    // pass instead of permanently hiding the remaining history.
    yield* input.directory.upsert({
      threadId: expectedThreadId,
      provider: CODEX,
      providerInstanceId: input.instance.instanceId,
      ...(boundThreadId === undefined
        ? { runtimeMode: "full-access" as const, status: "stopped" as const }
        : {}),
      resumeCursor: { threadId: input.thread.providerThreadId },
      runtimePayload: {
        imported: true,
        continuationKey,
        cwd: input.thread.cwd,
        providerUpdatedAt: input.thread.updatedAt,
        providerDiscoveryCursor: input.thread.discoveryCursor,
        sourceMetadata: input.thread.sourceMetadata,
        modelSelection: { instanceId: input.instance.instanceId, model: input.model },
      },
    });
    input.threadByProviderIdentity.set(identity, expectedThreadId);
  },
);

type ReconcilePersistedProviderThreadsError = Effect.Error<
  ReturnType<typeof reconcilePersistedProviderThreads>
>;

export class ProviderThreadReconciler extends Context.Service<
  ProviderThreadReconciler,
  {
    readonly reconcile: () => Effect.Effect<number, ReconcilePersistedProviderThreadsError>;
  }
>()("t3/provider/Layers/ProviderThreadReconciler") {}

/** Provides on-demand reconciliation without starting timers or registry-change listeners. */
export const ProviderThreadReconcilerLive = Layer.effect(
  ProviderThreadReconciler,
  Effect.gen(function* () {
    const registry = yield* ProviderInstanceRegistry;
    const directory = yield* ProviderSessionDirectory;
    const snapshots = yield* ProjectionSnapshotQuery;
    const engine = yield* OrchestrationEngineService;
    const config = yield* ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const reconcileSemaphore = yield* Semaphore.make(1);
    const runReconciliation = reconcilePersistedProviderThreads().pipe(
      Effect.provideService(ProviderInstanceRegistry, registry),
      Effect.provideService(ProviderSessionDirectory, directory),
      Effect.provideService(ProjectionSnapshotQuery, snapshots),
      Effect.provideService(OrchestrationEngineService, engine),
      Effect.provideService(ServerConfig, config),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.provideService(Path.Path, path),
    );

    return ProviderThreadReconciler.of({
      reconcile: () => reconcileSemaphore.withPermits(1)(runReconciliation),
    });
  }),
);
