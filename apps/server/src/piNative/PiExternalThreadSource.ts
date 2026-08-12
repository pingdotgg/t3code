// @effect-diagnostics globalTimers:off
// @effect-diagnostics nodeBuiltinImport:off
// @effect-diagnostics preferSchemaOverJson:off
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type {
  ClientOrchestrationCommand,
  DispatchResult,
  OrchestrationShellSnapshot,
  OrchestrationSubscribeThreadInput,
  OrchestrationThreadDetailSnapshot,
  OrchestrationThreadStreamItem,
  PiExternalCatalogSnapshot,
  PiExternalCatalogSubscribeInput,
  PiExternalCatalogStreamItem,
  PiExternalCreateSessionInput,
  PiExternalCreateSessionResult,
  ProjectId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import {
  CommandId as CommandIdSchema,
  PiNativeError,
  PROVIDER_SEND_TURN_MAX_IMAGE_BYTES,
  TurnId as TurnIdSchema,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as PubSub from "effect/PubSub";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import * as SubscriptionRef from "effect/SubscriptionRef";

import { ProjectionSnapshotQuery } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { PiExternalLifecycleOverride } from "../persistence/Services/PiExternalLifecycleOverrides.ts";
import { PiExternalLifecycleOverrideRepository } from "../persistence/Services/PiExternalLifecycleOverrides.ts";
import type { ProviderRuntimeBindingWithMetadata } from "../provider/Services/ProviderSessionDirectory.ts";
import { ProviderSessionDirectory } from "../provider/Services/ProviderSessionDirectory.ts";
import { PiSessionCursor } from "../provider/pi/PiSessionFile.ts";
import {
  defaultPiSessionsRoot,
  type PiSessionCatalogRecord,
  SessionCatalog,
} from "./SessionCatalog.ts";
import {
  projectPiLiveEvent,
  projectPiThread,
  projectPiThreadOverlay,
  projectPiThreadShell,
} from "./PiSessionProjection.ts";
import { SupervisorClient } from "./SupervisorClient.ts";
import type {
  SupervisorCommand,
  SupervisorCommandReceipt,
  SupervisorRuntimeState,
  SupervisorStreamEvent,
  SupervisorStreamItem,
} from "./SupervisorProtocol.ts";

const EXTERNAL_THREAD_PREFIX = "external:pi:";
const CATALOG_MAX_THREADS = 5_000;
const CATALOG_MAX_SERIALIZED_BYTES = 8 * 1024 * 1024;
const CATALOG_ENVELOPE_RESERVE_BYTES = 1_024;
/**
 * Clients built before catalog-only project shells were removed decode
 * `projects` and `omittedProjectCount` as required fields. Keep emitting empty
 * values until no such client can reach a current server, then delete.
 */
const LEGACY_CATALOG_PROJECT_FIELDS = { projects: [], omittedProjectCount: 0 } as const;
export function validExternalLifecycleOverride(
  record: PiSessionCatalogRecord,
  override: PiExternalLifecycleOverride | undefined,
) {
  const local =
    override?.observedFileSize === record.fileSize &&
    override.observedFileMtimeMs === record.fileMtimeMs
      ? {
          override: override.lifecycleOverride,
          updatedAt: override.updatedAt,
        }
      : undefined;
  const jsonl = record.jsonlLifecycle;
  if (local === undefined) return jsonl;
  if (jsonl === undefined) return local;
  return Date.parse(local.updatedAt) >= Date.parse(jsonl.updatedAt) ? local : jsonl;
}
export function shutdownCreatedRuntime(
  supervisor: Pick<SupervisorClient["Service"], "dispatch">,
  runtimeId: SupervisorRuntimeState["runtimeId"],
) {
  return supervisor
    .dispatch({
      type: "shutdown",
      commandId: CommandIdSchema.make(`pi-create-cleanup:${NodeCrypto.randomUUID()}`),
      runtimeId,
    })
    .pipe(Effect.ignore);
}
export class CatalogRuntimeAttachmentGate {
  #attached = false;
  attach(): void {
    this.#attached = true;
  }
  allowsCatalogUpdate(): boolean {
    return !this.#attached;
  }
}
export function catalogUpdateAfterRead<T>(
  gate: CatalogRuntimeAttachmentGate,
  snapshot: T,
): T | undefined {
  return gate.allowsCatalogUpdate() ? snapshot : undefined;
}
export function runtimeSnapshotAtSequence(
  current: SupervisorRuntimeState | undefined,
  sequence: number,
): SupervisorRuntimeState | undefined {
  return current === undefined ? undefined : { ...current, sequence };
}
export function runtimeSequenceStable(
  before: SupervisorRuntimeState | undefined,
  after: SupervisorRuntimeState | undefined,
): boolean {
  return before?.runtimeId === after?.runtimeId && before?.sequence === after?.sequence;
}
export const isRuntimeLifecycleEvent = (eventType: string | undefined): boolean =>
  eventType === "bridge_disconnected" ||
  eventType === "bridge_reconnected" ||
  eventType === "bridge_registered";
const supervisorEventType = (item: SupervisorStreamEvent): string | undefined => {
  if (typeof item.event !== "object" || item.event === null || Array.isArray(item.event)) {
    return undefined;
  }
  const payload = item.event as Readonly<Record<string, unknown>>;
  return payload.type === "event" && typeof payload.event === "string"
    ? payload.event
    : typeof payload.type === "string"
      ? payload.type
      : undefined;
};
export function boundExternalCatalog(input: {
  readonly threads: ReadonlyArray<ReturnType<typeof projectPiThreadShell>>;
  readonly totalThreadCount: number;
  readonly maxThreads?: number;
  readonly maxSerializedBytes?: number;
}) {
  const maxThreads = input.maxThreads ?? CATALOG_MAX_THREADS;
  const maxSerializedBytes = input.maxSerializedBytes ?? CATALOG_MAX_SERIALIZED_BYTES;
  const select = (count: number) => {
    const threads = input.threads.slice(0, count);
    const serializedBytes =
      Buffer.byteLength(
        JSON.stringify({
          snapshotSequence: Number.MAX_SAFE_INTEGER,
          threads,
          omittedThreadCount: input.totalThreadCount - threads.length,
          updatedAt: "9999-12-31T23:59:59.999Z",
        }),
        "utf8",
      ) + CATALOG_ENVELOPE_RESERVE_BYTES;
    return { serializedBytes, threads };
  };
  let low = 0;
  let high = Math.min(maxThreads, input.threads.length);
  while (low < high) {
    const middle = Math.ceil((low + high) / 2);
    if (select(middle).serializedBytes <= maxSerializedBytes) low = middle;
    else high = middle - 1;
  }
  const { threads } = select(low);
  return {
    threads,
    omittedThreadCount: input.totalThreadCount - threads.length,
  };
}
const sourceError = (code: string, cause: unknown) =>
  new PiNativeError({
    code,
    message: cause instanceof Error ? cause.message : String(cause),
  });
const privateSourceError = (code: string, message: string) => new PiNativeError({ code, message });
export const receiptSessionFile = (receipt: SupervisorCommandReceipt): string | undefined => {
  if (
    typeof receipt.result !== "object" ||
    receipt.result === null ||
    !("sessionFile" in receipt.result)
  ) {
    return undefined;
  }
  return typeof receipt.result.sessionFile === "string" ? receipt.result.sessionFile : undefined;
};

export const isPiExternalThreadId = (threadId: ThreadId): boolean =>
  threadId.startsWith(EXTERNAL_THREAD_PREFIX);

const canonical = (value: string) =>
  NodeFS.promises.realpath(value).catch(() => NodePath.resolve(value));

interface Association {
  readonly projectIdByThread: ReadonlyMap<ThreadId, ProjectId>;
}

/**
 * Delegated Pi sessions point at the managed parent session file, while the
 * sidebar identifies that parent by its internal T3 thread id. The provider
 * cursor is the durable bridge between those two identities.
 */
export async function resolveManagedPiParentThreadIds(
  records: ReadonlyArray<PiSessionCatalogRecord>,
  bindings: ReadonlyArray<ProviderRuntimeBindingWithMetadata>,
): Promise<ReadonlyArray<PiSessionCatalogRecord>> {
  const managedThreadIdBySessionFile = new Map<string, ThreadId>();
  await Promise.all(
    bindings.map(async (binding) => {
      if (binding.provider !== "pi") return;
      const cursor = Schema.decodeUnknownOption(PiSessionCursor)(binding.resumeCursor);
      if (Option.isNone(cursor)) return;
      managedThreadIdBySessionFile.set(await canonical(cursor.value.sessionFile), binding.threadId);
    }),
  );
  if (managedThreadIdBySessionFile.size === 0) return records;
  return records.map((record) => {
    if (record.parentSessionFile === undefined) return record;
    const managedParentThreadId = managedThreadIdBySessionFile.get(record.parentSessionFile);
    return managedParentThreadId === undefined
      ? record
      : { ...record, parentThreadId: managedParentThreadId };
  });
}

export function managedPiBindingSignature(
  bindings: ReadonlyArray<ProviderRuntimeBindingWithMetadata>,
): string {
  return JSON.stringify(
    bindings
      .flatMap((binding) => {
        if (binding.provider !== "pi") return [];
        const cursor = Schema.decodeUnknownOption(PiSessionCursor)(binding.resumeCursor);
        return Option.isNone(cursor)
          ? []
          : [{ sessionFile: cursor.value.sessionFile, threadId: binding.threadId }];
      })
      .toSorted(
        (left, right) =>
          left.sessionFile.localeCompare(right.sessionFile) ||
          left.threadId.localeCompare(right.threadId),
      ),
  );
}

/**
 * Maps Pi sessions onto the projects a user added. Sessions Pi ran anywhere
 * else have no project to belong to and are left out of the catalog entirely.
 */
export async function associate(
  records: ReadonlyArray<PiSessionCatalogRecord>,
  internal: OrchestrationShellSnapshot,
): Promise<Association> {
  const projects = await Promise.all(
    internal.projects.map(async (project) => ({
      project,
      root: await canonical(project.workspaceRoot),
    })),
  );
  const worktrees = await Promise.all(
    internal.threads.flatMap((thread) =>
      thread.worktreePath === null
        ? []
        : [
            canonical(thread.worktreePath).then((root) => ({
              projectId: thread.projectId,
              root,
            })),
          ],
    ),
  );
  const projectIdByThread = new Map<ThreadId, ProjectId>();
  for (const record of records) {
    const exactProject = projects.find(({ root }) => root === record.cwd);
    const exactWorktree = worktrees.find(({ root }) => root === record.cwd);
    const ancestor = projects
      .filter(({ root }) => record.cwd === root || record.cwd.startsWith(`${root}${NodePath.sep}`))
      .sort((a, b) => b.root.length - a.root.length)[0];
    const projectId = exactProject?.project.id ?? exactWorktree?.projectId ?? ancestor?.project.id;
    // Sessions Pi ran outside every added project stay unassociated: T3 never
    // invents a project the user did not add, so those sessions never reach
    // the sidebar.
    if (projectId !== undefined) projectIdByThread.set(record.threadId, projectId);
  }
  return { projectIdByThread };
}

function runtimeFor(
  record: PiSessionCatalogRecord,
  runtimes: ReadonlyArray<SupervisorRuntimeState>,
) {
  return runtimes.find(
    (runtime) => runtime.sessionFile === record.canonicalFile && runtime.status !== "exited",
  );
}

export function runtimeCatalogSignature(runtimes: ReadonlyArray<SupervisorRuntimeState>): string {
  return JSON.stringify(
    runtimes
      .filter((runtime) => runtime.status !== "exited" && runtime.sessionFile !== undefined)
      .map((runtime) => ({
        sessionFile: runtime.sessionFile,
        status: runtime.status,
        writerKind: runtime.writerKind,
      }))
      .sort((left, right) => (left.sessionFile ?? "").localeCompare(right.sessionFile ?? "")),
  );
}

function internalAssociationSignature(snapshot: OrchestrationShellSnapshot): string {
  return JSON.stringify({
    projects: snapshot.projects
      .map((project) => [project.id, project.workspaceRoot])
      .sort(([left], [right]) => left!.localeCompare(right!)),
    worktrees: snapshot.threads
      .filter((thread) => thread.worktreePath !== null)
      .map((thread) => [thread.projectId, thread.worktreePath])
      .sort(([left], [right]) => left!.localeCompare(right!)),
  });
}

async function* catalogTriggers(): AsyncGenerator<void> {
  const root = defaultPiSessionsRoot();
  let wake: (() => void) | undefined;
  let pending = true;
  let debounce: NodeJS.Timeout | undefined;
  const notify = () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      pending = true;
      wake?.();
    }, 150);
    debounce.unref();
  };
  const reconciliation = setInterval(() => {
    pending = true;
    wake?.();
  }, 30_000);
  reconciliation.unref();
  let watcher: NodeFS.FSWatcher | undefined;
  const attachWatcher = async () => {
    if (watcher) return;
    watcher = await NodeFS.promises
      .stat(root)
      .then(() => NodeFS.watch(root, { recursive: true }, notify))
      .catch(() => undefined);
  };
  try {
    while (true) {
      await attachWatcher();
      if (!pending) {
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
      }
      wake = undefined;
      pending = false;
      yield;
    }
  } finally {
    if (debounce) clearTimeout(debounce);
    clearInterval(reconciliation);
    watcher?.close();
  }
}

function imagesFrom(
  command: Extract<ClientOrchestrationCommand, { readonly type: "thread.turn.start" }>,
) {
  return command.message.attachments.map((attachment) => {
    const comma = attachment.dataUrl.indexOf(",");
    if (comma < 0) throw new Error("invalid image data url");
    const data = attachment.dataUrl.slice(comma + 1);
    if (Buffer.byteLength(data, "base64") > PROVIDER_SEND_TURN_MAX_IMAGE_BYTES) {
      throw new Error("image exceeds the attachment byte ceiling");
    }
    return {
      type: "image" as const,
      data,
      mimeType: attachment.mimeType,
    };
  });
}

export class PiExternalThreadSource extends Context.Service<
  PiExternalThreadSource,
  {
    readonly catalogSnapshot: () => Effect.Effect<PiExternalCatalogSnapshot, PiNativeError>;
    readonly subscribeCatalog: (
      input: PiExternalCatalogSubscribeInput,
    ) => Stream.Stream<PiExternalCatalogStreamItem, PiNativeError>;
    readonly resolve: (
      threadId: ThreadId,
    ) => Effect.Effect<PiSessionCatalogRecord | undefined, PiNativeError>;
    readonly threadSnapshot: (
      threadId: ThreadId,
    ) => Effect.Effect<OrchestrationThreadDetailSnapshot, PiNativeError>;
    readonly subscribeThread: (
      input: OrchestrationSubscribeThreadInput,
    ) => Stream.Stream<OrchestrationThreadStreamItem, PiNativeError>;
    readonly createSession: (
      input: PiExternalCreateSessionInput,
    ) => Effect.Effect<PiExternalCreateSessionResult, PiNativeError>;
    readonly dispatch: (
      command: ClientOrchestrationCommand,
    ) => Effect.Effect<DispatchResult, PiNativeError>;
  }
>()("t3/piNative/PiExternalThreadSource") {
  static readonly layer = Layer.effect(
    PiExternalThreadSource,
    Effect.gen(function* () {
      const catalog = yield* SessionCatalog;
      const supervisor = yield* SupervisorClient;
      const snapshots = yield* ProjectionSnapshotQuery;
      const providerSessions = yield* ProviderSessionDirectory;
      const lifecycleOverrides = yield* PiExternalLifecycleOverrideRepository;
      const catalogBuildSemaphore = yield* Semaphore.make(1);
      let catalogSequence = 0;
      let catalogSignature = "";
      let cachedRecords: ReadonlyArray<PiSessionCatalogRecord> | undefined;
      // Replaced wholesale at the end of each build, never cleared: an in-flight
      // rebuild must not make live threads look unknown to concurrent readers.
      let cachedScopedThreadIds: ReadonlySet<ThreadId> = new Set();
      let cachedOmittedThreadCount = 0;
      let cachedInternal: OrchestrationShellSnapshot | undefined;
      let cachedAssociation: Association | undefined;
      let lastCatalogRuntimeSignature = "";
      let lastInternalAssociationSignature = "";
      let lastManagedPiBindingSignature = "";

      const internalShell = snapshots
        .getShellSnapshot()
        .pipe(
          Effect.mapError(() =>
            privateSourceError("internal_shell", "Thread catalog access failed."),
          ),
        );

      const buildCatalogUnlocked = Effect.fn("PiExternalThreadSource.catalogSnapshot")(function* (
        refreshCatalog = true,
        runtimeOverride?: ReadonlyArray<SupervisorRuntimeState>,
        providerBindingsOverride?: ReadonlyArray<ProviderRuntimeBindingWithMetadata>,
      ) {
        const runtimes =
          runtimeOverride ?? (yield* supervisor.list().pipe(Effect.orElseSucceed(() => [])));
        if (refreshCatalog || cachedRecords === undefined || cachedInternal === undefined) {
          [cachedRecords, cachedInternal] = yield* Effect.all([
            catalog.list(
              runtimes.flatMap((runtime) =>
                runtime.sessionFile === undefined ? [] : [runtime.sessionFile],
              ),
            ),
            internalShell,
          ]);
          cachedOmittedThreadCount = yield* catalog.omittedCount();
          cachedAssociation = undefined;
        }
        const records = cachedRecords;
        const internal = cachedInternal;
        const providerBindings =
          providerBindingsOverride ??
          (yield* providerSessions.listBindings().pipe(Effect.orElseSucceed(() => [])));
        const resolvedRecords = yield* Effect.promise(() =>
          resolveManagedPiParentThreadIds(records, providerBindings),
        );
        lastInternalAssociationSignature = internalAssociationSignature(internal);
        lastCatalogRuntimeSignature = runtimeCatalogSignature(runtimes);
        lastManagedPiBindingSignature = managedPiBindingSignature(providerBindings);
        if (cachedAssociation === undefined) {
          cachedAssociation = yield* Effect.tryPromise({
            try: () => associate(resolvedRecords, internal),
            catch: () =>
              privateSourceError("catalog_association", "Thread catalog association failed."),
          });
        }
        const association = cachedAssociation;
        const lifecycleBySourceKey = new Map(
          (yield* lifecycleOverrides
            .list()
            .pipe(
              Effect.mapError(() =>
                privateSourceError(
                  "lifecycle_store",
                  "External Pi lifecycle state could not be loaded.",
                ),
              ),
            )).map((value) => [value.sourceKey, value] as const),
        );
        const scopedRecords = resolvedRecords.filter((record) =>
          association.projectIdByThread.has(record.threadId),
        );
        cachedScopedThreadIds = new Set(scopedRecords.map((record) => record.threadId));
        const projectedThreads = scopedRecords.slice(0, CATALOG_MAX_THREADS).map((record) => {
          const projectId = association.projectIdByThread.get(record.threadId)!;
          const lifecycle = validExternalLifecycleOverride(
            record,
            lifecycleBySourceKey.get(record.sourceKey),
          );
          const detail = projectPiThread({
            record,
            entries: [],
            projectId,
            ...(runtimeFor(record, runtimes) === undefined
              ? {}
              : { runtime: runtimeFor(record, runtimes)! }),
            ...(lifecycle === undefined ? {} : { lifecycle }),
          });
          return projectPiThreadShell(detail);
        });
        const { threads, omittedThreadCount } = boundExternalCatalog({
          threads: projectedThreads,
          totalThreadCount: scopedRecords.length + cachedOmittedThreadCount,
        });
        const signature = JSON.stringify({ threads, omittedThreadCount });
        if (signature !== catalogSignature) {
          catalogSignature = signature;
          catalogSequence += 1;
        }
        return {
          snapshotSequence: catalogSequence,
          threads,
          omittedThreadCount,
          ...LEGACY_CATALOG_PROJECT_FIELDS,
          updatedAt: yield* DateTime.now.pipe(Effect.map(DateTime.formatIso)),
        } satisfies PiExternalCatalogSnapshot;
      });

      const buildCatalog = (
        refreshCatalog = true,
        runtimeOverride?: ReadonlyArray<SupervisorRuntimeState>,
      ) => catalogBuildSemaphore.withPermit(buildCatalogUnlocked(refreshCatalog, runtimeOverride));

      const buildCatalogForRuntimeChange = Effect.fn("PiExternalThreadSource.catalogRuntimeChange")(
        function* () {
          return yield* catalogBuildSemaphore.withPermit(
            Effect.gen(function* () {
              const [runtimes, internal, providerBindings] = yield* Effect.all([
                supervisor.list().pipe(Effect.orElseSucceed(() => [])),
                internalShell,
                providerSessions.listBindings().pipe(Effect.orElseSucceed(() => [])),
              ]);
              const runtimeSignature = runtimeCatalogSignature(runtimes);
              const internalSignature = internalAssociationSignature(internal);
              const bindingSignature = managedPiBindingSignature(providerBindings);
              if (
                runtimeSignature === lastCatalogRuntimeSignature &&
                internalSignature === lastInternalAssociationSignature &&
                bindingSignature === lastManagedPiBindingSignature
              ) {
                return undefined;
              }
              if (internalSignature !== lastInternalAssociationSignature) {
                cachedInternal = internal;
                cachedAssociation = undefined;
              }
              return yield* buildCatalogUnlocked(false, runtimes, providerBindings);
            }),
          );
        },
      );

      // Reads, subscriptions, and dispatch all resolve through here, so scoping
      // it keeps every path agreeing on which sessions exist: a session outside
      // the user's projects is unknown, not readable-but-unwritable.
      const findRecord = (threadId: ThreadId) =>
        Effect.sync(() =>
          isPiExternalThreadId(threadId) && cachedScopedThreadIds.has(threadId)
            ? cachedRecords?.find((record) => record.threadId === threadId)
            : undefined,
        );

      const readProjected = Effect.fn("PiExternalThreadSource.threadSnapshot")(function* (
        threadId: ThreadId,
        runtimeOverride?: SupervisorRuntimeState,
        entriesOverride?: ReadonlyArray<Readonly<Record<string, unknown>>>,
      ) {
        let result = yield* catalog.read(threadId);
        let runtime = runtimeOverride;
        if (entriesOverride === undefined) {
          const selectRuntime = (runtimes: ReadonlyArray<SupervisorRuntimeState>) =>
            runtimeOverride === undefined
              ? runtimeFor(result.record, runtimes)
              : runtimes.find((candidate) => candidate.runtimeId === runtimeOverride.runtimeId);
          for (let attempt = 0; attempt < 3; attempt += 1) {
            const before = selectRuntime(
              yield* supervisor.list().pipe(Effect.orElseSucceed(() => [])),
            );
            result = yield* catalog.read(threadId);
            const after = selectRuntime(
              yield* supervisor.list().pipe(Effect.orElseSucceed(() => [])),
            );
            runtime = after;
            if (runtimeSequenceStable(before, after)) break;
          }
          if (runtimeOverride !== undefined) {
            runtime = runtimeSnapshotAtSequence(runtime, runtimeOverride.sequence);
          }
        }
        const internal = yield* internalShell;
        const association = yield* Effect.tryPromise({
          try: () => associate([result.record], internal),
          catch: () =>
            privateSourceError("thread_association", "Thread project association failed."),
        });
        const lifecycle = validExternalLifecycleOverride(
          result.record,
          Option.getOrUndefined(
            yield* lifecycleOverrides
              .getBySourceKey(result.record.sourceKey)
              .pipe(
                Effect.mapError(() =>
                  privateSourceError(
                    "lifecycle_store",
                    "External Pi lifecycle state could not be loaded.",
                  ),
                ),
              ),
          ),
        );
        const projectId = association.projectIdByThread.get(threadId);
        if (projectId === undefined) {
          return yield* privateSourceError(
            "thread_unscoped",
            "This Pi session ran outside every project you added.",
          );
        }
        return projectPiThread({
          record: result.record,
          entries: entriesOverride ?? result.entries,
          projectId,
          ...(runtime === undefined ? {} : { runtime }),
          ...(lifecycle === undefined ? {} : { lifecycle }),
        });
      });

      const projectSupervisorSnapshot = Effect.fn(
        "PiExternalThreadSource.projectSupervisorSnapshot",
      )(function* (record: PiSessionCatalogRecord, runtime: SupervisorRuntimeState) {
        const first = yield* supervisor
          .subscribe(runtime.runtimeId)
          .pipe(Stream.take(1), Stream.runHead);
        if (Option.isNone(first) || first.value.type !== "snapshot") {
          return yield* readProjected(record.threadId, runtime);
        }
        const snapshot = yield* readProjected(
          record.threadId,
          first.value.runtime,
          first.value.entries,
        );
        return projectPiThreadOverlay(
          snapshot,
          record,
          first.value.events,
          yield* DateTime.now.pipe(Effect.map(DateTime.formatIso)),
          first.value.omittedOverlayEventCount,
        );
      });

      const projectRuntimeItem = Effect.fn("PiExternalThreadSource.projectRuntimeItem")(function* (
        record: PiSessionCatalogRecord,
        runtime: SupervisorRuntimeState,
        item: SupervisorStreamItem,
        liveTurnId?: TurnId,
        liveUserEvent?: SupervisorStreamEvent,
      ): Effect.fn.Return<OrchestrationThreadStreamItem | null, PiNativeError> {
        if (item.type === "synchronized") return { kind: "synchronized" };
        if (item.type === "snapshot") {
          const snapshot = yield* readProjected(record.threadId, item.runtime, item.entries);
          return {
            kind: "snapshot",
            snapshot: projectPiThreadOverlay(
              snapshot,
              record,
              item.events,
              yield* DateTime.now.pipe(Effect.map(DateTime.formatIso)),
              item.omittedOverlayEventCount,
            ),
          };
        }
        if (item.type === "entries" || item.type === "exited") {
          const currentRuntime =
            item.type === "exited"
              ? undefined
              : (yield* supervisor.list().pipe(Effect.orElseSucceed(() => []))).find(
                  (candidate) => candidate.runtimeId === runtime.runtimeId,
                );
          return {
            kind: "snapshot",
            snapshot: yield* readProjected(
              record.threadId,
              runtimeSnapshotAtSequence(currentRuntime, item.sequence),
            ),
          };
        }
        const eventType = supervisorEventType(item);
        if (isRuntimeLifecycleEvent(eventType)) {
          return {
            kind: "snapshot",
            snapshot: yield* projectSupervisorSnapshot(record, runtime),
          };
        }
        if (eventType === "agent_settled") {
          return {
            kind: "snapshot",
            snapshot: yield* readProjected(record.threadId, {
              ...runtime,
              sequence: item.sequence,
              status: "idle",
            }),
          };
        }
        if (eventType === "agent_start") {
          const currentRuntime = (yield* supervisor
            .list()
            .pipe(Effect.orElseSucceed(() => []))).find(
            (candidate) => candidate.runtimeId === runtime.runtimeId,
          );
          const snapshot = yield* readProjected(
            record.threadId,
            runtimeSnapshotAtSequence(currentRuntime, item.sequence),
          );
          return {
            kind: "snapshot",
            snapshot: projectPiThreadOverlay(
              snapshot,
              record,
              liveUserEvent ? [liveUserEvent, item] : [item],
            ),
          };
        }
        if (eventType === "queue_update") {
          return {
            kind: "snapshot",
            snapshot: yield* projectSupervisorSnapshot(record, runtime),
          };
        }
        const eventRuntime = {
          ...runtime,
          sequence: item.sequence,
        };
        const projected = projectPiLiveEvent({
          record,
          runtime: eventRuntime,
          item,
          activeTurnId: liveTurnId ?? null,
          occurredAt: yield* DateTime.now.pipe(Effect.map(DateTime.formatIso)),
        });
        return projected === null ? null : { kind: "event", event: projected };
      });

      const runtimeStream = (record: PiSessionCatalogRecord, runtime: SupervisorRuntimeState) => {
        let liveTurnId: TurnId | undefined;
        let liveUserEvent: SupervisorStreamEvent | undefined;
        let projectedThrough = -1;
        // Common thread cursors do not carry a runtime generation. A fresh
        // supervisor snapshot prevents a replacement runtime from interpreting
        // the prior runtime's numeric sequence as its own.
        return supervisor.subscribe(runtime.runtimeId).pipe(
          Stream.takeUntil((item) => item.type === "exited"),
          Stream.mapEffect((item) => {
            const sequence = item.type === "snapshot" ? item.runtime.sequence : item.sequence;
            if (item.type === "entries" || item.type === "exited") {
              liveUserEvent = undefined;
              liveTurnId = undefined;
            }
            if (
              item.type === "event" &&
              supervisorEventType(item) === "agent_start" &&
              liveUserEvent?.sequence !== item.sequence - 1
            ) {
              liveUserEvent = undefined;
              liveTurnId = undefined;
            }
            if (
              item.type !== "snapshot" &&
              item.type !== "synchronized" &&
              sequence <= projectedThrough
            ) {
              return Effect.succeed(null);
            }
            if (item.type === "snapshot") {
              liveUserEvent = item.events.findLast(
                (event) => supervisorEventType(event) === "message_start",
              );
              liveTurnId =
                liveUserEvent === undefined
                  ? undefined
                  : TurnIdSchema.make(`${record.sessionId}:live-user:${liveUserEvent.eventId}`);
            } else if (item.type === "event" && supervisorEventType(item) === "message_start") {
              liveUserEvent = item;
              liveTurnId = TurnIdSchema.make(`${record.sessionId}:live-user:${item.eventId}`);
            }
            return projectRuntimeItem(record, runtime, item, liveTurnId, liveUserEvent).pipe(
              Effect.tap((projected) =>
                Effect.sync(() => {
                  if (projected?.kind === "snapshot") {
                    projectedThrough = Math.max(
                      projectedThrough,
                      projected.snapshot.snapshotSequence,
                    );
                    if (liveUserEvent) {
                      liveTurnId = projected.snapshot.thread.latestTurn?.turnId ?? undefined;
                    }
                  } else if (projected?.kind === "event") {
                    projectedThrough = Math.max(projectedThrough, projected.event.sequence);
                  }
                }),
              ),
            );
          }),
          Stream.filter((item): item is OrchestrationThreadStreamItem => item !== null),
        );
      };

      const authoritativeThreadSnapshot = Effect.fn(
        "PiExternalThreadSource.authoritativeThreadSnapshot",
      )(function* (threadId: ThreadId) {
        if (!(yield* findRecord(threadId))) {
          return yield* privateSourceError("thread_not_found", "Native Pi thread was not found.");
        }
        const result = yield* catalog.read(threadId);
        const runtime = runtimeFor(
          result.record,
          yield* supervisor.list().pipe(Effect.orElseSucceed(() => [])),
        );
        if (!runtime) return yield* readProjected(threadId);
        return yield* projectSupervisorSnapshot(result.record, runtime);
      });

      const awaitRuntime = (record: PiSessionCatalogRecord) =>
        Stream.fromEffect(
          supervisor.list().pipe(
            Effect.map((runtimes) => runtimeFor(record, runtimes)),
            Effect.orElseSucceed(() => undefined),
          ),
        ).pipe(
          Stream.repeat(Schedule.spaced("500 millis")),
          Stream.filter((runtime): runtime is SupervisorRuntimeState => runtime !== undefined),
          Stream.take(1),
        );
      const dispatchSupervisor = Effect.fn("PiExternalThreadSource.dispatchSupervisor")(function* (
        command: SupervisorCommand,
      ) {
        const receipt = yield* supervisor.dispatch(command);
        if (receipt.status === "rejected") {
          return yield* privateSourceError("command_rejected", "Native Pi command rejected.");
        }
        return receipt;
      });

      const dispatch = Effect.fn("PiExternalThreadSource.dispatch")(function* (
        command: ClientOrchestrationCommand,
      ) {
        if (!("threadId" in command) || !isPiExternalThreadId(command.threadId)) {
          return yield* sourceError("not_external", "command is not for an external pi thread");
        }
        if (!(yield* findRecord(command.threadId))) {
          return yield* privateSourceError("thread_not_found", "Native Pi thread was not found.");
        }
        const result = yield* catalog.read(command.threadId);
        if (command.type === "thread.settle" || command.type === "thread.unsettle") {
          const lifecycleOverride = command.type === "thread.settle" ? "settled" : "active";
          const priorReceipt = yield* lifecycleOverrides
            .getByCommandId(command.commandId)
            .pipe(
              Effect.mapError(() =>
                privateSourceError(
                  "lifecycle_store",
                  "External Pi lifecycle receipt could not be loaded.",
                ),
              ),
            );
          if (Option.isSome(priorReceipt)) {
            if (
              priorReceipt.value.sourceKey !== result.record.sourceKey ||
              priorReceipt.value.lifecycleOverride !== lifecycleOverride
            ) {
              return yield* sourceError(
                "command_id_conflict",
                "The Pi lifecycle command id was already used for another operation.",
              );
            }
            const snapshot = yield* buildCatalog(true);
            yield* SubscriptionRef.set(catalogSnapshots, snapshot);
            yield* PubSub.publish(catalogInvalidations, undefined);
            yield* PubSub.publish(lifecycleInvalidations, command.threadId);
            return {
              sequence: snapshot.snapshotSequence,
              deliveryStatus: "completed",
            } satisfies DispatchResult;
          }
          const jsonlOperation = yield* catalog.findLifecycleOperation(
            command.threadId,
            command.commandId,
          );
          if (jsonlOperation !== undefined) {
            if (jsonlOperation.override !== lifecycleOverride) {
              return yield* sourceError(
                "command_id_conflict",
                "The Pi lifecycle command id was already used for another operation.",
              );
            }
            const receipt = yield* lifecycleOverrides
              .recordReceipt({
                sourceKey: result.record.sourceKey,
                commandId: command.commandId,
                lifecycleOverride,
                observedFileSize: result.record.fileSize,
                observedFileMtimeMs: result.record.fileMtimeMs,
                updatedAt: jsonlOperation.updatedAt,
              })
              .pipe(
                Effect.mapError(() =>
                  privateSourceError(
                    "lifecycle_store",
                    "External Pi lifecycle receipt could not be saved.",
                  ),
                ),
              );
            if (
              receipt.sourceKey !== result.record.sourceKey ||
              receipt.lifecycleOverride !== lifecycleOverride
            ) {
              return yield* sourceError(
                "command_id_conflict",
                "The Pi lifecycle command id was already used for another operation.",
              );
            }
            const snapshot = yield* buildCatalog(true);
            yield* SubscriptionRef.set(catalogSnapshots, snapshot);
            yield* PubSub.publish(catalogInvalidations, undefined);
            yield* PubSub.publish(lifecycleInvalidations, command.threadId);
            return {
              sequence: snapshot.snapshotSequence,
              deliveryStatus: "completed",
            } satisfies DispatchResult;
          }
          let lifecycleRuntime: SupervisorRuntimeState | undefined;
          if (command.type === "thread.settle") {
            lifecycleRuntime = runtimeFor(
              result.record,
              yield* supervisor
                .list()
                .pipe(
                  Effect.mapError(() =>
                    privateSourceError(
                      "runtime_state_unavailable",
                      "Pi runtime state could not be verified.",
                    ),
                  ),
                ),
            );
            if (
              lifecycleRuntime?.status === "starting" ||
              lifecycleRuntime?.status === "streaming"
            ) {
              return yield* sourceError(
                "active_session",
                "A running Pi session cannot be settled.",
              );
            }
          } else {
            lifecycleRuntime = runtimeFor(
              result.record,
              yield* supervisor.list().pipe(Effect.orElseSucceed(() => [])),
            );
          }
          if (
            lifecycleRuntime?.writerKind === "tuiBridge" &&
            lifecycleRuntime.status !== "starting"
          ) {
            yield* dispatchSupervisor({
              type: "setLifecycle",
              commandId: command.commandId,
              runtimeId: lifecycleRuntime.runtimeId,
              lifecycle: {
                version: 1,
                sessionId: result.record.sessionId,
                override: lifecycleOverride,
                operationId: command.commandId,
              },
            });
          }
          const updatedAt = yield* DateTime.now.pipe(Effect.map(DateTime.formatIso));
          const application = yield* lifecycleOverrides
            .apply({
              sourceKey: result.record.sourceKey,
              commandId: command.commandId,
              lifecycleOverride,
              observedFileSize: result.record.fileSize,
              observedFileMtimeMs: result.record.fileMtimeMs,
              updatedAt,
            })
            .pipe(
              Effect.mapError(() =>
                privateSourceError(
                  "lifecycle_store",
                  "External Pi lifecycle state could not be saved.",
                ),
              ),
            );
          if (
            application.value.sourceKey !== result.record.sourceKey ||
            application.value.lifecycleOverride !== lifecycleOverride
          ) {
            return yield* sourceError(
              "command_id_conflict",
              "The Pi lifecycle command id was already used for another operation.",
            );
          }
          // Reconcile on replays too: the first attempt may have committed its
          // receipt before a disconnect prevented publication to subscribers.
          const snapshot = yield* buildCatalog(true);
          yield* SubscriptionRef.set(catalogSnapshots, snapshot);
          yield* PubSub.publish(catalogInvalidations, undefined);
          yield* PubSub.publish(lifecycleInvalidations, command.threadId);
          return {
            sequence: snapshot.snapshotSequence,
            deliveryStatus: "completed",
          } satisfies DispatchResult;
        }
        const runtimes = yield* supervisor
          .list()
          .pipe(
            Effect.mapError(() =>
              privateSourceError(
                "runtime_state_unavailable",
                "Pi runtime state could not be verified.",
              ),
            ),
          );
        const runtime = runtimeFor(result.record, runtimes);
        let receipt: SupervisorCommandReceipt;
        if (command.type === "thread.turn.start") {
          const images = yield* Effect.try({
            try: () => imagesFrom(command),
            catch: (cause) => sourceError("invalid_attachment", cause),
          });
          if (images.length > 0) {
            return yield* sourceError(
              "attachments_unsupported",
              "Native Pi image attachments are unavailable.",
            );
          }
          if (!runtime) {
            return yield* sourceError(
              "read_only",
              "Catalog-only native Pi sessions cannot be resumed safely.",
            );
          } else {
            if (runtime.status === "starting") {
              return yield* sourceError("runtime_starting", "pi runtime is reconnecting");
            }
            const type = runtime.status === "streaming" ? command.streamingBehavior : "send";
            if (type === undefined) {
              return yield* sourceError(
                "streaming_behavior_required",
                "steer or followUp is required while pi is streaming",
              );
            }
            receipt = yield* dispatchSupervisor({
              type,
              commandId: command.commandId,
              runtimeId: runtime.runtimeId,
              message: command.message.text,
              ...(images.length === 0 ? {} : { images }),
            });
          }
        } else if (command.type === "thread.turn.interrupt") {
          if (!runtime || runtime.status !== "streaming") {
            return yield* sourceError("interrupt_unsupported", "pi is not streaming");
          }
          receipt = yield* dispatchSupervisor({
            type: "abort",
            commandId: command.commandId,
            runtimeId: runtime.runtimeId,
          });
        } else if (command.type === "thread.session.stop") {
          if (!runtime || runtime.status === "starting") {
            return yield* sourceError("stop_unsupported", "pi has no managed writer");
          }
          receipt = yield* dispatchSupervisor({
            type: "shutdown",
            commandId: command.commandId,
            runtimeId: runtime.runtimeId,
          });
        } else {
          return yield* sourceError(
            "unsupported_external_mutation",
            `${command.type} is not supported for external pi threads`,
          );
        }
        const sequence =
          receipt.runtimeId === undefined
            ? 0
            : ((yield* supervisor.list().pipe(Effect.orElseSucceed(() => []))).find(
                (candidate) => candidate.runtimeId === receipt.runtimeId,
              )?.sequence ?? 0);
        return {
          sequence,
          deliveryStatus: receipt.status === "indeterminate" ? "indeterminate" : "completed",
        } satisfies DispatchResult;
      });

      const initialCatalogSnapshot = yield* buildCatalog(true).pipe(
        Effect.catch(() =>
          DateTime.now.pipe(
            Effect.map(
              (now) =>
                ({
                  snapshotSequence: 0,
                  threads: [],
                  omittedThreadCount: 0,
                  ...LEGACY_CATALOG_PROJECT_FIELDS,
                  updatedAt: DateTime.formatIso(now),
                }) satisfies PiExternalCatalogSnapshot,
            ),
          ),
        ),
      );
      const catalogSnapshots = yield* SubscriptionRef.make(initialCatalogSnapshot);
      const catalogInvalidations = yield* PubSub.sliding<void>(1);
      const lifecycleInvalidations = yield* PubSub.sliding<ThreadId>(16);
      yield* Effect.addFinalizer(() => PubSub.shutdown(catalogInvalidations));
      yield* Effect.addFinalizer(() => PubSub.shutdown(lifecycleInvalidations));
      const runtimeStreamWithLifecycle = (
        record: PiSessionCatalogRecord,
        runtime: SupervisorRuntimeState,
      ) => {
        const lifecycleUpdates = Stream.fromPubSub(lifecycleInvalidations).pipe(
          Stream.filter((threadId) => threadId === record.threadId),
          Stream.mapEffect(() => readProjected(record.threadId)),
          Stream.map((snapshot) => ({
            kind: "snapshot" as const,
            snapshot,
          })),
        );
        return Stream.merge(runtimeStream(record, runtime), lifecycleUpdates, {
          haltStrategy: "left",
        });
      };
      const replacementRuntimeStreams = (record: PiSessionCatalogRecord) =>
        awaitRuntime(record).pipe(
          Stream.flatMap((runtime) => runtimeStreamWithLifecycle(record, runtime)),
          Stream.repeat(Schedule.spaced("100 millis")),
        );
      const filesystemUpdates = Stream.fromAsyncIterable(catalogTriggers(), () =>
        privateSourceError("catalog_watch", "Native Pi catalog watch failed."),
      ).pipe(
        Stream.tap(() => PubSub.publish(catalogInvalidations, undefined)),
        Stream.mapEffect(() => buildCatalog(true)),
      );
      const runtimeUpdates = Stream.fromEffect(buildCatalogForRuntimeChange()).pipe(
        Stream.repeat(Schedule.spaced("1 second")),
        Stream.filter((snapshot) => snapshot !== undefined),
      );
      yield* Stream.merge(filesystemUpdates, runtimeUpdates).pipe(
        Stream.retry(Schedule.spaced("1 second")),
        Stream.runForEach((snapshot) => SubscriptionRef.set(catalogSnapshots, snapshot)),
        Effect.forkScoped,
      );

      return PiExternalThreadSource.of({
        catalogSnapshot: () => SubscriptionRef.get(catalogSnapshots),
        subscribeCatalog: (input) => {
          let emittedSequence = -1;
          let synchronized = false;
          return SubscriptionRef.changes(catalogSnapshots).pipe(
            Stream.filter((snapshot) => {
              if (snapshot.snapshotSequence === emittedSequence) return false;
              emittedSequence = snapshot.snapshotSequence;
              return true;
            }),
            Stream.flatMap((snapshot) => {
              const snapshotItem = {
                kind: "snapshot",
                snapshot,
              } satisfies PiExternalCatalogStreamItem;
              if (input.requestCompletionMarker === true && !synchronized) {
                synchronized = true;
                return Stream.make(snapshotItem, {
                  kind: "synchronized",
                } satisfies PiExternalCatalogStreamItem);
              }
              return Stream.make(snapshotItem);
            }),
          );
        },
        resolve: findRecord,
        threadSnapshot: authoritativeThreadSnapshot,
        subscribeThread: (input) =>
          Stream.unwrap(
            Effect.gen(function* () {
              const record = yield* findRecord(input.threadId);
              if (!record) {
                return Stream.fail(
                  sourceError("thread_not_found", `Thread ${input.threadId} was not found`),
                );
              }
              const runtime = runtimeFor(
                record,
                yield* supervisor.list().pipe(Effect.orElseSucceed(() => [])),
              );
              if (runtime) {
                return Stream.concat(
                  runtimeStreamWithLifecycle(record, runtime),
                  replacementRuntimeStreams(record),
                );
              }
              const initial = yield* readProjected(input.threadId);
              const attachmentGate = new CatalogRuntimeAttachmentGate();
              const catalogUpdates = Stream.fromPubSub(catalogInvalidations).pipe(
                Stream.takeWhile(() => attachmentGate.allowsCatalogUpdate()),
                Stream.mapEffect(() => readProjected(input.threadId)),
                Stream.map((snapshot) => catalogUpdateAfterRead(attachmentGate, snapshot)),
                Stream.takeWhile((snapshot) => snapshot !== undefined),
                Stream.filter(
                  (snapshot): snapshot is OrchestrationThreadDetailSnapshot =>
                    snapshot !== undefined,
                ),
                Stream.map((snapshot) => ({
                  kind: "snapshot" as const,
                  snapshot,
                })),
              );
              return Stream.concat(
                Stream.make(
                  { kind: "snapshot" as const, snapshot: initial },
                  { kind: "synchronized" as const },
                ),
                Stream.merge(
                  catalogUpdates,
                  replacementRuntimeStreams(record).pipe(
                    Stream.tap(() =>
                      Effect.sync(() => {
                        attachmentGate.attach();
                      }),
                    ),
                  ),
                ),
              );
            }),
          ),
        createSession: (input) =>
          Effect.gen(function* () {
            const receipt = yield* dispatchSupervisor({
              type: "start",
              commandId: input.commandId,
              cwd: input.cwd,
            });
            if (!receipt.runtimeId) {
              return yield* sourceError("create_failed", "pi did not return a runtime");
            }
            const runtime = (yield* supervisor.list()).find(
              (candidate) => candidate.runtimeId === receipt.runtimeId,
            );
            const sessionFile = runtime?.sessionFile ?? receiptSessionFile(receipt);
            if (!sessionFile) {
              yield* shutdownCreatedRuntime(supervisor, receipt.runtimeId);
              return yield* sourceError("create_failed", "pi did not create a session file");
            }
            const record = (yield* catalog.list()).find(
              (candidate) => candidate.canonicalFile === sessionFile,
            );
            if (!record) {
              yield* shutdownCreatedRuntime(supervisor, receipt.runtimeId);
              return yield* sourceError("create_failed", "pi session was not cataloged");
            }
            if (!runtime || runtime.status === "exited") {
              const recovery = yield* dispatchSupervisor({
                type: "start",
                commandId: CommandIdSchema.make(`pi-create-recovery:${input.commandId}`),
                cwd: input.cwd,
                sessionFile,
              });
              const recoveredRuntime =
                recovery.runtimeId === undefined
                  ? undefined
                  : (yield* supervisor.list()).find(
                      (candidate) =>
                        candidate.runtimeId === recovery.runtimeId && candidate.status !== "exited",
                    );
              if (!recoveredRuntime) {
                if (recovery.runtimeId !== undefined) {
                  yield* shutdownCreatedRuntime(supervisor, recovery.runtimeId);
                }
                return yield* sourceError(
                  "create_failed",
                  "pi session did not retain a managed runtime",
                );
              }
            }
            const snapshot = yield* buildCatalog(true);
            yield* SubscriptionRef.set(catalogSnapshots, snapshot);
            yield* PubSub.publish(catalogInvalidations, undefined);
            return { threadId: record.threadId };
          }),
        dispatch,
      });
    }),
  );
}
