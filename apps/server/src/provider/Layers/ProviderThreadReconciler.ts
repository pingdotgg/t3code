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
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import { ServerConfig } from "../../config.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import type { ProviderPersistedThread } from "../Services/ProviderAdapter.ts";

const CODEX = ProviderDriverKind.make("codex");
const ACTIVE_RECONCILE_INTERVAL = Duration.seconds(30);
const IDLE_RECONCILE_INTERVAL = Duration.minutes(2);
const ResumeCursor = Schema.Struct({ threadId: Schema.String });
const isResumeCursor = Schema.is(ResumeCursor);
const ImportedRuntimePayload = Schema.Struct({
  continuationKey: Schema.optional(Schema.String),
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

function unassignedProjectId(instance: ProviderInstance): ProjectId {
  return ProjectId.make(
    `provider-imports:${continuationIdentityDigest(instance.continuationIdentity.continuationKey)}`,
  );
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
    const serverConfig = yield* ServerConfig;
    const path = yield* Path.Path;
    const instances = yield* registry.listInstances;
    const bindings = yield* directory.listBindings();
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
    const importedOwnerInstanceIdsByContinuation = new Map<string, Set<string>>();
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
      } else {
        const importedOwners =
          importedOwnerInstanceIdsByContinuation.get(continuationKey) ?? new Set();
        importedOwners.add(binding.providerInstanceId);
        importedOwnerInstanceIdsByContinuation.set(continuationKey, importedOwners);
      }
      if (
        binding.threadId === expectedImportedId &&
        isImportedRuntimePayload(binding.runtimePayload)
      ) {
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
              const importedOwners = importedOwnerInstanceIdsByContinuation.get(continuationKey);
              const ownerChanged =
                importedOwners !== undefined &&
                Array.from(importedOwners).some(
                  (ownerInstanceId) => ownerInstanceId !== instance.instanceId,
                );
              const discovered = yield* discover({
                excludeProviderThreadIds: providerThreadDiscoveryExclusions(
                  unresolvedNativeProviderThreadIds,
                  excludedThreadIdsByContinuation.get(continuationKey),
                ),
                cursorByProviderThreadId: ownerChanged
                  ? new Map()
                  : (cursorByThreadIdByContinuation.get(continuationKey) ?? new Map()),
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

          yield* Effect.forEach(
            discovered,
            (thread) =>
              reconcilePersistedThread({
                instance,
                thread,
                model,
                threadByProviderIdentity,
                directory,
                snapshots,
                engine,
                unassignedWorkspaceRoot: path.join(
                  serverConfig.stateDir,
                  "provider-imports",
                  continuationIdentityDigest(instance.continuationIdentity.continuationKey),
                ),
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
    readonly unassignedWorkspaceRoot: string;
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
      : unassignedProjectId(input.instance);

    if (Option.isNone(matchingProject)) {
      const existingUnassignedProject = yield* input.snapshots.getProjectShellById(projectId);
      if (Option.isNone(existingUnassignedProject)) {
        if (Option.isNone(existingThread)) {
          yield* input.engine.dispatch({
            type: "project.create",
            commandId: importCommandId(continuationIdentity, "unassigned-project"),
            projectId,
            title: "Unassigned Codex threads",
            workspaceRoot: input.unassignedWorkspaceRoot,
            defaultModelSelection: { instanceId: input.instance.instanceId, model: input.model },
            createdAt: input.thread.createdAt,
          });
        }
      } else if (
        existingUnassignedProject.value.defaultModelSelection?.instanceId !==
          input.instance.instanceId ||
        existingUnassignedProject.value.defaultModelSelection.model !== input.model
      ) {
        yield* input.engine.dispatch({
          type: "project.meta.update",
          commandId: importCommandId(
            continuationIdentity,
            "unassigned-project",
            "owner",
            input.instance.instanceId,
            input.model,
          ),
          projectId,
          defaultModelSelection: { instanceId: input.instance.instanceId, model: input.model },
        });
      }
    }

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
        worktreePath: Option.isSome(matchingProject) ? null : input.thread.cwd,
        createdAt: input.thread.createdAt,
      });
    } else if (
      existingThread.value.modelSelection.instanceId !== input.instance.instanceId ||
      existingThread.value.modelSelection.model !== input.model
    ) {
      yield* input.engine.dispatch({
        type: "thread.meta.update",
        commandId: importCommandId(
          continuationIdentity,
          input.thread.providerThreadId,
          "owner",
          input.instance.instanceId,
          input.model,
        ),
        threadId: expectedThreadId,
        modelSelection: { instanceId: input.instance.instanceId, model: input.model },
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
        providerUpdatedAt: input.thread.updatedAt,
        providerDiscoveryCursor: input.thread.discoveryCursor,
        sourceMetadata: input.thread.sourceMetadata,
        modelSelection: { instanceId: input.instance.instanceId, model: input.model },
      },
    });
    input.threadByProviderIdentity.set(identity, expectedThreadId);
  },
);

export const ProviderThreadReconcilerLive = Layer.effectDiscard(
  Effect.gen(function* () {
    const registry = yield* ProviderInstanceRegistry;
    const changes = yield* registry.subscribeChanges;
    const reconcileSemaphore = yield* Semaphore.make(1);
    const reconcile = reconcileSemaphore.withPermits(1)(
      reconcilePersistedProviderThreads().pipe(
        Effect.catchCause((cause) =>
          recoverReconciliationCause(
            cause,
            "persisted provider thread reconciliation failed",
            {},
            0,
          ),
        ),
      ),
    );

    yield* Effect.forkScoped(
      Effect.forever(
        reconcile.pipe(
          Effect.flatMap((discoveredCount) =>
            Effect.sleep(discoveredCount > 0 ? ACTIVE_RECONCILE_INTERVAL : IDLE_RECONCILE_INTERVAL),
          ),
        ),
      ),
    );
    yield* Effect.forkScoped(Effect.forever(PubSub.take(changes).pipe(Effect.andThen(reconcile))));
  }),
);
