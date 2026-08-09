// @effect-diagnostics nodeBuiltinImport:off
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";
import {
  CommandId,
  DEFAULT_MODEL,
  ProjectId,
  type ModelSelection,
  type OrchestrationCommand,
  type OrchestrationReadModel,
  type ProviderDriverKind,
  type ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import type { OrchestrationDispatchError } from "../../orchestration/Errors.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { forkParked } from "../../serverActivation.ts";
import type {
  ProviderRuntimeBinding,
  ProviderSessionDirectoryWriteError,
} from "../Services/ProviderSessionDirectory.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import { ProviderInstanceRegistry } from "../Services/ProviderInstanceRegistry.ts";
import type { ProviderThreadSummary } from "../Services/ProviderAdapter.ts";
import type { ProviderInstance } from "../ProviderDriver.ts";

const DISCOVERY_INTERVAL = "30 seconds";
const DISCOVERY_TIMEOUT = "20 seconds";
const IMPORT_METADATA_KEY = "providerThreadDiscovery";
const IMPORT_METADATA_VERSION = 1;

interface ImportedThreadMetadata {
  readonly version: 1;
  readonly discoveryKey: string;
  readonly providerThreadId: string;
  readonly providerUpdatedAt: string;
  readonly providerTitle: string;
}

interface ThreadDiscoveryBinding extends ProviderRuntimeBinding {
  readonly threadId: ThreadId;
}

export interface ProviderThreadDiscoverySource {
  readonly discoveryKey: string;
  readonly driverKind: ProviderDriverKind;
  readonly instanceId: ProviderInstanceId;
  readonly compatibleInstanceIds: ReadonlyArray<ProviderInstanceId>;
  readonly defaultModel: string;
  readonly listThreads: () => Effect.Effect<ReadonlyArray<ProviderThreadSummary>, never>;
}

export interface ProviderThreadSynchronizationInput {
  readonly sources: ReadonlyArray<ProviderThreadDiscoverySource>;
  readonly readModel: OrchestrationReadModel;
  readonly bindings: ReadonlyArray<ThreadDiscoveryBinding>;
  readonly dispatch: (
    command: OrchestrationCommand,
  ) => Effect.Effect<unknown, ProviderThreadSynchronizationError>;
  readonly upsertBinding: (
    binding: ProviderRuntimeBinding,
  ) => Effect.Effect<void, ProviderThreadSynchronizationError>;
}

export interface ProviderThreadSynchronizationResult {
  readonly discovered: number;
  readonly imported: number;
  readonly refreshed: number;
}

export type ProviderThreadSynchronizationError =
  | OrchestrationDispatchError
  | ProviderSessionDirectoryWriteError;

type Mutable<T> = { -readonly [Key in keyof T]: T[Key] };

type KnownThread = Mutable<
  Pick<
    OrchestrationReadModel["threads"][number],
    | "id"
    | "projectId"
    | "title"
    | "modelSelection"
    | "runtimeMode"
    | "interactionMode"
    | "branch"
    | "worktreePath"
    | "createdAt"
    | "updatedAt"
    | "deletedAt"
    | "session"
  >
>;

function stableId(prefix: string, ...parts: ReadonlyArray<string>): string {
  const digest = NodeCrypto.createHash("sha256")
    .update(JSON.stringify(parts), "utf8")
    .digest("hex")
    .slice(0, 32);
  return `${prefix}-${digest}`;
}

function readProviderThreadId(resumeCursor: unknown | null | undefined): string | undefined {
  if (!resumeCursor || typeof resumeCursor !== "object" || Array.isArray(resumeCursor)) {
    return undefined;
  }
  const threadId = "threadId" in resumeCursor ? resumeCursor.threadId : undefined;
  return typeof threadId === "string" && threadId.trim().length > 0 ? threadId : undefined;
}

function readImportMetadata(
  runtimePayload: unknown | null | undefined,
): ImportedThreadMetadata | undefined {
  if (!runtimePayload || typeof runtimePayload !== "object" || Array.isArray(runtimePayload)) {
    return undefined;
  }
  const raw =
    IMPORT_METADATA_KEY in runtimePayload ? runtimePayload[IMPORT_METADATA_KEY] : undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const metadata = raw as Partial<ImportedThreadMetadata>;
  return metadata.version === IMPORT_METADATA_VERSION &&
    typeof metadata.discoveryKey === "string" &&
    typeof metadata.providerThreadId === "string" &&
    typeof metadata.providerUpdatedAt === "string" &&
    typeof metadata.providerTitle === "string"
    ? (metadata as ImportedThreadMetadata)
    : undefined;
}

function normalizeTitle(value: string | undefined): string | undefined {
  const compact = value?.trim().replace(/\s+/g, " ");
  if (!compact) return undefined;
  return compact.length <= 120 ? compact : `${compact.slice(0, 117).trimEnd()}...`;
}

function discoveredThreadTitle(thread: ProviderThreadSummary): string {
  return normalizeTitle(thread.title) ?? normalizeTitle(thread.preview) ?? "Codex thread";
}

function projectTitle(cwd: string): string {
  return normalizeTitle(NodePath.basename(cwd)) ?? normalizeTitle(cwd) ?? "Imported Codex";
}

function importedThreadMetadata(input: {
  readonly source: ProviderThreadDiscoverySource;
  readonly thread: ProviderThreadSummary;
  readonly title: string;
}): ImportedThreadMetadata {
  return {
    version: IMPORT_METADATA_VERSION,
    discoveryKey: input.source.discoveryKey,
    providerThreadId: input.thread.providerThreadId,
    providerUpdatedAt: input.thread.updatedAt,
    providerTitle: input.title,
  };
}

function isNewerTimestamp(next: string, previous: string): boolean {
  const nextMs = Date.parse(next);
  const previousMs = Date.parse(previous);
  return Number.isFinite(nextMs) && Number.isFinite(previousMs)
    ? nextMs > previousMs
    : next !== previous;
}

function commandId(kind: string, ...parts: ReadonlyArray<string>): CommandId {
  return CommandId.make(stableId(`provider-thread-${kind}`, ...parts));
}

function canonicalThreadId(
  source: ProviderThreadDiscoverySource,
  providerThreadId: string,
): ThreadId {
  return ThreadId.make(stableId("codex-thread", source.discoveryKey, providerThreadId));
}

function canonicalProjectId(
  source: ProviderThreadDiscoverySource,
  cwd: string,
  salt?: string,
): ProjectId {
  return ProjectId.make(stableId("codex-project", source.discoveryKey, cwd, salt ?? ""));
}

function makeImportedSession(input: {
  readonly thread: KnownThread;
  readonly source: ProviderThreadDiscoverySource;
  readonly instanceId: ProviderInstanceId;
  readonly updatedAt: string;
}) {
  const existing = input.thread.session;
  return {
    threadId: input.thread.id,
    status: existing?.status ?? ("stopped" as const),
    providerName: input.source.driverKind,
    providerInstanceId: input.instanceId,
    runtimeMode: input.thread.runtimeMode,
    activeTurnId: existing?.activeTurnId ?? null,
    lastError: existing?.lastError ?? null,
    updatedAt: input.updatedAt,
  };
}

function makeRuntimePayload(input: {
  readonly cwd: string;
  readonly modelSelection: ModelSelection;
  readonly metadata: ImportedThreadMetadata;
}) {
  return {
    cwd: input.cwd,
    modelSelection: input.modelSelection,
    [IMPORT_METADATA_KEY]: input.metadata,
  };
}

/**
 * Reconcile provider-native threads into T3's event model and durable resume
 * directory. Existing T3-created threads are recognized by resume cursor and
 * never duplicated or renamed.
 */
export const synchronizeDiscoveredProviderThreads = Effect.fn(
  "synchronizeDiscoveredProviderThreads",
)(function* (input: ProviderThreadSynchronizationInput) {
  const projects = [...input.readModel.projects];
  const projectIds = new Set(projects.map((project) => project.id));
  const threads = new Map<ThreadId, KnownThread>(
    input.readModel.threads.map((thread) => [thread.id, { ...thread }]),
  );
  const bindingsBySource = new Map<string, Map<string, ThreadDiscoveryBinding>>();

  for (const source of input.sources) {
    const compatibleInstanceIds = new Set(source.compatibleInstanceIds);
    const bindings = new Map<string, ThreadDiscoveryBinding>();
    for (const binding of input.bindings) {
      if (
        binding.provider !== source.driverKind ||
        binding.providerInstanceId === undefined ||
        !compatibleInstanceIds.has(binding.providerInstanceId)
      ) {
        continue;
      }
      const providerThreadId = readProviderThreadId(binding.resumeCursor);
      if (providerThreadId !== undefined && !bindings.has(providerThreadId)) {
        bindings.set(providerThreadId, binding);
      }
    }
    bindingsBySource.set(source.discoveryKey, bindings);
  }

  let discoveredCount = 0;
  let importedCount = 0;
  let refreshedCount = 0;

  for (const source of input.sources) {
    const discoveredThreads = yield* source.listThreads();
    const sourceBindings = bindingsBySource.get(source.discoveryKey)!;
    const modelSelection: ModelSelection = {
      instanceId: source.instanceId,
      model: source.defaultModel,
    };

    for (const discovered of [...discoveredThreads].sort((left, right) =>
      left.createdAt.localeCompare(right.createdAt),
    )) {
      discoveredCount += 1;
      const title = discoveredThreadTitle(discovered);
      const linkedBinding = sourceBindings.get(discovered.providerThreadId);

      if (linkedBinding !== undefined) {
        const metadata = readImportMetadata(linkedBinding.runtimePayload);
        if (metadata === undefined) {
          // A native Codex thread already belongs to a T3-created thread.
          continue;
        }
        const linkedThread = threads.get(linkedBinding.threadId);
        if (linkedThread === undefined || linkedThread.deletedAt !== null) continue;

        const needsSessionRepair = linkedThread.session === null;
        const providerChanged = isNewerTimestamp(discovered.updatedAt, metadata.providerUpdatedAt);
        if (!needsSessionRepair && !providerChanged) continue;

        const providerOwnsTitle = linkedThread.title === metadata.providerTitle;
        if (providerChanged) {
          yield* input.dispatch({
            type: "thread.meta.update",
            commandId: commandId(
              "refresh",
              source.discoveryKey,
              discovered.providerThreadId,
              discovered.updatedAt,
            ),
            threadId: linkedThread.id,
            ...(providerOwnsTitle && title !== metadata.providerTitle
              ? { title, expectedTitle: metadata.providerTitle }
              : {}),
          });
          if (providerOwnsTitle && title !== metadata.providerTitle) {
            linkedThread.title = title;
          }
          linkedThread.updatedAt = discovered.updatedAt;
        }

        const targetInstanceId = linkedBinding.providerInstanceId ?? source.instanceId;
        if (needsSessionRepair) {
          const session = makeImportedSession({
            thread: linkedThread,
            source,
            instanceId: targetInstanceId,
            updatedAt: discovered.updatedAt,
          });
          yield* input.dispatch({
            type: "thread.session.set",
            commandId: commandId(
              "session-repair",
              source.discoveryKey,
              discovered.providerThreadId,
              discovered.updatedAt,
            ),
            threadId: linkedThread.id,
            session,
            createdAt: discovered.updatedAt,
          });
          linkedThread.session = session;
        }

        const nextMetadata = importedThreadMetadata({ source, thread: discovered, title });
        const nextBinding: ThreadDiscoveryBinding = {
          threadId: linkedThread.id,
          provider: source.driverKind,
          providerInstanceId: targetInstanceId,
          resumeCursor: { threadId: discovered.providerThreadId },
          runtimePayload: makeRuntimePayload({
            cwd: discovered.cwd,
            modelSelection: linkedThread.modelSelection,
            metadata: nextMetadata,
          }),
        };
        yield* input.upsertBinding(nextBinding);
        sourceBindings.set(discovered.providerThreadId, nextBinding);
        refreshedCount += 1;
        continue;
      }

      const threadId = canonicalThreadId(source, discovered.providerThreadId);
      let knownThread = threads.get(threadId);
      if (knownThread !== undefined && knownThread.deletedAt !== null) {
        // Deleting an imported thread is an explicit local opt-out. Do not
        // resurrect it just because it remains in Codex's history.
        continue;
      }

      if (knownThread === undefined) {
        let project = projects.find(
          (candidate) => candidate.deletedAt === null && candidate.workspaceRoot === discovered.cwd,
        );
        if (project === undefined) {
          let projectId = canonicalProjectId(source, discovered.cwd);
          if (projectIds.has(projectId)) {
            projectId = canonicalProjectId(source, discovered.cwd, discovered.providerThreadId);
          }
          yield* input.dispatch({
            type: "project.create",
            commandId: commandId("project", source.discoveryKey, discovered.cwd, projectId),
            projectId,
            title: projectTitle(discovered.cwd),
            workspaceRoot: discovered.cwd,
            defaultModelSelection: modelSelection,
            createdAt: discovered.createdAt,
          });
          project = {
            id: projectId,
            title: projectTitle(discovered.cwd),
            workspaceRoot: discovered.cwd,
            defaultModelSelection: modelSelection,
            scripts: [],
            createdAt: discovered.createdAt,
            updatedAt: discovered.createdAt,
            deletedAt: null,
          };
          projects.push(project);
          projectIds.add(projectId);
        }

        yield* input.dispatch({
          type: "thread.create",
          commandId: commandId("create", source.discoveryKey, discovered.providerThreadId),
          threadId,
          projectId: project.id,
          title,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: discovered.branch ?? null,
          worktreePath: null,
          createdAt: discovered.createdAt,
        });
        knownThread = {
          id: threadId,
          projectId: project.id,
          title,
          modelSelection,
          runtimeMode: "full-access",
          interactionMode: "default",
          branch: discovered.branch ?? null,
          worktreePath: null,
          createdAt: discovered.createdAt,
          updatedAt: discovered.createdAt,
          deletedAt: null,
          session: null,
        };
        threads.set(threadId, knownThread);
      }

      const metadata = importedThreadMetadata({ source, thread: discovered, title });
      const binding: ThreadDiscoveryBinding = {
        threadId,
        provider: source.driverKind,
        providerInstanceId: source.instanceId,
        status: "stopped",
        runtimeMode: knownThread.runtimeMode,
        resumeCursor: { threadId: discovered.providerThreadId },
        runtimePayload: makeRuntimePayload({
          cwd: discovered.cwd,
          modelSelection: knownThread.modelSelection,
          metadata,
        }),
      };
      yield* input.upsertBinding(binding);
      sourceBindings.set(discovered.providerThreadId, binding);

      const session = makeImportedSession({
        thread: knownThread,
        source,
        instanceId: source.instanceId,
        updatedAt: discovered.updatedAt,
      });
      yield* input.dispatch({
        type: "thread.session.set",
        commandId: commandId(
          "session",
          source.discoveryKey,
          discovered.providerThreadId,
          discovered.updatedAt,
        ),
        threadId,
        session,
        createdAt: discovered.updatedAt,
      });
      knownThread.session = session;
      knownThread.updatedAt = discovered.updatedAt;
      importedCount += 1;
    }
  }

  return {
    discovered: discoveredCount,
    imported: importedCount,
    refreshed: refreshedCount,
  } satisfies ProviderThreadSynchronizationResult;
});

function buildDiscoverySources(
  instances: ReadonlyArray<ProviderInstance>,
): Effect.Effect<ReadonlyArray<ProviderThreadDiscoverySource>> {
  const grouped = new Map<string, typeof instances>();
  for (const instance of instances) {
    if (!instance.enabled || instance.adapter.listThreads === undefined) continue;
    const key = `${instance.driverKind}:${instance.continuationIdentity.continuationKey}`;
    const current = grouped.get(key) ?? [];
    grouped.set(key, [...current, instance]);
  }

  return Effect.forEach(Array.from(grouped.entries()), ([discoveryKey, compatibleInstances]) =>
    Effect.gen(function* () {
      const primary = compatibleInstances[0]!;
      const snapshot = yield* primary.snapshot.getSnapshot;
      const listThreads = primary.adapter.listThreads!;
      return {
        discoveryKey,
        driverKind: primary.driverKind,
        instanceId: primary.instanceId,
        compatibleInstanceIds: compatibleInstances.map((instance) => instance.instanceId),
        defaultModel: snapshot.models[0]?.slug ?? DEFAULT_MODEL,
        listThreads: () =>
          listThreads().pipe(
            Effect.timeout(DISCOVERY_TIMEOUT),
            Effect.catchCause((cause) =>
              Effect.logWarning("Could not refresh provider thread discovery", {
                discoveryKey,
                provider: primary.driverKind,
                providerInstanceId: primary.instanceId,
                cause: Cause.pretty(cause),
              }).pipe(Effect.as([] as ReadonlyArray<ProviderThreadSummary>)),
            ),
          ),
      } satisfies ProviderThreadDiscoverySource;
    }),
  );
}

const makeProviderThreadDiscovery = Effect.gen(function* () {
  const registry = yield* ProviderInstanceRegistry;
  const directory = yield* ProviderSessionDirectory;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const projectionSnapshotQuery = yield* ProjectionSnapshotQuery;
  const synchronizationLock = yield* Semaphore.make(1);
  const instanceChanges = yield* registry.subscribeChanges;

  const synchronize = synchronizationLock.withPermits(1)(
    Effect.gen(function* () {
      const instances = yield* registry.listInstances;
      const sources = yield* buildDiscoverySources(instances);
      if (sources.length === 0) return;

      // Provider discovery can require a process spawn and multiple pages.
      // Complete it before sampling T3 state so reconciliation works from the
      // freshest available projection and active-session view.
      const discoveredSources = yield* Effect.forEach(sources, (source) =>
        source.listThreads().pipe(
          Effect.map((threads) => ({
            ...source,
            listThreads: () => Effect.succeed(threads),
          })),
        ),
      );

      const [readModel, persistedBindings] = yield* Effect.all([
        projectionSnapshotQuery.getCommandReadModel(),
        directory.listBindings(),
      ]);
      const activeBindings = yield* Effect.forEach(
        instances,
        (instance) =>
          instance.adapter.listSessions().pipe(
            Effect.map((sessions) =>
              sessions.map(
                (session): ThreadDiscoveryBinding => ({
                  threadId: session.threadId,
                  provider: instance.driverKind,
                  providerInstanceId: instance.instanceId,
                  runtimeMode: session.runtimeMode,
                  status: session.status === "error" ? "error" : "running",
                  resumeCursor: session.resumeCursor,
                }),
              ),
            ),
            Effect.catchCause(() => Effect.succeed([] as ReadonlyArray<ThreadDiscoveryBinding>)),
          ),
        { concurrency: "unbounded" },
      ).pipe(Effect.map((groups) => groups.flat()));

      const result = yield* synchronizeDiscoveredProviderThreads({
        sources: discoveredSources,
        readModel,
        // The synchronizer keeps the first binding for a provider thread.
        // Prefer the live adapter view so a persisted stopped binding cannot
        // mask a follow-up that became active while discovery was running.
        bindings: [...activeBindings, ...persistedBindings],
        dispatch: (command) => orchestrationEngine.dispatch(command),
        upsertBinding: (binding) => directory.upsert(binding),
      });
      if (result.imported > 0 || result.refreshed > 0) {
        yield* Effect.logInfo("Provider thread discovery synchronized", result);
      } else {
        yield* Effect.logDebug("Provider thread discovery is current", result);
      }
    }),
  );

  const synchronizeSafely = synchronize.pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Provider thread discovery synchronization failed", {
        cause: Cause.pretty(cause),
      }),
    ),
  );

  yield* forkParked(synchronizeSafely.pipe(Effect.repeat(Schedule.spaced(DISCOVERY_INTERVAL))));
  yield* forkParked(
    Stream.fromSubscription(instanceChanges).pipe(Stream.runForEach(() => synchronizeSafely)),
  );
});

export const ProviderThreadDiscoveryLive = Layer.effectDiscard(makeProviderThreadDiscovery);
