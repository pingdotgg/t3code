import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  ModelSelection,
  OrchestrationV2DomainEvent,
  OrchestrationV2ProviderSession,
  OrchestrationV2RuntimeRequest,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { ProviderWorkspaceMissingError } from "../provider/Errors.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as McpProviderSession from "../mcp/McpProviderSession.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { IdAllocatorV2 } from "./IdAllocator.ts";
import { makeKeyedSerialExecutor } from "./KeyedSerialExecutor.ts";
import { ProviderEventIngestorV2 } from "./ProviderEventIngestor.ts";
import {
  ProviderAdapterEventStreamError,
  ProviderAdapterProtocolError,
  ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2Error,
  type ProviderAdapterV2Event,
  type ProviderAdapterV2EventSubscription,
  type ProviderAdapterV2SessionRuntime,
} from "./ProviderAdapter.ts";
import { ProviderAdapterRegistryV2 } from "./ProviderAdapterRegistry.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_MAX_IDLE_PIN_MS = 4 * 60 * 60 * 1000;
const RELEASE_SCOPE_CLOSE_TIMEOUT_MS = 30 * 1000;
// OpenCode runs turn work in-band: compactThread/startTurn yield* the whole
// session.summarize inside the call instead of forking it into the session
// scope. An unbounded drain would let a stalled summarize wedge the release,
// so turn calls for these drivers get a bounded wait — the scope close is
// what aborts them. Every other adapter's turn call is acquire-then-return
// and keeps the unbounded drain: abandoning a pending acquisition (Cursor's
// runner.open) would let it install a provider resource after the session
// scope has already closed, with no finalizer left to release it.
const ADAPTER_OP_DRAIN_TIMEOUT_MS = 20 * 1000;
const INBAND_TURN_CALL_DRIVERS: ReadonlySet<ProviderDriverKind> = new Set([
  ProviderDriverKind.make("opencode"),
]);

export const ProviderSessionReleaseReason = Schema.Literals([
  "idle_timeout",
  "runtime_error",
  "manual_shutdown",
  "server_shutdown",
]);
export type ProviderSessionReleaseReason = typeof ProviderSessionReleaseReason.Type;

/**
 * ProviderSessionManager owns live session residency: open sessions, idle release,
 * explicit shutdown, and release-on-runtime-failure.
 *
 * It intentionally does not resurrect persisted sessions. Process-loss recovery
 * terminalizes provider-bound work and retires non-replayable effects; a later
 * user command or durable replay-safe operation opens a session lazily.
 */
export class ProviderSessionOpenError extends Schema.TaggedError<ProviderSessionOpenError>()(
  "ProviderSessionOpenError",
  {
    instanceId: ProviderInstanceId,
    providerSessionId: ProviderSessionId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to open provider instance ${this.instanceId} session ${this.providerSessionId}.`;
  }
}

export class ProviderSessionLookupError extends Schema.TaggedError<ProviderSessionLookupError>()(
  "ProviderSessionLookupError",
  {
    providerSessionId: ProviderSessionId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to look up provider session ${this.providerSessionId}.`;
  }
}

export class ProviderSessionCloseError extends Schema.TaggedError<ProviderSessionCloseError>()(
  "ProviderSessionCloseError",
  {
    providerSessionId: ProviderSessionId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to close provider session ${this.providerSessionId}.`;
  }
}

export class ProviderSessionReleaseError extends Schema.TaggedError<ProviderSessionReleaseError>()(
  "ProviderSessionReleaseError",
  {
    providerSessionId: ProviderSessionId,
    reason: ProviderSessionReleaseReason,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to release provider session ${this.providerSessionId}.`;
  }
}

const isProviderSessionReleaseError = Schema.is(ProviderSessionReleaseError);

export class ProviderSessionActivityError extends Schema.TaggedError<ProviderSessionActivityError>()(
  "ProviderSessionActivityError",
  {
    providerSessionId: ProviderSessionId,
    cause: Schema.optional(Schema.Defect()),
  },
) {
  override get message(): string {
    return `Failed to update provider session activity for ${this.providerSessionId}.`;
  }
}

export const ProviderSessionManagerV2Error = Schema.Union([
  ProviderSessionOpenError,
  ProviderWorkspaceMissingError,
  ProviderSessionLookupError,
  ProviderSessionCloseError,
  ProviderSessionReleaseError,
  ProviderSessionActivityError,
]);
export type ProviderSessionManagerV2Error = typeof ProviderSessionManagerV2Error.Type;

export interface ProviderSessionManagerV2Shape {
  readonly shutdown: Effect.Effect<void>;
  readonly open: (input: {
    readonly threadId: ThreadId;
    readonly providerSessionId: ProviderSessionId;
    readonly modelSelection: ModelSelection;
    readonly runtimePolicy: ProviderAdapterV2RuntimePolicy;
    readonly resumeFromSession?: OrchestrationV2ProviderSession;
    readonly initialNativeThreadId?: string;
    readonly initialProviderItemIdentityVersion?: 2;
  }) => Effect.Effect<ProviderAdapterV2SessionRuntime, ProviderSessionManagerV2Error>;
  readonly get: (
    providerSessionId: ProviderSessionId,
  ) => Effect.Effect<Option.Option<ProviderAdapterV2SessionRuntime>, ProviderSessionManagerV2Error>;
  readonly close: (
    providerSessionId: ProviderSessionId,
  ) => Effect.Effect<void, ProviderSessionManagerV2Error>;
  /** Closes every live runtime owned by one provider instance. */
  readonly closeInstance: (
    instanceId: ProviderInstanceId,
  ) => Effect.Effect<void, ProviderSessionManagerV2Error>;
  readonly release: (input: {
    readonly providerSessionId: ProviderSessionId;
    readonly reason: ProviderSessionReleaseReason;
    readonly detail?: string;
  }) => Effect.Effect<void, ProviderSessionManagerV2Error>;
  readonly detach: (input: {
    readonly providerSessionId: ProviderSessionId;
    readonly threadId: ThreadId;
    readonly detail?: string;
    /**
     * True for terminal detaches (thread archived or deleted): the thread's
     * MCP credentials are revoked immediately instead of surviving for a
     * potential re-attach.
     */
    readonly revokeMcpCredential?: boolean;
  }) => Effect.Effect<void, ProviderSessionManagerV2Error>;
}

export class ProviderSessionManagerV2 extends Context.Service<
  ProviderSessionManagerV2,
  ProviderSessionManagerV2Shape
>()("t3/orchestration-v2/ProviderSessionManager/ProviderSessionManagerV2") {}

interface LiveSessionEntry {
  readonly attachedThreadIds: ReadonlySet<ThreadId>;
  readonly loadedProviderThreadKeyByThread: ReadonlyMap<ThreadId, string>;
  /**
   * MCP credential session id issued for each attached thread. Revocation on
   * detach/release is scoped to these ids so tearing down a superseded
   * session cannot revoke a replacement session's credential for the same
   * thread (the workspace-handoff sequence opens the replacement before the
   * outbox executes the old session's detach).
   */
  readonly mcpCredentialIdByThread: ReadonlyMap<ThreadId, string>;
  readonly supportsMultipleProviderThreads: boolean;
  readonly runtime: ProviderAdapterV2SessionRuntime;
  readonly exposedRuntime: ProviderAdapterV2SessionRuntime;
  readonly eventSubscribers: Ref.Ref<
    ReadonlyMap<number, Queue.Queue<ProviderSessionEventSignal, Cause.Done>>
  >;
  readonly requestEventPermit: Semaphore.Semaphore;
  readonly scope: Scope.Closeable;
  readonly idleGeneration: number;
  readonly busyCount: number;
  readonly lastActivityAtMs: number;
  readonly idleFiber: Fiber.Fiber<void, never> | null;
  /** Set when idle release is deferred for pending background work; bounds total deferral. */
  readonly pinnedSinceMs: number | null;
}

interface PendingSessionRelease {
  readonly entry: LiveSessionEntry;
  readonly threadIds: ReadonlySet<ThreadId>;
  readonly mcpCredentialIdByThread: Map<ThreadId, string>;
  readonly done: Deferred.Deferred<void, ProviderSessionReleaseError>;
}

interface OpeningSessionRecord {
  readonly providerSessionId: ProviderSessionId;
  readonly threadId: ThreadId;
  readonly instanceId: ProviderInstanceId;
  closeRequested: boolean;
  failed: ProviderSessionReleaseError | undefined;
  readonly settled: Deferred.Deferred<void, ProviderSessionReleaseError>;
}

type ProviderSessionEventSignal =
  | { readonly type: "event"; readonly event: ProviderAdapterV2Event }
  | {
      readonly type: "failure";
      readonly cause: Cause.Cause<ProviderAdapterV2Error>;
    };

export interface ProviderSessionManagerV2LayerOptions {
  readonly idleTimeoutMs?: number;
  /** Cap on how long idle release may be deferred for pending background work. */
  readonly maxIdlePinMs?: number;
  /** Test replay harnesses can omit T3's MCP server from provider protocol fixtures. */
  readonly configureMcp?: boolean;
}

function releaseStatusFor(
  reason: ProviderSessionReleaseReason,
): OrchestrationV2ProviderSession["status"] {
  return reason === "runtime_error" ? "error" : "stopped";
}

function releasedRuntimeRequestStatusFor(
  reason: ProviderSessionReleaseReason,
): OrchestrationV2RuntimeRequest["status"] {
  return reason === "manual_shutdown" || reason === "server_shutdown" ? "cancelled" : "expired";
}

function sessionKey(providerSessionId: ProviderSessionId): string {
  return String(providerSessionId);
}

/**
 * Runtime requests with no provider turn belong to the live session itself.
 * Their node and transcript item are runless too, so they bypass the normal
 * per-run subscriber and are persisted by the session event pump.
 */
function sessionScopedRuntimeRequestThreadId(event: ProviderAdapterV2Event): ThreadId | undefined {
  switch (event.type) {
    case "runtime_request.updated":
      return event.runtimeRequest.providerTurnId === null ? event.threadId : undefined;
    case "node.updated":
      return event.node.runId === null && event.node.runtimeRequestId !== null
        ? event.node.threadId
        : undefined;
    case "turn_item.updated":
      return event.turnItem.runId === null &&
        (event.turnItem.type === "approval_request" || event.turnItem.type === "user_input_request")
        ? event.turnItem.threadId
        : undefined;
    default:
      return undefined;
  }
}

function providerThreadRuntimeKey(
  providerThread: Parameters<ProviderAdapterV2SessionRuntime["resumeThread"]>[0]["providerThread"],
): string {
  const nativeThreadRef = providerThread.nativeThreadRef;
  return nativeThreadRef === null
    ? String(providerThread.id)
    : `${nativeThreadRef.driver}:${nativeThreadRef.nativeId}`;
}

function providerThreadLoadKey(input: {
  readonly providerThread: Parameters<
    ProviderAdapterV2SessionRuntime["resumeThread"]
  >[0]["providerThread"];
  readonly modelSelection?: ModelSelection;
  readonly runtimePolicy?: ProviderAdapterV2RuntimePolicy;
}): string {
  return JSON.stringify({
    providerThread: providerThreadRuntimeKey(input.providerThread),
    modelSelection: input.modelSelection ?? null,
    runtimePolicy: input.runtimePolicy ?? null,
  });
}

export const layerWithOptions = (
  options: ProviderSessionManagerV2LayerOptions = {},
): Layer.Layer<
  ProviderSessionManagerV2,
  never,
  | EventSinkV2
  | FileSystem.FileSystem
  | IdAllocatorV2
  | McpSessionRegistry.McpSessionRegistry
  | ProjectionStoreV2
  | ProviderEventIngestorV2
  | ProviderAdapterRegistryV2
> =>
  Layer.effect(
    ProviderSessionManagerV2,
    Effect.gen(function* () {
      const registry = yield* ProviderAdapterRegistryV2;
      const fileSystem = yield* FileSystem.FileSystem;
      const mcpSessionRegistry = yield* McpSessionRegistry.McpSessionRegistry;
      /**
       * Optional so the many focused tests that assemble this layer by hand do
       * not each need a settings stub; the production composition always
       * provides it. When present, an unreadable settings file withholds
       * browser access rather than granting it — an explicit "off" silently
       * becoming "on" would violate the user's stated choice, whereas the
       * reverse costs an agent one toolset and is visible immediately (#7083).
       */
      const serverSettings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
      const projectService = yield* Effect.serviceOption(ProjectService.ProjectService);
      const eventSink = yield* EventSinkV2;
      const idAllocator = yield* IdAllocatorV2;
      const providerEventIngestor = yield* ProviderEventIngestorV2;
      const projectionStore = yield* ProjectionStoreV2;
      const agentAccessSettings = Effect.fn("ProviderSessionManagerV2.agentAccessSettings")(
        function* (threadId: ThreadId) {
          if (Option.isNone(serverSettings)) return { browser: true, device: false };
          return yield* Effect.gen(function* () {
            const settings = yield* serverSettings.value.getSettings;
            const thread = yield* projectionStore.getThread(threadId);
            const entries = Object.values(settings.projectSettingsOverrides);
            const browserOverridden = entries.some(
              (entry) => entry.enableAgentBrowserAccess !== undefined,
            );
            const deviceOverridden = entries.some(
              (entry) => entry.enableAgentDeviceAccess !== undefined,
            );
            if (browserOverridden || deviceOverridden) {
              const project = Option.isSome(projectService)
                ? yield* projectService.value.getById(thread.projectId)
                : Option.none();
              if (Option.isNone(project))
                return {
                  browser: browserOverridden ? false : settings.enableAgentBrowserAccess,
                  device: deviceOverridden ? false : settings.enableAgentDeviceAccess,
                };
            }
            const effective = resolveProjectSettings(settings, thread.projectId).settings;
            return {
              browser: effective.enableAgentBrowserAccess,
              device: effective.enableAgentDeviceAccess,
            };
          }).pipe(
            Effect.catch((cause) =>
              Effect.logWarning(
                "Could not resolve agent access; withholding browser and device tools.",
                { threadId, cause },
              ).pipe(Effect.as({ browser: false, device: false })),
            ),
          );
        },
      );
      const layerScope = yield* Effect.scope;
      const sessions = yield* Ref.make(new Map<string, LiveSessionEntry>());

      // Keep ownership after removal from the live map until cleanup actually finishes.
      const releasing = new Map<string, PendingSessionRelease>();
      // Adapter operations that may create native resources (ensureThread,
      // resumeThread) register here before invoking the adapter and settle the
      // deferred when they exit. A release drains the set before closing the
      // session scope so a late adapter result can never be installed after
      // the finalizer that would have closed it.
      const inflightAdapterOps = new Map<
        string,
        Set<{
          readonly done: Deferred.Deferred<void, never>;
          readonly drainTimeout: Duration.Duration | undefined;
        }>
      >();
      // Startup ownership before a session entry exists: the open registers
      // here before any adapter work so a racing close/detach can mark it and
      // join its unwind instead of reporting success over a spawning provider
      // process. `closeRequested`/`failed` are only written inside
      // Ref.modify(sessions) or the opening fiber's uninterruptible unwind, so
      // the registration fence below reads them atomically.
      const opening = new Map<string, OpeningSessionRecord>();
      // Teardown fences: once closeInstance bumps its instance's count (or
      // shutdown flips the flag), no new startup record may be created and
      // no in-flight startup may register — a record created afterwards
      // would escape the mark-and-join the close performs on the records it
      // saw. Read and written only inside synchronous steps (Ref.modify or
      // straight-line gen code), where no other fiber can interleave.
      const closingInstanceCounts = new Map<ProviderInstanceId, number>();
      let shutdownInitiated = false;
      // Terminal-detach revocations outlive the call that started them: each
      // tracked sweep owns the credentials its caller pruned, so a retry
      // joins this record (bounded like any cleanup wait) and queues its own
      // captured set behind it instead of discarding or duplicating work.
      interface PendingRevocation {
        // Attribution reflects only sweeps still running: each record carries
        // its own caller's instance and a link to the sweep it waits behind,
        // and `settled` marks a record whose own sweep finished — a completed
        // predecessor must not keep its caller's teardown waiting on a
        // successor it does not own. undefined means the sweep could not be
        // attributed and must be joined by every closeInstance.
        readonly instanceId: ProviderInstanceId | undefined;
        readonly predecessor: PendingRevocation | undefined;
        settled: boolean;
        readonly done: Deferred.Deferred<void, ProviderSessionReleaseError>;
      }
      const pendingRevocations = new Map<ThreadId, PendingRevocation>();
      // Every running detach carries one marker from its first uninterruptible
      // step to its exit. Teardown drains this set before snapshotting
      // pendingRevocations: a detach that started earlier can still be inside
      // its lock, not yet at the forkTrackedRevocation call that registers the
      // sweep, and a one-time snapshot would return while that tail is still
      // being created.
      interface InflightDetach {
        readonly providerSessionId: ProviderSessionId;
        readonly threadId: ThreadId;
        readonly detached: Deferred.Deferred<void, never>;
        // Captured once the detach's body resolves which instance's entry it
        // is detaching from: the maps can re-resolve the session id to a
        // same-id replacement owned by another instance, so drain attribution
        // reads what the detach observed, not what owns the key now.
        // `ownershipResolved` distinguishes "has not looked yet" (fall back to
        // the maps) from "looked and found no entry" (an unattributed tail —
        // owned by every teardown, so the marker must still be drained).
        ownershipResolved: boolean;
        instanceId: ProviderInstanceId | undefined;
        // Published when the detach registers its tracked sweep. The record
        // leaves pendingRevocations on settle, so a tail that registers and
        // finishes while teardown is draining this marker is joined through
        // this deferred instead.
        revokeDone: Deferred.Deferred<void, ProviderSessionReleaseError> | undefined;
      }
      const inflightDetaches = new Set<InflightDetach>();
      // Joins every unfinished revocation record matching `owned` and drains
      // in-flight detaches that may still register a matching sweep — a tail
      // registered while an earlier pass was joining is still awaited rather
      // than left running past teardown. Each marker is awaited at most once:
      // one that outlives its bound is reported through `awaitInflight`, not
      // re-waited — the detach is already past the contract and re-waiting
      // would make teardown unbounded. Every pass collects records, markers,
      // and published tails in one synchronous stretch before deciding, so
      // nothing can register between the last scan and the return.
      const joinTrackedRevocations = (
        owned: (record: PendingRevocation) => boolean,
        join: (
          threadId: ThreadId,
          done: Deferred.Deferred<void, ProviderSessionReleaseError>,
        ) => Effect.Effect<void, ProviderSessionReleaseError>,
        awaitInflight: (marker: InflightDetach) => Effect.Effect<void, ProviderSessionReleaseError>,
        ownsInflight: (
          marker: InflightDetach,
          live: ReadonlyMap<string, LiveSessionEntry>,
        ) => boolean,
      ) =>
        Effect.gen(function* () {
          const outcomes: Array<Exit.Exit<void, ProviderSessionReleaseError>> = [];
          const joined = new Set<Deferred.Deferred<void, ProviderSessionReleaseError>>();
          const awaited = new Set<InflightDetach>();
          for (;;) {
            const live = yield* Ref.get(sessions);
            const fresh: Array<
              readonly [ThreadId, Deferred.Deferred<void, ProviderSessionReleaseError>]
            > = [];
            for (const [threadId, record] of pendingRevocations) {
              for (
                let current: PendingRevocation | undefined = record;
                current !== undefined;
                current = current.predecessor
              ) {
                if (!current.settled && owned(current) && !joined.has(current.done)) {
                  joined.add(current.done);
                  fresh.push([threadId, current.done]);
                }
              }
            }
            const pending: Array<InflightDetach> = [];
            const lateTails: Array<
              readonly [ThreadId, Deferred.Deferred<void, ProviderSessionReleaseError>]
            > = [];
            for (const marker of inflightDetaches) {
              if (!ownsInflight(marker, live)) continue;
              if (!awaited.has(marker)) {
                awaited.add(marker);
                pending.push(marker);
              }
              const tail = marker.revokeDone;
              if (tail !== undefined && !joined.has(tail)) {
                joined.add(tail);
                lateTails.push([marker.threadId, tail]);
              }
            }
            if (fresh.length === 0 && pending.length === 0 && lateTails.length === 0) {
              return outcomes;
            }
            const joins: Array<Effect.Effect<Exit.Exit<void, ProviderSessionReleaseError>>> = [
              ...[...fresh, ...lateTails].map(([threadId, done]) =>
                join(threadId, done).pipe(Effect.exit),
              ),
              ...pending.map((marker) => awaitInflight(marker).pipe(Effect.exit)),
            ];
            const pass = yield* Effect.all(joins, { concurrency: "unbounded" });
            outcomes.push(...pass);
            // A marker that just exited published its tail at most once; join
            // it here, while the detach's completion has made the field final.
            const tailJoins: Array<Effect.Effect<Exit.Exit<void, ProviderSessionReleaseError>>> =
              [];
            for (const marker of pending) {
              const tail = marker.revokeDone;
              if (tail !== undefined && !joined.has(tail)) {
                joined.add(tail);
                tailJoins.push(join(marker.threadId, tail).pipe(Effect.exit));
              }
            }
            outcomes.push(...(yield* Effect.all(tailJoins, { concurrency: "unbounded" })));
          }
        });
      const forkTrackedRevocation = <E>(
        providerSessionId: ProviderSessionId,
        threadId: ThreadId,
        revoke: Effect.Effect<void, E>,
        instanceId: ProviderInstanceId | undefined,
        onRegistered?: (done: Deferred.Deferred<void, ProviderSessionReleaseError>) => void,
      ) =>
        // Registration and the worker fork are one uninterruptible handoff:
        // an interrupt landing between them would leave a tail whose `done`
        // never settles, parking every later join and chaining every retry
        // behind it. The forked worker is a separate fiber and is unaffected.
        // `onRegistered` runs inside the same handoff so a caller publishing
        // the deferred (an in-flight detach marker) cannot be interrupted out
        // of that publication while the record is already visible.
        Effect.uninterruptible(
          Effect.gen(function* () {
            // A tracked sweep captures only the credentials its caller pruned;
            // joining it must not discard this caller's own set. Every call
            // registers its own completion and chains its sweep behind the
            // previous one, so a later retry always joins the newest tail.
            const predecessor = pendingRevocations.get(threadId);
            const done = Deferred.makeUnsafe<void, ProviderSessionReleaseError>();
            const record: PendingRevocation = {
              instanceId,
              predecessor,
              settled: false,
              done,
            };
            pendingRevocations.set(threadId, record);
            onRegistered?.(done);
            yield* Effect.gen(function* () {
              if (predecessor !== undefined) {
                // A failed predecessor reports on its own deferred; this
                // caller's captured credentials still need their sweep.
                yield* Effect.ignore(Deferred.await(predecessor.done));
              }
              const exit = yield* Effect.exit(revoke);
              // The record must come down with its completion: a stale entry
              // would let a later retry join a finished sweep and skip
              // revoking a freshly configured binding. A chained successor
              // may already have replaced the map entry — only delete our own.
              yield* Effect.uninterruptible(
                Effect.gen(function* () {
                  record.settled = true;
                  if (pendingRevocations.get(threadId) === record) {
                    pendingRevocations.delete(threadId);
                  }
                  yield* Deferred.done(
                    done,
                    Exit.isSuccess(exit)
                      ? Exit.void
                      : Exit.fail(
                          new ProviderSessionReleaseError({
                            providerSessionId,
                            reason: "runtime_error",
                            cause: exit.cause,
                          }),
                        ),
                  );
                }),
              );
            }).pipe(Effect.forkDetach({ startImmediately: true }));
            return done;
          }),
        );
      const findPendingRelease = (
        providerSessionId: ProviderSessionId,
        threadId: ThreadId,
        existing: LiveSessionEntry | undefined,
      ) =>
        Array.from(releasing.values()).find(
          (release) =>
            release.entry.runtime.providerSessionId === providerSessionId ||
            (release.threadIds.has(threadId) && !existing?.attachedThreadIds.has(threadId)),
        );
      // A startup record that failed its unwind, or is still unwinding after a
      // close request, may still own provider resources for its session id and
      // thread — the same contract findPendingRelease enforces for releases.
      const findBlockingStartup = (providerSessionId: ProviderSessionId, threadId: ThreadId) =>
        Array.from(opening.values()).find(
          (record) =>
            (record.providerSessionId === providerSessionId || record.threadId === threadId) &&
            (record.closeRequested || record.failed !== undefined),
        );
      // Runtime methods attach threads outside `open`, so the pending-release
      // block must hold here too — and it must propagate: observeActivity only
      // logs bookkeeping failures.
      const rejectPendingThreadAttachment = (input: {
        readonly providerSessionId: ProviderSessionId;
        readonly threadId: ThreadId;
        readonly driver: ProviderDriverKind;
      }) =>
        Effect.gen(function* () {
          const existing = (yield* Ref.get(sessions)).get(sessionKey(input.providerSessionId));
          if (
            findPendingRelease(input.providerSessionId, input.threadId, existing) !== undefined ||
            findBlockingStartup(input.providerSessionId, input.threadId) !== undefined
          ) {
            return yield* new ProviderAdapterProtocolError({
              driver: input.driver,
              detail: "A previous provider session has not finished cleanup.",
            });
          }
        });
      const nextSubscriberId = yield* Ref.make(0);
      const sessionOpen = yield* makeKeyedSerialExecutor<ProviderSessionId>();
      const threadLifecycle = yield* makeKeyedSerialExecutor<ThreadId>();
      const releaseStatus = yield* makeKeyedSerialExecutor<ProviderSessionId>();
      // Serializes attaches of one thread to one session: a concurrent caller
      // must wait for an in-flight attach to become durable instead of riding
      // its provisional attachment — an attach that later fails unwinds the
      // bookkeeping and credential claim the second caller was relying on.
      // The key carries the runtime's identity, not just session+thread: a
      // same-id reopen always installs a new runtime, and an abandoned in-band
      // call (e.g. an OpenCode turn call still running past its drain bound)
      // must not serialize the replacement's attaches behind a lock the dead
      // runtime may never release.
      const threadAttach = yield* makeKeyedSerialExecutor<string>();
      const threadAttachRuntimeSeq = new WeakMap<ProviderAdapterV2SessionRuntime, number>();
      let nextThreadAttachRuntimeSeq = 0;
      const threadAttachKey = (
        providerSessionId: ProviderSessionId,
        runtime: ProviderAdapterV2SessionRuntime | undefined,
        threadId: ThreadId,
      ) => {
        let seq = -1;
        if (runtime !== undefined) {
          const existing = threadAttachRuntimeSeq.get(runtime);
          if (existing === undefined) {
            seq = nextThreadAttachRuntimeSeq++;
            threadAttachRuntimeSeq.set(runtime, seq);
          } else {
            seq = existing;
          }
        }
        return `${providerSessionId}\0${seq}\0${threadId}`;
      };
      const idleTimeoutMs = Math.max(1, options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS);
      const maxIdlePinMs = Math.max(0, options.maxIdlePinMs ?? DEFAULT_MAX_IDLE_PIN_MS);
      interface PreparedMcpCredential {
        readonly mcpCredentialId: string | undefined;
      }
      /**
       * Reservations protect a credential between prepareMcpSession handing it
       * out and the owning session entry becoming visible in `sessions`.
       * Adapters like ACP and OpenCode consume the credential eagerly during
       * openSession, so a racing release must not revoke it in that window
       * (rotating afterwards cannot repair an already-configured process).
       * The holder MUST drop the reservation once the entry is recorded or the
       * open fails.
       */
      const mcpCredentialReservations = new Map<string, number>();
      const mcpReservationKey = (threadId: ThreadId, mcpCredentialId: string) =>
        `${threadId}\0${mcpCredentialId}`;
      const reserveMcpCredential = (threadId: ThreadId, mcpCredentialId: string) => {
        const key = mcpReservationKey(threadId, mcpCredentialId);
        mcpCredentialReservations.set(key, (mcpCredentialReservations.get(key) ?? 0) + 1);
      };
      const dropMcpCredentialReservation = (threadId: ThreadId, mcpCredentialId: string) => {
        const key = mcpReservationKey(threadId, mcpCredentialId);
        const count = mcpCredentialReservations.get(key) ?? 0;
        if (count <= 1) {
          mcpCredentialReservations.delete(key);
        } else {
          mcpCredentialReservations.set(key, count - 1);
        }
      };
      const isMcpCredentialReserved = (threadId: ThreadId, mcpCredentialId: string) =>
        (mcpCredentialReservations.get(mcpReservationKey(threadId, mcpCredentialId)) ?? 0) > 0;
      // Anything still able to claim a credential: a held reservation, a live
      // session's or pending release's recorded credential. Claims are
      // credential-specific: a session attached to the thread claims only the
      // credential it recorded at attach — a rotated-out token may still be
      // held by a different session, and a session's own record is the claim
      // that decides that. The attach-to-record gap is covered by the
      // reservation prepareMcpSession holds until the entry records it.
      // Read `sessions` first and pass the same snapshot in.
      const isMcpCredentialClaimed = (
        current: ReadonlyMap<string, LiveSessionEntry>,
        threadId: ThreadId,
        mcpCredentialId: string,
      ) =>
        isMcpCredentialReserved(threadId, mcpCredentialId) ||
        Array.from(current.values()).some(
          (other) => other.mcpCredentialIdByThread.get(threadId) === mcpCredentialId,
        ) ||
        Array.from(releasing.values()).some(
          (other) => other.mcpCredentialIdByThread.get(threadId) === mcpCredentialId,
        );
      const mcpPrepareLock = yield* makeKeyedSerialExecutor<ThreadId>();
      /**
       * Revokes the credential when no live session, pending release, or
       * in-flight reservation still claims it. Callers must already hold
       * mcpPrepareLock for this thread — every reservation is taken there, so
       * the claim check and the delete must run under it too or a prepare
       * could reserve and resolve the credential in between and end up
       * holding a revoked token.
       */
      const releaseUnclaimedMcpCredentialPrepared = (threadId: ThreadId, mcpCredentialId: string) =>
        Effect.gen(function* () {
          const claimed = isMcpCredentialClaimed(
            yield* Ref.get(sessions),
            threadId,
            mcpCredentialId,
          );
          if (!claimed) {
            yield* clearMcpSession(threadId, mcpCredentialId).pipe(Effect.ignore);
          }
        });
      const releaseUnclaimedMcpCredential = (threadId: ThreadId, mcpCredentialId: string) =>
        mcpPrepareLock.withLock(
          threadId,
          releaseUnclaimedMcpCredentialPrepared(threadId, mcpCredentialId),
        );

      /**
       * Terminal-detach credential revocation: the thread is gone, so its
       * config slot is cleared while it still binds one of the credentials
       * this detach captured — a different session may have reconfigured the
       * thread while the sweep was suspended, and that binding is not ours
       * to clear. Each known credential is revoked only once nothing claims
       * it: a credential shared with a still-live session or pending release
       * stays valid until its final holder's own cleanup revokes it.
       */
      const revokeUnclaimedThreadCredentials = (
        threadId: ThreadId,
        extraCredentialIds: Iterable<string>,
      ) =>
        Effect.gen(function* () {
          const captured = new Set(extraCredentialIds);
          const candidates = new Set(captured);
          const configured = McpProviderSession.readMcpProviderSession(threadId)?.providerSessionId;
          if (configured !== undefined) {
            candidates.add(configured);
          }
          yield* Effect.forEach(
            candidates,
            (mcpCredentialId) => releaseUnclaimedMcpCredential(threadId, mcpCredentialId),
            { discard: true },
          );
          // Re-read under the prepare lock: a peer prepare may have
          // configured a fresh credential while the candidate sweep ran.
          yield* mcpPrepareLock.withLock(
            threadId,
            Effect.sync(() => {
              const configuredNow =
                McpProviderSession.readMcpProviderSession(threadId)?.providerSessionId;
              if (configuredNow === undefined || captured.has(configuredNow)) {
                McpProviderSession.clearMcpProviderSession(threadId);
              }
            }),
          );
        });

      /**
       * Resolves (or mints) the thread's MCP credential and returns it with a
       * reservation held; the caller must drop the reservation exactly once.
       * Serialized per thread so two concurrent prepares cannot interleave
       * their rotate steps and revoke each other's freshly minted credential.
       */
      const prepareMcpSession = (
        threadId: ThreadId,
        providerInstanceId: ProviderInstanceId,
        /**
         * Invoked synchronously every time this call's held reservation
         * changes: with the credential id as each one is reserved, and with
         * undefined when a reservation is dropped internally (a resolved
         * credential that mismatched is released before issuing a fresh one).
         * Callers track it so a failed or interrupted prepare can still drop
         * the reservation it currently holds.
         */
        onReservationChanged?: (mcpCredentialId: string | undefined) => void,
      ): Effect.Effect<PreparedMcpCredential> =>
        options.configureMcp === false
          ? Effect.sync((): PreparedMcpCredential => {
              McpProviderSession.clearMcpProviderSession(threadId);
              return { mcpCredentialId: undefined };
            })
          : mcpPrepareLock.withLock(
              threadId,
              Effect.gen(function* () {
                // Reuse a still-valid credential for this thread instead of
                // rotating: long-lived provider processes (codex app-server)
                // build their MCP client once per conversation and keep using
                // the credential it started with, so a thread that detaches and
                // re-attaches across a workspace handoff must come back to the
                // same token or the process's tool calls fail auth.
                const { browser: browserToolsAvailable, device: deviceToolsAvailable } =
                  yield* agentAccessSettings(threadId);
                const capabilities = new Set<
                  import("../mcp/McpInvocationContext.ts").McpCapability
                >(["orchestration", "worktree", "pull-requests"]);
                if (browserToolsAvailable) capabilities.add("preview");
                if (deviceToolsAvailable) capabilities.add("device");
                const existing = McpProviderSession.readMcpProviderSession(threadId);
                if (existing !== undefined) {
                  // Reserve before the async resolve so a release cannot
                  // revoke the credential between validation and reservation.
                  // The caller tracks the in-flight reservation through
                  // onReservationChanged so a failed or interrupted prepare
                  // can still unwind it.
                  reserveMcpCredential(threadId, existing.providerSessionId);
                  onReservationChanged?.(existing.providerSessionId);
                  const rawToken = existing.authorizationHeader.replace(/^Bearer\s+/, "");
                  const resolved = yield* mcpSessionRegistry.resolve(rawToken);
                  if (
                    resolved !== undefined &&
                    resolved.threadId === threadId &&
                    resolved.providerInstanceId === providerInstanceId &&
                    // A flipped browser-access setting must not survive through
                    // credential reuse: rotate so the new scope reflects it.
                    resolved.capabilities.has("preview") === browserToolsAvailable &&
                    resolved.capabilities.has("device") === deviceToolsAvailable
                  ) {
                    return { mcpCredentialId: existing.providerSessionId };
                  }
                  dropMcpCredentialReservation(threadId, existing.providerSessionId);
                  // The dropped reservation may have been the credential's
                  // last claim: holders that closed while resolve was
                  // suspended already discarded their records.
                  onReservationChanged?.(undefined);
                  yield* releaseUnclaimedMcpCredentialPrepared(
                    threadId,
                    existing.providerSessionId,
                  );
                }
                // No thread-wide revocation here: a mismatched credential was
                // already revoked above when unclaimed, and a still-claimed
                // one belongs to a live process that keeps using it until its
                // final holder releases it.
                const credential = yield* mcpSessionRegistry.issue({
                  threadId,
                  providerInstanceId,
                  browserToolsAvailable,
                  capabilities,
                });
                McpProviderSession.setMcpProviderSession(credential.config);
                reserveMcpCredential(threadId, credential.config.providerSessionId);
                onReservationChanged?.(credential.config.providerSessionId);
                return { mcpCredentialId: credential.config.providerSessionId };
              }),
            );
      /**
       * Revocation is always scoped to one credential, and the config slot is
       * cleared only while it still holds it; a replacement session's newer
       * credential survives.
       */
      const clearMcpSession = (threadId: ThreadId, mcpCredentialId: string) =>
        mcpSessionRegistry.revokeProviderSession(mcpCredentialId).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              if (
                McpProviderSession.readMcpProviderSession(threadId)?.providerSessionId ===
                mcpCredentialId
              ) {
                McpProviderSession.clearMcpProviderSession(threadId);
              }
            }),
          ),
        );

      const publishToSubscribers = (
        subscribers: Ref.Ref<
          ReadonlyMap<number, Queue.Queue<ProviderSessionEventSignal, Cause.Done>>
        >,
        signal: ProviderSessionEventSignal,
      ) =>
        Ref.get(subscribers).pipe(
          Effect.flatMap((current) =>
            Effect.forEach(current.values(), (queue) => Queue.offer(queue, signal), {
              discard: true,
            }),
          ),
        );

      const failSubscribers = (entry: LiveSessionEntry, detail: string) =>
        Effect.gen(function* () {
          const error = new ProviderAdapterEventStreamError({
            driver: entry.runtime.driver,
            providerSessionId: entry.runtime.providerSessionId,
            cause: detail,
          });
          const subscribers = yield* Ref.getAndSet(entry.eventSubscribers, new Map());
          yield* Effect.forEach(
            subscribers.values(),
            (queue) =>
              Queue.offer(queue, {
                type: "failure",
                cause: Cause.fail(error),
              }),
            { discard: true },
          );
        });

      const closeSubscribers = (entry: LiveSessionEntry) =>
        Effect.gen(function* () {
          const subscribers = yield* Ref.getAndSet(entry.eventSubscribers, new Map());
          yield* Effect.forEach(
            subscribers.values(),
            (queue) => Queue.clear(queue).pipe(Effect.andThen(Queue.end(queue))),
            { discard: true },
          );
        });

      // Preserve already-published terminal events while ending subscriptions.
      // Server shutdown intentionally clears them; a provider-announced Stop
      // must let consumers drain them before the stream completes.
      const endSubscribers = (entry: LiveSessionEntry) =>
        Effect.gen(function* () {
          const subscribers = yield* Ref.getAndSet(entry.eventSubscribers, new Map());
          yield* Effect.forEach(subscribers.values(), (queue) => Queue.end(queue), {
            discard: true,
          });
        });

      const cancelIdleFiber = (fiber: Fiber.Fiber<void, never> | null) =>
        fiber === null ? Effect.void : Fiber.interrupt(fiber).pipe(Effect.ignore);

      const writeProviderSessionEvents = (input: {
        readonly runtime: ProviderAdapterV2SessionRuntime;
        readonly threadIds: Iterable<ThreadId>;
        readonly type: "provider-session.attached" | "provider-session.updated";
        readonly payload: OrchestrationV2ProviderSession;
      }) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const events = yield* Effect.forEach(input.threadIds, (threadId) =>
            Effect.gen(function* () {
              return {
                id: yield* idAllocator.allocate.event({
                  threadId,
                  providerSessionId: input.runtime.providerSessionId,
                }),
                type: input.type,
                threadId,
                driver: input.runtime.driver,
                providerInstanceId: input.runtime.instanceId,
                occurredAt: now,
                payload: input.payload,
              } satisfies OrchestrationV2DomainEvent;
            }),
          );
          if (events.length > 0) {
            yield* eventSink.write({ events });
          }
        });

      const writeReleasedSessionEvents = (input: {
        readonly entry: LiveSessionEntry;
        readonly reason: ProviderSessionReleaseReason;
        readonly detail?: string;
      }) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          const payload: OrchestrationV2ProviderSession = {
            ...input.entry.runtime.providerSession,
            status: releaseStatusFor(input.reason),
            updatedAt: now,
            lastError:
              input.reason === "runtime_error"
                ? (input.detail ?? "Provider runtime failed.")
                : null,
          };
          yield* writeProviderSessionEvents({
            runtime: input.entry.runtime,
            threadIds: input.entry.attachedThreadIds,
            type: "provider-session.updated",
            payload,
          });
        });

      const writeReleasedRuntimeRequestEvents = (input: {
        readonly entry: LiveSessionEntry;
        readonly reason: ProviderSessionReleaseReason;
      }) =>
        Effect.gen(function* () {
          const providerSessionId = input.entry.runtime.providerSessionId;
          const now = yield* DateTime.now;
          const status = releasedRuntimeRequestStatusFor(input.reason);
          const reason =
            input.reason === "runtime_error"
              ? "Provider session failed before this runtime request was resolved."
              : "Provider session was closed before this runtime request was resolved.";

          const events: Array<OrchestrationV2DomainEvent> = [];
          for (const threadId of input.entry.attachedThreadIds) {
            const projection = yield* projectionStore.getThreadProjection(threadId);
            const releasedRequests = projection.runtimeRequests.filter(
              (request) =>
                request.status === "pending" &&
                request.responseCapability.type === "live" &&
                request.responseCapability.providerSessionId === providerSessionId,
            );

            for (const request of releasedRequests) {
              events.push({
                id: yield* idAllocator.allocate.event({
                  threadId,
                  providerSessionId,
                }),
                type: "runtime-request.updated",
                threadId,
                nodeId: request.nodeId,
                driver: input.entry.runtime.driver,
                occurredAt: now,
                payload: {
                  ...request,
                  status,
                  responseCapability: {
                    type: "not_resumable",
                    reason,
                  },
                  resolvedAt: now,
                },
              });

              const requestNode = projection.nodes.find((node) => node.id === request.nodeId);
              if (requestNode !== undefined) {
                events.push({
                  id: yield* idAllocator.allocate.event({
                    threadId,
                    providerSessionId,
                  }),
                  type: "node.updated",
                  threadId,
                  ...(requestNode.runId === null ? {} : { runId: requestNode.runId }),
                  nodeId: requestNode.id,
                  driver: input.entry.runtime.driver,
                  occurredAt: now,
                  payload: {
                    ...requestNode,
                    status: input.reason === "runtime_error" ? "failed" : "cancelled",
                    completedAt: now,
                  },
                });
              }

              const turnItem = projection.turnItems.find(
                (item) =>
                  (item.type === "approval_request" || item.type === "user_input_request") &&
                  item.requestId === request.id,
              );
              if (turnItem !== undefined) {
                events.push({
                  id: yield* idAllocator.allocate.event({
                    threadId,
                    providerSessionId,
                  }),
                  type: "turn-item.updated",
                  threadId,
                  ...(turnItem.runId === null ? {} : { runId: turnItem.runId }),
                  ...(turnItem.nodeId === null ? {} : { nodeId: turnItem.nodeId }),
                  driver: input.entry.runtime.driver,
                  occurredAt: now,
                  payload: {
                    ...turnItem,
                    status: input.reason === "runtime_error" ? "failed" : "cancelled",
                    completedAt: now,
                    updatedAt: now,
                  },
                });
              }
            }
          }

          if (events.length > 0) {
            yield* eventSink.write({ events });
          }
        });

      const releaseEntry = (input: {
        readonly providerSessionId: ProviderSessionId;
        readonly reason: ProviderSessionReleaseReason;
        readonly detail?: string;
        readonly cancelIdleFiber?: boolean;
        readonly onlyIfIdleGeneration?: number;
        readonly gracefulSubscribers?: boolean;
        readonly alreadyLocked?: boolean;
        // A caller that already observed a pending release must join that exact
        // cleanup. If it finished meanwhile, the old session is gone and a
        // same-id replacement must not be claimed in its place.
        readonly joinRelease?: {
          readonly done: Deferred.Deferred<void, ProviderSessionReleaseError>;
        };
        // Join pending cleanup for this session id but never claim a live
        // entry: the caller's target may already be replaced.
        readonly joinOnly?: boolean;
        // Only act on the session instance that owns this runtime: a stale
        // caller must not release a same-id replacement opened meanwhile.
        readonly expectedRuntime?: ProviderAdapterV2SessionRuntime;
        // A release record the caller already registered atomically with its
        // own state mutation (detach moves the last exclusive attachment into
        // `releasing` inside its Ref.modify): skip selection and run the
        // cleanup worker plus the bounded join for that exact record.
        readonly preclaimed?: PendingSessionRelease;
      }) =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const key = sessionKey(input.providerSessionId);
            const selected =
              input.preclaimed !== undefined
                ? Option.some({ release: input.preclaimed, start: true } as const)
                : yield* Ref.modify(
                    sessions,
                    (
                      current,
                    ): readonly [
                      Option.Option<
                        | { readonly release: PendingSessionRelease; readonly start: boolean }
                        | { readonly opening: OpeningSessionRecord }
                      >,
                      Map<string, LiveSessionEntry>,
                    ] => {
                      const pending = releasing.get(key);
                      if (input.joinRelease !== undefined) {
                        return [
                          pending !== undefined && pending.done === input.joinRelease.done
                            ? Option.some({ release: pending, start: false })
                            : Option.none(),
                          current,
                        ] as const;
                      }
                      if (pending !== undefined) {
                        return [
                          input.expectedRuntime === undefined ||
                          pending.entry.runtime === input.expectedRuntime
                            ? Option.some({ release: pending, start: false })
                            : Option.none(),
                          current,
                        ] as const;
                      }
                      if (input.joinOnly === true) {
                        return [Option.none(), current] as const;
                      }
                      const existing = current.get(key);
                      if (
                        existing === undefined ||
                        (input.expectedRuntime !== undefined &&
                          existing.runtime !== input.expectedRuntime)
                      ) {
                        // An in-flight startup has no entry to claim but can already
                        // own resources (a spawning process, a held credential
                        // reservation). A pinned-runtime caller targets a different
                        // instance and must not touch it; everyone else marks it so
                        // registration fences, then joins its unwind below.
                        const openingRecord =
                          input.expectedRuntime === undefined ? opening.get(key) : undefined;
                        if (openingRecord !== undefined) {
                          if (openingRecord.failed === undefined) {
                            openingRecord.closeRequested = true;
                          }
                          return [Option.some({ opening: openingRecord }), current] as const;
                        }
                        return [Option.none(), current] as const;
                      }
                      if (
                        input.onlyIfIdleGeneration !== undefined &&
                        (existing.busyCount > 0 ||
                          existing.idleGeneration !== input.onlyIfIdleGeneration)
                      ) {
                        return [Option.none(), current] as const;
                      }
                      const release = {
                        entry: existing,
                        threadIds: new Set([
                          ...existing.attachedThreadIds,
                          ...existing.mcpCredentialIdByThread.keys(),
                        ]),
                        mcpCredentialIdByThread: new Map(existing.mcpCredentialIdByThread),
                        done: Deferred.makeUnsafe<void, ProviderSessionReleaseError>(),
                      };
                      releasing.set(key, release);
                      const updated = new Map(current);
                      updated.delete(key);
                      return [Option.some({ release, start: true }), updated] as const;
                    },
                  );
            if (Option.isNone(selected)) return;
            if ("opening" in selected.value) {
              const openingRecord = selected.value.opening;
              // The open's own unwind performs the cleanup; this join is
              // bounded like any cleanup wait and the record stays (marked
              // closeRequested, or failed) until the unwind finishes, so a
              // timeout or interruption here cannot let a replacement open
              // race ahead of a dying startup.
              const settled = yield* restore(
                Deferred.await(openingRecord.settled).pipe(
                  Effect.timeoutOption(RELEASE_SCOPE_CLOSE_TIMEOUT_MS),
                ),
              );
              if (Option.isNone(settled)) {
                return yield* new ProviderSessionReleaseError({
                  providerSessionId: input.providerSessionId,
                  reason: input.reason,
                  cause:
                    "Provider session startup cleanup did not finish within 30 seconds. " +
                    "Replacement sessions are blocked until cleanup completes.",
                });
              }
              return;
            }
            const { release, start } = selected.value;
            if (start) {
              const releaseCredentials = Effect.gen(function* () {
                // Scope cleanup succeeded. Stop claiming these credentials before
                // checking peers, even if persisting the released status later fails.
                // Each credential re-reads `sessions`: a peer may record a claim
                // while an earlier revocation in this sweep is suspended, and a
                // snapshot taken once here would miss it.
                const credentials = [...release.mcpCredentialIdByThread];
                release.mcpCredentialIdByThread.clear();
                yield* Effect.forEach(
                  credentials,
                  ([threadId, mcpCredentialId]) =>
                    releaseUnclaimedMcpCredential(threadId, mcpCredentialId),
                  { discard: true },
                );
              });
              const closeScope = Effect.gen(function* () {
                const entry = release.entry;
                if (input.cancelIdleFiber !== false) {
                  yield* cancelIdleFiber(entry.idleFiber);
                }
                if (input.gracefulSubscribers === true) {
                  yield* endSubscribers(entry);
                } else if (input.reason === "server_shutdown") {
                  yield* closeSubscribers(entry);
                } else {
                  yield* failSubscribers(
                    entry,
                    input.detail ?? `Provider session released: ${input.reason}.`,
                  );
                }
                yield* Scope.close(entry.scope, Exit.void);
                // On a failed or interrupted close the release stays pending and
                // its provider process may still be live — the claims in
                // `release.mcpCredentialIdByThread` must remain recorded until a
                // cleanup actually completes, or a sweep could revoke a credential
                // that process still uses.
                yield* releaseCredentials;
              });
              // Drain in-flight opens, then release their locks before closing the scope.
              // The adapter-op drain is lock-free: an admitted
              // runtime.ensureThread/resumeThread registers in
              // inflightAdapterOps before invoking the adapter, so it either
              // settles before the scope closes or is refused by its ownership
              // recheck — a provider resource created mid-close must never
              // outlive the finalizer that would have closed it. The set is
              // closed at claim time (registration requires the live entry),
              // and an adapter call never joins this release — no drain
              // deadlock. The alreadyLocked caller holds the open/lifecycle
              // locks (skip reacquiring them) but its session is still
              // reachable through `get`, so the op drain still applies.
              const drainAdapterOps = Effect.gen(function* () {
                const ops = inflightAdapterOps.get(key);
                if (ops === undefined) return;
                let abandoned = 0;
                yield* Effect.forEach(
                  ops,
                  (op) =>
                    op.drainTimeout === undefined
                      ? Deferred.await(op.done)
                      : Deferred.await(op.done).pipe(
                          Effect.timeoutOption(op.drainTimeout),
                          Effect.tap((settled) =>
                            Option.isNone(settled)
                              ? Effect.sync(() => {
                                  abandoned += 1;
                                })
                              : Effect.void,
                          ),
                        ),
                  { discard: true, concurrency: "unbounded" },
                );
                // An op that outlives its drain bound is left to the scope
                // close — the finalizer aborts the work it was doing. This is
                // the long-lived turn shape (e.g. OpenCode summarize), not an
                // acquisition, so proceeding does not strand a late install.
                if (abandoned > 0) {
                  yield* Effect.logWarning(
                    "orchestration-v2.driver-session.adapter-op-drain-timeout",
                    {
                      providerSessionId: input.providerSessionId,
                      abandoned,
                    },
                  );
                }
                inflightAdapterOps.delete(key);
              });
              const waitForOpens =
                input.alreadyLocked === true
                  ? drainAdapterOps
                  : Array.from(release.threadIds)
                      .sort()
                      .reduceRight(
                        (effect, threadId) => threadLifecycle.withLock(threadId, effect),
                        sessionOpen.withLock(input.providerSessionId, drainAdapterOps),
                      );
              const completeRelease = (exit: Exit.Exit<void, ProviderSessionReleaseError>) =>
                releaseStatus.withLock(
                  input.providerSessionId,
                  Effect.gen(function* () {
                    const reportExit = yield* Effect.gen(function* () {
                      if (Exit.isFailure(exit)) {
                        yield* Effect.logWarning("orchestration-v2.driver-session.cleanup-failed", {
                          providerSessionId: input.providerSessionId,
                          reason: input.reason,
                          cause: exit.cause,
                        });
                      }
                      yield* writeReleasedSessionEvents({
                        entry: release.entry,
                        reason: Exit.isFailure(exit) ? "runtime_error" : input.reason,
                        ...(Exit.isFailure(exit)
                          ? { detail: "Provider session cleanup failed." }
                          : input.detail === undefined
                            ? {}
                            : { detail: input.detail }),
                      });
                      yield* writeReleasedRuntimeRequestEvents({
                        entry: release.entry,
                        reason: Exit.isFailure(exit) ? "runtime_error" : input.reason,
                      }).pipe(release.entry.requestEventPermit.withPermits(1));
                    }).pipe(
                      Effect.mapError(
                        (cause) =>
                          new ProviderSessionReleaseError({
                            providerSessionId: input.providerSessionId,
                            reason: input.reason,
                            cause,
                          }),
                      ),
                      Effect.exit,
                    );
                    const completed = Exit.isFailure(exit) ? exit : reportExit;
                    if (Exit.isSuccess(exit)) releasing.delete(key);
                    yield* Deferred.done(release.done, completed);
                  }),
                );
              yield* waitForOpens.pipe(
                Effect.andThen(closeScope),
                Effect.catchCause((cause) =>
                  Effect.fail(
                    new ProviderSessionReleaseError({
                      providerSessionId: input.providerSessionId,
                      reason: input.reason,
                      cause,
                    }),
                  ),
                ),
                Effect.onExit(completeRelease),
                Effect.forkDetach({ startImmediately: true }),
              );
            }
            const result = yield* restore(
              Deferred.await(release.done).pipe(
                Effect.timeoutOption(RELEASE_SCOPE_CLOSE_TIMEOUT_MS),
              ),
            );
            if (Option.isNone(result)) {
              const detail =
                "Provider session cleanup did not finish within 30 seconds. Replacement sessions are blocked until cleanup completes.";
              // Report through the same releaseStatus lock so the error lands
              // in order with an attach or completion write still holding it —
              // but report detached: that write may be suspended indefinitely,
              // and this caller's bounded wait must not depend on it.
              yield* releaseStatus
                .withLock(
                  input.providerSessionId,
                  Effect.gen(function* () {
                    if (yield* Deferred.isDone(release.done)) return;
                    yield* writeReleasedSessionEvents({
                      entry: release.entry,
                      reason: "runtime_error",
                      detail,
                    });
                    yield* writeReleasedRuntimeRequestEvents({
                      entry: release.entry,
                      reason: "runtime_error",
                    }).pipe(release.entry.requestEventPermit.withPermits(1));
                  }),
                )
                .pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning(
                      "orchestration-v2.driver-session.cleanup-timeout-report-failed",
                      {
                        providerSessionId: input.providerSessionId,
                        cause,
                      },
                    ),
                  ),
                  Effect.forkDetach({ startImmediately: true }),
                );
              if (yield* Deferred.isDone(release.done)) return yield* Deferred.await(release.done);
              return yield* new ProviderSessionReleaseError({
                providerSessionId: input.providerSessionId,
                reason: input.reason,
              });
            }
          }),
        ).pipe(
          Effect.catchCause((cause) => {
            const error = Cause.findErrorOption(cause);
            if (Option.isSome(error) && isProviderSessionReleaseError(error.value)) {
              return Effect.fail(error.value);
            }
            return Effect.fail(
              new ProviderSessionReleaseError({
                providerSessionId: input.providerSessionId,
                reason: input.reason,
                cause,
              }),
            );
          }),
        );

      // Annotated to break the releaseIfStillIdle <-> scheduleIdleReleaseInternal
      // inference cycle introduced by the pin re-arm below.
      const releaseIfStillIdle = (input: {
        readonly providerSessionId: ProviderSessionId;
        readonly generation: number;
        readonly expectedRuntime?: ProviderAdapterV2SessionRuntime;
      }): Effect.Effect<void> =>
        Effect.gen(function* () {
          const current = yield* Ref.get(sessions);
          const key = sessionKey(input.providerSessionId);
          const entry = current.get(key);
          if (
            entry === undefined ||
            entry.busyCount > 0 ||
            entry.idleGeneration !== input.generation ||
            // An orphaned timer (displaced by a concurrent scheduler before
            // being recorded in the entry) must never act on a same-id
            // replacement's entry.
            (input.expectedRuntime !== undefined && entry.runtime !== input.expectedRuntime)
          ) {
            return;
          }
          // Capture runtime identity before yielding: a replacement session
          // can reuse the same providerSessionId while this fiber is parked.
          const probedRuntime = entry.runtime;
          const hasPendingWork =
            probedRuntime.hasPendingBackgroundWork === undefined
              ? false
              : yield* probedRuntime.hasPendingBackgroundWork.pipe(
                  Effect.catchCause(() => Effect.succeed(false)),
                );
          if (hasPendingWork) {
            const now = yield* Clock.currentTimeMillis;
            const pinnedSinceMs = entry.pinnedSinceMs ?? now;
            if (now - pinnedSinceMs < maxIdlePinMs) {
              const shouldContinuePin = yield* Ref.modify(sessions, (latest) => {
                const latestEntry = latest.get(key);
                if (
                  latestEntry === undefined ||
                  latestEntry.busyCount > 0 ||
                  latestEntry.idleGeneration !== input.generation ||
                  latestEntry.runtime !== probedRuntime
                ) {
                  return [false, latest] as const;
                }
                const updated = new Map(latest);
                updated.set(key, { ...latestEntry, pinnedSinceMs });
                return [true, updated] as const;
              });
              if (!shouldContinuePin) {
                // Generation or runtime advanced while we probed pending work;
                // the current owner of the entry owns idle release.
                return;
              }
              yield* Effect.logInfo("orchestration-v2.driver-session.idle-release-deferred", {
                providerSessionId: input.providerSessionId,
                pinnedForMs: now - pinnedSinceMs,
              });
              // Re-check on this fiber after another idle window. Do not call
              // scheduleIdleReleaseInternal: that cancels entry.idleFiber, which
              // is this fiber, and can self-deadlock on Fiber.interrupt.
              yield* Effect.sleep(Duration.millis(idleTimeoutMs));
              return yield* releaseIfStillIdle(input);
            }
            yield* Effect.logWarning("orchestration-v2.driver-session.idle-release-pin-expired", {
              providerSessionId: input.providerSessionId,
              pinnedForMs: now - pinnedSinceMs,
            });
          }
          // hasPendingBackgroundWork yields to the adapter, so the idle
          // decision above can go stale; the generation guard revalidates
          // busyCount and idleGeneration inside releaseEntry's atomic
          // entry removal.
          yield* releaseEntry({
            providerSessionId: input.providerSessionId,
            reason: "idle_timeout",
            cancelIdleFiber: false,
            onlyIfIdleGeneration: input.generation,
            expectedRuntime: probedRuntime,
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("orchestration-v2.driver-session.idle-release-failed", {
                providerSessionId: input.providerSessionId,
                cause,
              }),
            ),
          );
        });

      const withActivityError = <A, E, R>(
        providerSessionId: ProviderSessionId,
        effect: Effect.Effect<A, E, R>,
      ): Effect.Effect<A, ProviderSessionActivityError, R> =>
        effect.pipe(
          Effect.catchCause((cause) =>
            Effect.fail(
              new ProviderSessionActivityError({
                providerSessionId,
                cause,
              }),
            ),
          ),
        );

      const scheduleIdleReleaseInternal = (
        providerSessionId: ProviderSessionId,
        expectedRuntime?: ProviderAdapterV2SessionRuntime,
      ) =>
        // Uninterruptible: cancelling the tracked timer suspends until that
        // fiber dies, and an interruption landing before the replacement is
        // installed would leave the entry pointing at a dead fiber with no
        // idle cleanup left. The atomic install check still decides whether
        // the new timer is kept or cancelled.
        Effect.uninterruptible(
          Effect.gen(function* () {
            const key = sessionKey(providerSessionId);
            const current = yield* Ref.get(sessions);
            const entry = current.get(key);
            if (
              entry === undefined ||
              entry.busyCount > 0 ||
              (expectedRuntime !== undefined && entry.runtime !== expectedRuntime)
            ) {
              return;
            }

            yield* cancelIdleFiber(entry.idleFiber);
            const generation = entry.idleGeneration + 1;
            const idleFiber = yield* Effect.sleep(Duration.millis(idleTimeoutMs)).pipe(
              Effect.andThen(
                releaseIfStillIdle({
                  providerSessionId,
                  generation,
                  ...(expectedRuntime === undefined ? {} : { expectedRuntime }),
                }),
              ),
              Effect.forkIn(layerScope),
            );
            const lastActivityAtMs = yield* Clock.currentTimeMillis;
            const installed = yield* Ref.modify(sessions, (latest) => {
              const latestEntry = latest.get(key);
              if (
                latestEntry === undefined ||
                latestEntry.busyCount > 0 ||
                // A concurrent scheduler installed its timer since our read.
                // Yield to it: keeping ours would orphan the tracked fiber.
                latestEntry.idleFiber !== entry.idleFiber ||
                (expectedRuntime !== undefined && latestEntry.runtime !== expectedRuntime)
              ) {
                return [false, latest] as const;
              }
              const updated = new Map(latest);
              updated.set(key, {
                ...latestEntry,
                idleGeneration: generation,
                idleFiber,
                lastActivityAtMs,
              });
              return [true, updated] as const;
            });
            if (!installed) {
              // Our timer lost registration; cancel it so it can never fire
              // against a same-id replacement or double-release this entry.
              yield* cancelIdleFiber(idleFiber);
            }
          }),
        );

      const scheduleIdleRelease = (
        providerSessionId: ProviderSessionId,
        expectedRuntime?: ProviderAdapterV2SessionRuntime,
      ) =>
        withActivityError(
          providerSessionId,
          scheduleIdleReleaseInternal(providerSessionId, expectedRuntime),
        );

      const touchActivity = (
        providerSessionId: ProviderSessionId,
        expectedRuntime?: ProviderAdapterV2SessionRuntime,
      ) =>
        withActivityError(
          providerSessionId,
          Effect.gen(function* () {
            const lastActivityAtMs = yield* Clock.currentTimeMillis;
            const owned = yield* Ref.modify(sessions, (current) => {
              const entry = current.get(sessionKey(providerSessionId));
              if (
                entry === undefined ||
                (expectedRuntime !== undefined && entry.runtime !== expectedRuntime)
              ) {
                return [false, current] as const;
              }
              const updated = new Map(current);
              updated.set(sessionKey(providerSessionId), {
                ...entry,
                lastActivityAtMs,
              });
              return [true, updated] as const;
            });
            if (owned) {
              yield* scheduleIdleReleaseInternal(providerSessionId, expectedRuntime);
            }
          }),
        );

      const attachThread = (input: {
        readonly providerSessionId: ProviderSessionId;
        readonly threadId: ThreadId;
        readonly expectedRuntime: ProviderAdapterV2SessionRuntime;
      }) =>
        withActivityError(
          input.providerSessionId,
          Ref.modify(
            sessions,
            (
              current,
            ): readonly [
              (
                | { readonly outcome: "closing" | "released" }
                | {
                    readonly outcome: "attached" | "alreadyAttached";
                    readonly entry: LiveSessionEntry;
                  }
              ),
              Map<string, LiveSessionEntry>,
            ] => {
              const key = sessionKey(input.providerSessionId);
              const entry = current.get(key);
              if (entry === undefined || entry.runtime !== input.expectedRuntime) {
                // Registration into `releasing` and removal from `sessions`
                // happen in one Ref.modify, so whichever lands first wins: an
                // attach that loses the race sees a closing or released session
                // instead of silently skipping the attachment. A mismatched
                // runtime is a stale handle on a replaced same-id session.
                return [
                  { outcome: releasing.has(key) ? ("closing" as const) : ("released" as const) },
                  current,
                ];
              }
              if (entry.attachedThreadIds.has(input.threadId)) {
                return [{ outcome: "alreadyAttached" as const, entry }, current];
              }
              // The pending-release/startup gates in attachThreadOrReject
              // ran before this caller queued on threadAttach — a release
              // claiming the thread or a dying startup that owns it may have
              // landed meanwhile, so recheck inside the atomic attach
              // decision.
              if (
                findPendingRelease(input.providerSessionId, input.threadId, entry) !== undefined ||
                findBlockingStartup(input.providerSessionId, input.threadId) !== undefined
              ) {
                return [{ outcome: "closing" as const }, current];
              }
              const updatedEntry = {
                ...entry,
                attachedThreadIds: new Set([...entry.attachedThreadIds, input.threadId]),
              };
              const updated = new Map(current);
              updated.set(key, updatedEntry);
              return [{ outcome: "attached" as const, entry: updatedEntry }, updated];
            },
          ),
        );

      const removeThreadAttachment = (input: {
        readonly providerSessionId: ProviderSessionId;
        readonly threadId: ThreadId;
        readonly expectedRuntime?: ProviderAdapterV2SessionRuntime;
      }) =>
        Ref.update(sessions, (current) => {
          const key = sessionKey(input.providerSessionId);
          const entry = current.get(key);
          if (
            entry === undefined ||
            (input.expectedRuntime !== undefined && entry.runtime !== input.expectedRuntime) ||
            !entry.attachedThreadIds.has(input.threadId)
          ) {
            return current;
          }
          const attachedThreadIds = new Set(entry.attachedThreadIds);
          attachedThreadIds.delete(input.threadId);
          const loadedProviderThreadKeyByThread = new Map(entry.loadedProviderThreadKeyByThread);
          loadedProviderThreadKeyByThread.delete(input.threadId);
          const updated = new Map(current);
          updated.set(key, {
            ...entry,
            attachedThreadIds,
            loadedProviderThreadKeyByThread,
          });
          return updated;
        });

      const isProviderThreadLoaded = (input: {
        readonly providerSessionId: ProviderSessionId;
        readonly threadId: ThreadId;
        readonly providerThreadKey: string;
        readonly expectedRuntime: ProviderAdapterV2SessionRuntime;
      }) =>
        Ref.get(sessions).pipe(
          Effect.map((current) => {
            const entry = current.get(sessionKey(input.providerSessionId));
            return (
              entry !== undefined &&
              entry.runtime === input.expectedRuntime &&
              entry.loadedProviderThreadKeyByThread.get(input.threadId) === input.providerThreadKey
            );
          }),
        );

      const markProviderThreadLoaded = (input: {
        readonly providerSessionId: ProviderSessionId;
        readonly threadId: ThreadId;
        readonly providerThreadKey: string;
        readonly expectedRuntime: ProviderAdapterV2SessionRuntime;
      }) =>
        Ref.update(sessions, (current) => {
          const key = sessionKey(input.providerSessionId);
          const entry = current.get(key);
          if (entry === undefined || entry.runtime !== input.expectedRuntime) {
            return current;
          }
          const loadedProviderThreadKeyByThread = new Map(entry.loadedProviderThreadKeyByThread);
          loadedProviderThreadKeyByThread.set(input.threadId, input.providerThreadKey);
          const updated = new Map(current);
          updated.set(key, { ...entry, loadedProviderThreadKeyByThread });
          return updated;
        });

      const attachLockSection = (input: {
        readonly providerSessionId: ProviderSessionId;
        readonly threadId: ThreadId;
        readonly providerInstanceId: ProviderInstanceId;
        readonly expectedRuntime: ProviderAdapterV2SessionRuntime;
      }): Effect.Effect<
        "closing" | "released" | "attached" | "alreadyAttached",
        ProviderSessionActivityError
      > =>
        Effect.suspend(() => {
          // Set synchronously when prepare reserves a credential, so a prepare
          // that never returns (failed or interrupted mid-resolve/issue) can
          // still have its in-flight reservation unwound.
          let pendingMcpCredentialId: string | undefined;
          // Whether the post-prepare step introduced the entry's credential
          // claim; a claim recorded before this attach (a plain detach
          // retains it for the still-live process) is not ours to remove.
          let recordOwned = false;
          // A retained credential this attach's record overwrote. Once it is
          // out of the entry it has no remaining cleanup path, so the unwind
          // must cover it if the normal sweep below is interrupted first.
          let supersededMcpCredentialId: string | undefined;
          let reservationDropped = false;
          const dropReservation = () => {
            if (!reservationDropped && pendingMcpCredentialId !== undefined) {
              reservationDropped = true;
              dropMcpCredentialReservation(input.threadId, pendingMcpCredentialId);
            }
          };
          const expectedRuntime = input.expectedRuntime;
          // Entry identity rides on the runtime reference: bookkeeping updates
          // replace the entry record but never the runtime, while a reopened
          // same-id session always carries a new one.
          const entryStillOwned = (current: ReadonlyMap<string, LiveSessionEntry>) => {
            const key = sessionKey(input.providerSessionId);
            const entry = current.get(key);
            return entry !== undefined && entry.runtime === expectedRuntime
              ? entry
              : ((releasing.has(key) ? "closing" : "released") as "closing" | "released");
          };
          // The guard in rejectPendingThreadAttachment ran before this
          // caller queued on the attach lock and suspended in credential
          // preparation — a dying startup that still owns this thread's
          // resources may have been marked meanwhile, so every ownership
          // recheck below must see it too.
          const attachOwnership = (current: ReadonlyMap<string, LiveSessionEntry>) => {
            const owned = entryStillOwned(current);
            return owned !== "closing" &&
              owned !== "released" &&
              findBlockingStartup(input.providerSessionId, input.threadId) !== undefined
              ? ("closing" as const)
              : owned;
          };
          const abandonPrepared = (
            outcome: "closing" | "released",
          ): Effect.Effect<"closing" | "released", ProviderSessionActivityError> =>
            Effect.gen(function* () {
              // "closing"/"released" return normally, so the onExit unwind
              // below never runs for them — the provisional attachment and
              // any recorded credential claim must be removed here or a live
              // entry keeps a thread whose attach was rejected.
              yield* removeThreadAttachment({ ...input, expectedRuntime });
              yield* releasePrepared();
              return outcome;
            });
          // Unwind a failed attach's credential bookkeeping while the entry may
          // still be owned: drop our reservation and the claim this attempt
          // recorded, then revoke only when no other holder claims the
          // credential.
          const releasePrepared = () =>
            Effect.suspend(() => {
              // When prepare never reserved — the attach was interrupted
              // while queued on mcpPrepareLock — the thread's configured
              // credential may still need a claim recheck once the
              // provisional attachment is gone.
              const mcpCredentialId =
                pendingMcpCredentialId ??
                McpProviderSession.readMcpProviderSession(input.threadId)?.providerSessionId;
              dropReservation();
              const removeRecord =
                recordOwned && mcpCredentialId !== undefined
                  ? Ref.update(sessions, (current) => {
                      const key = sessionKey(input.providerSessionId);
                      const entry = current.get(key);
                      if (
                        entry === undefined ||
                        entry.runtime !== expectedRuntime ||
                        entry.mcpCredentialIdByThread.get(input.threadId) !== mcpCredentialId
                      ) {
                        return current;
                      }
                      const mcpCredentialIdByThread = new Map(entry.mcpCredentialIdByThread);
                      mcpCredentialIdByThread.delete(input.threadId);
                      const updated = new Map(current);
                      updated.set(key, { ...entry, mcpCredentialIdByThread });
                      return updated;
                    })
                  : Effect.void;
              return removeRecord.pipe(
                Effect.andThen(
                  mcpCredentialId === undefined
                    ? Effect.void
                    : releaseUnclaimedMcpCredential(input.threadId, mcpCredentialId),
                ),
                Effect.andThen(
                  supersededMcpCredentialId === undefined
                    ? Effect.void
                    : releaseUnclaimedMcpCredential(input.threadId, supersededMcpCredentialId),
                ),
              );
            });
          return Effect.gen(function* () {
            const attach = yield* attachThread(input);
            if (attach.outcome === "closing" || attach.outcome === "released") {
              return attach.outcome;
            }
            const attached = attach.outcome;
            if (attached === "attached") {
              const prepared = yield* prepareMcpSession(
                input.threadId,
                input.providerInstanceId,
                (mcpCredentialId) => {
                  pendingMcpCredentialId = mcpCredentialId;
                },
              );
              // Re-check ownership after prepare suspends: a release may have
              // claimed the session in between. Recording the credential and
              // deciding happen in the same Ref.modify.
              const postPrepare = yield* Ref.modify(
                sessions,
                (
                  current,
                ): readonly [
                  (
                    | "closing"
                    | "released"
                    | {
                        readonly entry: LiveSessionEntry;
                        readonly priorMcpCredentialId: string | undefined;
                      }
                  ),
                  Map<string, LiveSessionEntry>,
                ] => {
                  const key = sessionKey(input.providerSessionId);
                  const owned = attachOwnership(current);
                  if (owned === "closing" || owned === "released") {
                    return [owned, current];
                  }
                  const entry = owned;
                  if (prepared.mcpCredentialId === undefined) {
                    return [{ entry, priorMcpCredentialId: undefined } as const, current];
                  }
                  const priorMcpCredentialId = entry.mcpCredentialIdByThread.get(input.threadId);
                  recordOwned = priorMcpCredentialId !== prepared.mcpCredentialId;
                  supersededMcpCredentialId =
                    priorMcpCredentialId !== undefined &&
                    priorMcpCredentialId !== prepared.mcpCredentialId
                      ? priorMcpCredentialId
                      : undefined;
                  const mcpCredentialIdByThread = new Map(entry.mcpCredentialIdByThread);
                  mcpCredentialIdByThread.set(input.threadId, prepared.mcpCredentialId);
                  const updated = new Map(current);
                  updated.set(key, { ...entry, mcpCredentialIdByThread });
                  return [{ entry, priorMcpCredentialId } as const, updated];
                },
              );
              if (postPrepare === "closing" || postPrepare === "released") {
                return yield* abandonPrepared(postPrepare);
              }
              const superseded = postPrepare.priorMcpCredentialId;
              if (
                superseded !== undefined &&
                superseded !== prepared.mcpCredentialId &&
                superseded !== pendingMcpCredentialId
              ) {
                // A retained record from an earlier attach was just
                // overwritten: revoke the superseded credential once nothing
                // else claims it, or it lives on unclaimed.
                yield* releaseUnclaimedMcpCredential(input.threadId, superseded);
              }
              // The release path reports terminal status under releaseStatus,
              // so checking ownership and writing the attach event inside the
              // same lock orders this event strictly before any stopped/error
              // write: a release that claimed the session first is observed
              // here and the late write is skipped instead of resurrecting the
              // persisted live status.
              const written = yield* releaseStatus
                .withLock(
                  input.providerSessionId,
                  Ref.get(sessions).pipe(
                    Effect.flatMap(
                      (
                        current,
                      ): Effect.Effect<
                        LiveSessionEntry | "closing" | "released",
                        ProviderSessionActivityError
                      > => {
                        const owned = attachOwnership(current);
                        if (owned === "closing" || owned === "released") {
                          return Effect.succeed(owned);
                        }
                        return withActivityError(
                          input.providerSessionId,
                          writeProviderSessionEvents({
                            runtime: owned.runtime,
                            threadIds: [input.threadId],
                            type: "provider-session.attached",
                            payload: owned.runtime.providerSession,
                          }),
                        ).pipe(Effect.as(owned));
                      },
                    ),
                  ),
                )
                .pipe(
                  // A failed write skips the post-write recheck, so run it on
                  // the error path too: a release that landed mid-write must
                  // still reject the caller instead of returning a closed
                  // adapter.
                  Effect.catch((writeError) =>
                    Ref.get(sessions).pipe(
                      Effect.flatMap((current) => {
                        const owned = attachOwnership(current);
                        return owned === "closing" || owned === "released"
                          ? Effect.succeed(owned)
                          : Effect.fail(writeError);
                      }),
                    ),
                  ),
                );
              if (written === "closing" || written === "released") {
                return yield* abandonPrepared(written);
              }
              // Removal from `sessions` does not take the releaseStatus lock,
              // so a release may still have claimed the session between the
              // in-lock check and now. Re-check before reporting success.
              const postWrite = yield* Ref.modify(sessions, (current) => [
                attachOwnership(current),
                current,
              ]);
              if (postWrite === "closing" || postWrite === "released") {
                return yield* abandonPrepared(postWrite);
              }
            }
            return attached;
          }).pipe(
            // Unwind on any non-success exit: typed failures, defects, and
            // interruption all must drop the provisional thread attachment —
            // while it stays in the entry it claims the credential, which
            // keeps a token alive that no live holder recorded — and then
            // release the in-flight credential bookkeeping.
            Effect.onExit((exit) =>
              Exit.isSuccess(exit)
                ? Effect.void
                : removeThreadAttachment({ ...input, expectedRuntime }).pipe(
                    Effect.andThen(releasePrepared()),
                  ),
            ),
            // The entry's own record (written above while the thread is
            // attached) guards the credential from here on; the reservation
            // is only needed until then. Ensuring covers defects/interrupts.
            Effect.ensuring(Effect.sync(dropReservation)),
          );
        });

      const ensureThreadAttached = (input: {
        readonly providerSessionId: ProviderSessionId;
        readonly threadId: ThreadId;
        readonly providerInstanceId: ProviderInstanceId;
        readonly expectedRuntime: ProviderAdapterV2SessionRuntime;
      }) =>
        threadAttach.withLock(
          threadAttachKey(input.providerSessionId, input.expectedRuntime, input.threadId),
          attachLockSection(input),
        );

      const markBusy = (
        providerSessionId: ProviderSessionId,
        expectedRuntime?: ProviderAdapterV2SessionRuntime,
        acquired?: Ref.Ref<boolean>,
      ) =>
        withActivityError(
          providerSessionId,
          Effect.gen(function* () {
            const key = sessionKey(providerSessionId);
            const now = yield* Clock.currentTimeMillis;
            const [idleFiber] = yield* Effect.uninterruptible(
              Effect.gen(function* () {
                const outcome = yield* Ref.modify(
                  sessions,
                  (
                    current,
                  ): readonly [
                    readonly [Fiber.Fiber<void, never> | null, boolean],
                    Map<string, LiveSessionEntry>,
                  ] => {
                    const entry = current.get(key);
                    if (
                      entry === undefined ||
                      (expectedRuntime !== undefined && entry.runtime !== expectedRuntime)
                    ) {
                      return [[null, false], current];
                    }
                    const updated = new Map(current);
                    updated.set(key, {
                      ...entry,
                      busyCount: entry.busyCount + 1,
                      idleFiber: null,
                      lastActivityAtMs: now,
                      pinnedSinceMs: null,
                    });
                    return [[entry.idleFiber, true], updated];
                  },
                );
                // The acquisition flag is set in the same uninterruptible
                // region as the increment so an onExit unwind can tell
                // exactly whether this call took a mark — decrementing
                // without it would steal another holder's busy count.
                if (acquired !== undefined && outcome[1]) {
                  yield* Ref.set(acquired, true);
                }
                return outcome;
              }),
            );
            yield* cancelIdleFiber(idleFiber);
          }),
        );

      const markIdle = (
        providerSessionId: ProviderSessionId,
        expectedRuntime?: ProviderAdapterV2SessionRuntime,
      ) =>
        withActivityError(
          providerSessionId,
          Effect.gen(function* () {
            const key = sessionKey(providerSessionId);
            const now = yield* Clock.currentTimeMillis;
            const owned = yield* Ref.modify(sessions, (current) => {
              const entry = current.get(key);
              if (
                entry === undefined ||
                (expectedRuntime !== undefined && entry.runtime !== expectedRuntime)
              ) {
                return [false, current] as const;
              }
              const updated = new Map(current);
              updated.set(key, {
                ...entry,
                busyCount: Math.max(0, entry.busyCount - 1),
                lastActivityAtMs: now,
              });
              return [true, updated] as const;
            });
            if (owned) {
              yield* scheduleIdleReleaseInternal(providerSessionId, expectedRuntime);
            }
          }),
        );

      const observeActivity = <A>(
        providerSessionId: ProviderSessionId,
        activity: Effect.Effect<A, ProviderSessionActivityError>,
      ) =>
        activity.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("orchestration-v2.driver-session.activity-failed", {
              providerSessionId,
              cause,
            }),
          ),
        );

      // Attachment rejection must propagate to the caller, so it cannot live
      // inside observeActivity (which only logs bookkeeping failures). The
      // pending-release check runs twice: the gate rejects attachments whose
      // thread a pending release recorded, and attachThread atomically rejects
      // a session that releaseEntry claimed between the gate and the attach.
      const attachThreadOrReject = <A, E, R>(
        input: {
          readonly providerSessionId: ProviderSessionId;
          readonly threadId: ThreadId;
          readonly providerInstanceId: ProviderInstanceId;
          readonly driver: ProviderDriverKind;
          readonly expectedRuntime: ProviderAdapterV2SessionRuntime;
        },
        // The follow-up runs inside the same [session, thread] lock hold as
        // the attach bookkeeping: releasing in between let a terminal detach
        // strip the attachment and revoke its credential claim before the
        // adapter call was admitted, so the op could create provider resources
        // the teardown already passed.
        runAttached: (attached: "attached" | "alreadyAttached") => Effect.Effect<A, E, R>,
      ): Effect.Effect<A, E | ProviderAdapterProtocolError, R> =>
        Effect.andThen(
          rejectPendingThreadAttachment({
            providerSessionId: input.providerSessionId,
            threadId: input.threadId,
            driver: input.driver,
          }),
          Effect.gen(function* () {
            const outcome = yield* threadAttach.withLock(
              threadAttachKey(input.providerSessionId, input.expectedRuntime, input.threadId),
              attachLockSection(input).pipe(
                Effect.catch((error) =>
                  Ref.get(sessions).pipe(
                    Effect.flatMap(
                      (
                        current,
                      ): Effect.Effect<"closing" | "released", ProviderAdapterProtocolError> => {
                        const key = sessionKey(input.providerSessionId);
                        const entry = current.get(key);
                        if (entry === undefined || entry.runtime !== input.expectedRuntime) {
                          // The attach failed because the session was claimed
                          // mid-flight — report the lifecycle outcome.
                          return Effect.succeed(
                            releasing.has(key) ? ("closing" as const) : ("released" as const),
                          );
                        }
                        // The session is still owned but the attach bookkeeping
                        // failed: proceeding would invoke the adapter for an
                        // untracked attachment missing its prepared credential.
                        return Effect.logWarning("orchestration-v2.driver-session.attach-failed", {
                          providerSessionId: input.providerSessionId,
                          error,
                        }).pipe(
                          Effect.andThen(
                            Effect.fail(
                              new ProviderAdapterProtocolError({
                                driver: input.driver,
                                detail: "The provider session could not attach the thread.",
                              }),
                            ),
                          ),
                        );
                      },
                    ),
                  ),
                ),
                Effect.flatMap(
                  (
                    attached,
                  ): Effect.Effect<
                    { readonly attached: "attached" | "alreadyAttached"; readonly value: A },
                    E | ProviderAdapterProtocolError,
                    R
                  > =>
                    attached === "closing" || attached === "released"
                      ? Effect.fail(
                          new ProviderAdapterProtocolError({
                            driver: input.driver,
                            detail:
                              attached === "closing"
                                ? "A previous provider session has not finished cleanup."
                                : "The provider session is no longer running.",
                          }),
                        )
                      : Effect.map(runAttached(attached), (value) => ({ attached, value })),
                ),
              ),
            );
            return outcome.value;
          }),
        );

      // Entry points that don't attach a thread still must not reach a stale
      // adapter: a same-id reopen hands callers a new runtime, and a released
      // session's runtime is already closing.
      const requireLiveRuntime = (input: {
        readonly providerSessionId: ProviderSessionId;
        readonly expectedRuntime: ProviderAdapterV2SessionRuntime;
        readonly driver: ProviderDriverKind;
      }) =>
        Effect.gen(function* () {
          const key = sessionKey(input.providerSessionId);
          const entry = (yield* Ref.get(sessions)).get(key);
          if (entry !== undefined && entry.runtime === input.expectedRuntime) {
            return;
          }
          return yield* new ProviderAdapterProtocolError({
            driver: input.driver,
            detail: releasing.has(key)
              ? "A previous provider session has not finished cleanup."
              : "The provider session is no longer running.",
          });
        });

      /**
       * Runs an adapter operation that can create native resources under an
       * admission record the release path drains. Registration and the
       * ownership check are one Ref.modify: the claim deletes the sessions
       * entry and writes `releasing` atomically, so an operation admitted
       * before the claim is always in the drained set and an operation after
       * the claim is refused before the adapter runs.
       */
      const runResourceCreatingAdapterOp = <A, E>(input: {
        readonly providerSessionId: ProviderSessionId;
        readonly expectedRuntime: ProviderAdapterV2SessionRuntime;
        readonly driver: ProviderDriverKind;
        readonly operation: Effect.Effect<A, E>;
        readonly drainTimeout: Duration.Duration | undefined;
        readonly requiredThreadId?: ThreadId;
        // Request/response mutations create no resource that ownership must
        // track: an unanswered one must yield to caller interruption, not wait
        // for a settle that may never arrive.
        readonly interruptibleOperation?: boolean;
      }): Effect.Effect<A, E | ProviderAdapterProtocolError> =>
        Effect.uninterruptibleMask((restore) =>
          Effect.gen(function* () {
            const key = sessionKey(input.providerSessionId);
            const record = {
              done: Deferred.makeUnsafe<void, never>(),
              drainTimeout: input.drainTimeout,
            };
            const admission = yield* Ref.modify(sessions, (current) => {
              const entry = current.get(key);
              if (entry === undefined || entry.runtime !== input.expectedRuntime) {
                return ["missing" as const, current] as const;
              }
              // A terminal detach that won the [session, thread] lock between
              // the attach's bookkeeping and this admission removed the thread
              // while the shared runtime stays live — refuse rather than
              // invoke the adapter for a detached thread whose credential
              // claim was already revoked.
              if (
                input.requiredThreadId !== undefined &&
                !entry.attachedThreadIds.has(input.requiredThreadId)
              ) {
                return ["detached" as const, current] as const;
              }
              const ops = inflightAdapterOps.get(key) ?? new Set();
              ops.add(record);
              inflightAdapterOps.set(key, ops);
              return ["admitted" as const, current] as const;
            });
            if (admission !== "admitted") {
              return yield* new ProviderAdapterProtocolError({
                driver: input.driver,
                detail:
                  admission === "detached"
                    ? "The thread is no longer attached to the provider session."
                    : releasing.has(key)
                      ? "A previous provider session has not finished cleanup."
                      : "The provider session is no longer running.",
              });
            }
            // Acquisitions run uninterruptibly inside the mask: adapters
            // acquire native resources through Effect.tryPromise (Cursor's
            // Agent.create/resume), whose interruption detaches the promise
            // rather than cancelling it. Signalling `done` at interrupt time
            // would let the drain complete while a late result still lands
            // with no cleanup owner — an interruptible caller instead waits
            // for the acquisition to settle into tracked ownership.
            // interruptibleOperation opts out for calls whose only outcome is
            // settled-or-ambiguous (history injection): interruption reaches
            // the request, and the uninterruptible ensuring still settles the
            // admission record so neither the drain nor the caller wedges.
            return yield* (
              input.interruptibleOperation === true ? restore(input.operation) : input.operation
            ).pipe(
              Effect.ensuring(
                Effect.sync(() => {
                  const ops = inflightAdapterOps.get(key);
                  if (ops !== undefined) {
                    ops.delete(record);
                    if (ops.size === 0) inflightAdapterOps.delete(key);
                  }
                }).pipe(Effect.andThen(Deferred.done(record.done, Exit.void))),
              ),
            );
          }),
        );

      const makeEventSubscription = (
        subscribers: Ref.Ref<
          ReadonlyMap<number, Queue.Queue<ProviderSessionEventSignal, Cause.Done>>
        >,
      ): Effect.Effect<ProviderAdapterV2EventSubscription> =>
        Effect.gen(function* () {
          const queue = yield* Queue.unbounded<ProviderSessionEventSignal, Cause.Done>();
          const subscriberId = yield* Ref.getAndUpdate(nextSubscriberId, (value) => value + 1);
          yield* Ref.update(subscribers, (current) => {
            const updated = new Map(current);
            updated.set(subscriberId, queue);
            return updated;
          });
          const close = Ref.modify(subscribers, (current) => {
            if (!current.has(subscriberId)) {
              return [false, current] as const;
            }
            const updated = new Map(current);
            updated.delete(subscriberId);
            return [true, updated] as const;
          }).pipe(
            Effect.flatMap((removed) =>
              removed
                ? Queue.clear(queue).pipe(Effect.andThen(Queue.end(queue)), Effect.asVoid)
                : Effect.void,
            ),
          );
          const events = Stream.fromQueue(queue).pipe(
            Stream.mapEffect((signal) =>
              signal.type === "event"
                ? Effect.succeed(signal.event)
                : Effect.failCause(signal.cause),
            ),
            Stream.ensuring(close),
          );
          return { events, close } satisfies ProviderAdapterV2EventSubscription;
        });

      const decorateRuntime = (
        runtime: ProviderAdapterV2SessionRuntime,
        eventSubscribers: Ref.Ref<
          ReadonlyMap<number, Queue.Queue<ProviderSessionEventSignal, Cause.Done>>
        >,
      ): ProviderAdapterV2SessionRuntime => {
        const providerSessionId = runtime.providerSessionId;
        const subscribeEvents = makeEventSubscription(eventSubscribers);
        return {
          ...runtime,
          subscribeEvents,
          events: Stream.unwrap(
            subscribeEvents.pipe(Effect.map((subscription) => subscription.events)),
          ),
          ensureThread: (input) =>
            attachThreadOrReject(
              {
                providerSessionId,
                threadId: input.threadId,
                providerInstanceId: runtime.instanceId,
                driver: runtime.driver,
                expectedRuntime: runtime,
              },
              // The adapter call holds the attach lock so a detach cannot
              // strip this thread's bookkeeping mid-call, and it runs under
              // an admission record a release drains before closing the
              // session scope — a resource the adapter creates (e.g.
              // Cursor's late runner.open result) is never installed after
              // the finalizer that would have closed it already ran.
              () =>
                runResourceCreatingAdapterOp({
                  providerSessionId,
                  expectedRuntime: runtime,
                  driver: runtime.driver,
                  operation: runtime.ensureThread(input),
                  drainTimeout: undefined,
                  requiredThreadId: input.threadId,
                }).pipe(
                  Effect.tap((providerThread) =>
                    markProviderThreadLoaded({
                      providerSessionId,
                      expectedRuntime: runtime,
                      threadId: input.threadId,
                      providerThreadKey: providerThreadLoadKey({
                        providerThread,
                        modelSelection: input.modelSelection,
                        runtimePolicy: input.runtimePolicy,
                      }),
                    }),
                  ),
                ),
            ),
          resumeThread: (input) => {
            const threadId = input.threadId ?? input.providerThread.appThreadId;
            if (threadId === null || threadId === undefined) {
              // No attach key exists without a thread, so the ownership check
              // and the adapter call share the session-open lock a release
              // drains before closing the scope.
              return sessionOpen.withLock(
                providerSessionId,
                runResourceCreatingAdapterOp({
                  providerSessionId,
                  expectedRuntime: runtime,
                  driver: runtime.driver,
                  operation: runtime.resumeThread(input),
                  drainTimeout: undefined,
                }),
              );
            }
            const providerThreadKey = providerThreadLoadKey({
              providerThread: input.providerThread,
              ...(input.modelSelection === undefined
                ? {}
                : { modelSelection: input.modelSelection }),
              ...(input.runtimePolicy === undefined ? {} : { runtimePolicy: input.runtimePolicy }),
            });
            return attachThreadOrReject(
              {
                providerSessionId,
                threadId,
                providerInstanceId: runtime.instanceId,
                driver: runtime.driver,
                expectedRuntime: runtime,
              },
              () =>
                isProviderThreadLoaded({
                  providerSessionId,
                  threadId,
                  providerThreadKey,
                  expectedRuntime: runtime,
                }).pipe(
                  Effect.flatMap((loaded) =>
                    loaded
                      ? Effect.succeed(input.providerThread)
                      : runResourceCreatingAdapterOp({
                          providerSessionId,
                          expectedRuntime: runtime,
                          driver: runtime.driver,
                          operation: runtime.resumeThread(input),
                          drainTimeout: undefined,
                          requiredThreadId: threadId,
                        }),
                  ),
                  Effect.tap((providerThread) =>
                    markProviderThreadLoaded({
                      providerSessionId,
                      expectedRuntime: runtime,
                      threadId,
                      providerThreadKey: providerThreadLoadKey({
                        providerThread,
                        ...(input.modelSelection === undefined
                          ? {}
                          : { modelSelection: input.modelSelection }),
                        ...(input.runtimePolicy === undefined
                          ? {}
                          : { runtimePolicy: input.runtimePolicy }),
                      }),
                    }),
                  ),
                ),
            );
          },
          forkThread: (input) =>
            attachThreadOrReject(
              {
                providerSessionId,
                threadId: input.targetThreadId,
                providerInstanceId: runtime.instanceId,
                driver: runtime.driver,
                expectedRuntime: runtime,
              },
              // Fork acquires provider-side state for the target thread
              // (ACP session/fork may restart the runtime) — the same
              // acquire-then-return shape as ensure/resume, so it drains
              // under the same admission record.
              () =>
                runResourceCreatingAdapterOp({
                  providerSessionId,
                  expectedRuntime: runtime,
                  driver: runtime.driver,
                  operation: runtime.forkThread(input),
                  drainTimeout: undefined,
                  requiredThreadId: input.targetThreadId,
                }).pipe(
                  Effect.tap((providerThread) =>
                    markProviderThreadLoaded({
                      providerSessionId,
                      expectedRuntime: runtime,
                      threadId: input.targetThreadId,
                      providerThreadKey: providerThreadLoadKey({
                        providerThread,
                        ...(input.modelSelection === undefined
                          ? {}
                          : { modelSelection: input.modelSelection }),
                        ...(input.runtimePolicy === undefined
                          ? {}
                          : { runtimePolicy: input.runtimePolicy }),
                      }),
                    }),
                  ),
                ),
            ),
          startTurn: (input) =>
            // markBusy runs before the attach rather than between it and the
            // adapter call: it can suspend waiting on the idle fiber, and the
            // attach lock must not be held across that wait (an open already
            // holding threadLifecycle would deadlock on it). The attach's own
            // gates re-check ownership after the suspend. The unwind covers
            // every non-success exit — interruption while queued on the attach
            // lock must not leave the session pinned busy forever — but only
            // when this call actually took the mark: decrementing without it
            // would steal another holder's busy count and idle a live turn.
            Ref.make(false).pipe(
              Effect.flatMap((busyMarked) =>
                Effect.onExit(
                  observeActivity(
                    providerSessionId,
                    markBusy(providerSessionId, runtime, busyMarked),
                  ).pipe(
                    Effect.andThen(
                      attachThreadOrReject(
                        {
                          providerSessionId,
                          threadId: input.threadId,
                          providerInstanceId: runtime.instanceId,
                          driver: runtime.driver,
                          expectedRuntime: runtime,
                        },
                        // The adapter call returns once the turn is started —
                        // most adapters fork the turn's lifetime into the
                        // session scope — so the admission record spans only
                        // the acquisition window (Cursor's openAgent/
                        // runner.open, ACP session activate+prompt submit).
                        // Only in-band turn calls get the bounded drain —
                        // abandoning an acquire-then-return call could strand
                        // a resource the scope close already finished
                        // checking for.
                        () =>
                          runResourceCreatingAdapterOp({
                            providerSessionId,
                            expectedRuntime: runtime,
                            driver: runtime.driver,
                            operation: runtime.startTurn(input),
                            drainTimeout: INBAND_TURN_CALL_DRIVERS.has(runtime.driver)
                              ? Duration.millis(ADAPTER_OP_DRAIN_TIMEOUT_MS)
                              : undefined,
                            requiredThreadId: input.threadId,
                          }),
                      ),
                    ),
                  ),
                  (exit) =>
                    Exit.isSuccess(exit)
                      ? Effect.void
                      : Ref.get(busyMarked).pipe(
                          Effect.flatMap((marked) =>
                            marked
                              ? observeActivity(
                                  providerSessionId,
                                  markIdle(providerSessionId, runtime),
                                )
                              : Effect.void,
                          ),
                        ),
                ),
              ),
            ),
          steerTurn: (input) =>
            requireLiveRuntime({
              providerSessionId,
              expectedRuntime: runtime,
              driver: runtime.driver,
            }).pipe(
              Effect.andThen(
                observeActivity(providerSessionId, touchActivity(providerSessionId, runtime)),
              ),
              // touchActivity can suspend waiting on the idle fiber; a close
              // may have claimed the session meanwhile — re-check before
              // invoking the adapter.
              Effect.andThen(
                requireLiveRuntime({
                  providerSessionId,
                  expectedRuntime: runtime,
                  driver: runtime.driver,
                }),
              ),
              Effect.andThen(runtime.steerTurn(input)),
            ),
          interruptTurn: (input) =>
            requireLiveRuntime({
              providerSessionId,
              expectedRuntime: runtime,
              driver: runtime.driver,
            }).pipe(
              Effect.andThen(
                observeActivity(providerSessionId, touchActivity(providerSessionId, runtime)),
              ),
              Effect.andThen(
                requireLiveRuntime({
                  providerSessionId,
                  expectedRuntime: runtime,
                  driver: runtime.driver,
                }),
              ),
              Effect.andThen(runtime.interruptTurn(input)),
            ),
          respondToRuntimeRequest: (input) =>
            requireLiveRuntime({
              providerSessionId,
              expectedRuntime: runtime,
              driver: runtime.driver,
            }).pipe(
              Effect.andThen(
                observeActivity(providerSessionId, touchActivity(providerSessionId, runtime)),
              ),
              Effect.andThen(
                requireLiveRuntime({
                  providerSessionId,
                  expectedRuntime: runtime,
                  driver: runtime.driver,
                }),
              ),
              Effect.andThen(runtime.respondToRuntimeRequest(input)),
            ),
          // Every exposed adapter operation must reject a stale handle: a
          // released session's runtime is already closing, and a same-id
          // reopen hands callers a new runtime — the spread would otherwise
          // carry these through unguarded.
          ...(runtime.compactThread === undefined
            ? {}
            : {
                compactThread: (input: Parameters<NonNullable<typeof runtime.compactThread>>[0]) =>
                  // Same markBusy-before-attach ordering as startTurn: the
                  // wait on the idle fiber must not run under the attach lock,
                  // and the unwind covers interruption the same way — gated on
                  // this call's own acquisition flag so a pre-increment
                  // interrupt cannot steal another holder's busy count.
                  Ref.make(false).pipe(
                    Effect.flatMap((busyMarked) =>
                      Effect.onExit(
                        observeActivity(
                          providerSessionId,
                          markBusy(providerSessionId, runtime, busyMarked),
                        ).pipe(
                          Effect.andThen(
                            attachThreadOrReject(
                              {
                                providerSessionId,
                                threadId: input.threadId,
                                providerInstanceId: runtime.instanceId,
                                driver: runtime.driver,
                                expectedRuntime: runtime,
                              },
                              // Compaction delegates to the same
                              // acquire-then-start path as startTurn, so it
                              // shares the admission record and the same
                              // driver-keyed drain policy.
                              () =>
                                runResourceCreatingAdapterOp({
                                  providerSessionId,
                                  expectedRuntime: runtime,
                                  driver: runtime.driver,
                                  operation: runtime.compactThread!(input),
                                  drainTimeout: INBAND_TURN_CALL_DRIVERS.has(runtime.driver)
                                    ? Duration.millis(ADAPTER_OP_DRAIN_TIMEOUT_MS)
                                    : undefined,
                                  requiredThreadId: input.threadId,
                                }),
                            ),
                          ),
                        ),
                        (exit) =>
                          Exit.isSuccess(exit)
                            ? Effect.void
                            : Ref.get(busyMarked).pipe(
                                Effect.flatMap((marked) =>
                                  marked
                                    ? observeActivity(
                                        providerSessionId,
                                        markIdle(providerSessionId, runtime),
                                      )
                                    : Effect.void,
                                ),
                              ),
                      ),
                    ),
                  ),
              }),
          readThreadSnapshot: (input) =>
            requireLiveRuntime({
              providerSessionId,
              expectedRuntime: runtime,
              driver: runtime.driver,
            }).pipe(
              Effect.andThen(
                observeActivity(providerSessionId, touchActivity(providerSessionId, runtime)),
              ),
              Effect.andThen(
                requireLiveRuntime({
                  providerSessionId,
                  expectedRuntime: runtime,
                  driver: runtime.driver,
                }),
              ),
              Effect.andThen(
                runResourceCreatingAdapterOp({
                  providerSessionId,
                  expectedRuntime: runtime,
                  driver: runtime.driver,
                  operation: runtime.readThreadSnapshot(input),
                  drainTimeout: undefined,
                }),
              ),
            ),
          rollbackThread: (input) =>
            requireLiveRuntime({
              providerSessionId,
              expectedRuntime: runtime,
              driver: runtime.driver,
            }).pipe(
              Effect.andThen(
                observeActivity(providerSessionId, touchActivity(providerSessionId, runtime)),
              ),
              Effect.andThen(
                requireLiveRuntime({
                  providerSessionId,
                  expectedRuntime: runtime,
                  driver: runtime.driver,
                }),
              ),
              Effect.andThen(
                runResourceCreatingAdapterOp({
                  providerSessionId,
                  expectedRuntime: runtime,
                  driver: runtime.driver,
                  operation: runtime.rollbackThread(input),
                  drainTimeout: undefined,
                }),
              ),
            ),
          ...(runtime.uploadFeedback === undefined
            ? {}
            : {
                uploadFeedback: (
                  input: Parameters<NonNullable<typeof runtime.uploadFeedback>>[0],
                ) =>
                  requireLiveRuntime({
                    providerSessionId,
                    expectedRuntime: runtime,
                    driver: runtime.driver,
                  }).pipe(
                    Effect.andThen(
                      observeActivity(providerSessionId, touchActivity(providerSessionId, runtime)),
                    ),
                    Effect.andThen(
                      requireLiveRuntime({
                        providerSessionId,
                        expectedRuntime: runtime,
                        driver: runtime.driver,
                      }),
                    ),
                    Effect.andThen(runtime.uploadFeedback!(input)),
                  ),
              }),
          ...(runtime.injectHistory === undefined
            ? {}
            : {
                injectHistory: (input: Parameters<NonNullable<typeof runtime.injectHistory>>[0]) =>
                  requireLiveRuntime({
                    providerSessionId,
                    expectedRuntime: runtime,
                    driver: runtime.driver,
                  }).pipe(
                    Effect.andThen(
                      observeActivity(providerSessionId, touchActivity(providerSessionId, runtime)),
                    ),
                    Effect.andThen(
                      requireLiveRuntime({
                        providerSessionId,
                        expectedRuntime: runtime,
                        driver: runtime.driver,
                      }),
                    ),
                    // Injection mutates an already-attached native thread
                    // without a turn's busy pin, so it admits like snapshot and
                    // rollback: a release drains the call before scope close
                    // and the ownership recheck refuses a runtime a detach or
                    // replacement already retired.
                    Effect.andThen(
                      runResourceCreatingAdapterOp({
                        providerSessionId,
                        expectedRuntime: runtime,
                        driver: runtime.driver,
                        operation: runtime.injectHistory!(input),
                        ...(input.providerThread.appThreadId === null
                          ? {}
                          : { requiredThreadId: input.providerThread.appThreadId }),
                        // A request/response mutation, not an acquisition: an
                        // unanswered request must not pin teardown — the drain
                        // bound abandons the wait and scope close reclaims the
                        // call — and must not pin the caller either, so the
                        // request itself restores interruption while the
                        // admission and its settle stay masked.
                        drainTimeout: Duration.millis(ADAPTER_OP_DRAIN_TIMEOUT_MS),
                        interruptibleOperation: true,
                      }),
                    ),
                  ),
              }),
        };
      };

      const persistProviderSessionUpdate = (
        entry: LiveSessionEntry,
        event: Extract<ProviderAdapterV2Event, { readonly type: "provider_session.updated" }>,
      ) =>
        // The release path reports terminal status under releaseStatus, so
        // checking ownership and writing inside the same lock orders this
        // update strictly before any stopped/error write: a release that
        // claimed the session first is observed here and the late write is
        // skipped instead of resurrecting the persisted live status.
        releaseStatus
          .withLock(
            entry.runtime.providerSessionId,
            Effect.gen(function* () {
              const current = (yield* Ref.get(sessions)).get(
                sessionKey(entry.runtime.providerSessionId),
              );
              if (current?.runtime !== entry.runtime) {
                return;
              }
              yield* writeProviderSessionEvents({
                runtime: entry.runtime,
                threadIds: current.attachedThreadIds,
                type: "provider-session.updated",
                payload: event.providerSession,
              });
            }),
          )
          .pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("orchestration-v2.driver-session.status-persist-failed", {
                providerSessionId: entry.runtime.providerSessionId,
                cause,
              }),
            ),
          );

      const startEventPump = (entry: LiveSessionEntry) => {
        let stoppedByProvider = false;
        return entry.runtime.events.pipe(
          Stream.runForEach((event) => {
            if (
              event.type === "provider_session.updated" &&
              event.providerSession.status === "stopped"
            ) {
              stoppedByProvider = true;
            }
            return observeActivity(
              entry.runtime.providerSessionId,
              event.type === "turn.terminal"
                ? markIdle(entry.runtime.providerSessionId, entry.runtime)
                : touchActivity(entry.runtime.providerSessionId, entry.runtime),
            ).pipe(
              Effect.andThen(
                event.type === "provider_session.updated"
                  ? persistProviderSessionUpdate(entry, event)
                  : Effect.void,
              ),
              Effect.andThen(
                Effect.gen(function* () {
                  // Some providers can block before a run subscriber exists
                  // (project trust, login, or session-switch hooks). Persist
                  // their runless request artifacts directly so the normal T3
                  // request UI can answer them and unblock session setup.
                  const threadId = sessionScopedRuntimeRequestThreadId(event);
                  if (threadId !== undefined) {
                    yield* Effect.gen(function* () {
                      const current = (yield* Ref.get(sessions)).get(
                        sessionKey(entry.runtime.providerSessionId),
                      );
                      if (current?.runtime !== entry.runtime) return;
                      yield* providerEventIngestor
                        .ingestNormalized({
                          providerSessionId: entry.runtime.providerSessionId,
                          providerInstanceId: entry.runtime.instanceId,
                          threadId,
                          event,
                        })
                        .pipe(
                          Effect.mapError(
                            (cause) =>
                              new ProviderAdapterEventStreamError({
                                driver: entry.runtime.driver,
                                providerSessionId: entry.runtime.providerSessionId,
                                cause,
                              }),
                          ),
                        );
                    }).pipe(entry.requestEventPermit.withPermits(1));
                    return;
                  }
                  yield* publishToSubscribers(entry.eventSubscribers, { type: "event", event });
                }),
              ),
            );
          }),
          Effect.exit,
          Effect.flatMap((exit) =>
            Effect.gen(function* () {
              const current = (yield* Ref.get(sessions)).get(
                sessionKey(entry.runtime.providerSessionId),
              );
              if (current?.runtime !== entry.runtime) {
                return;
              }
              if (stoppedByProvider && Exit.isSuccess(exit)) {
                yield* releaseEntry({
                  providerSessionId: entry.runtime.providerSessionId,
                  reason: "manual_shutdown",
                  gracefulSubscribers: true,
                  expectedRuntime: entry.runtime,
                }).pipe(Effect.ignore);
                return;
              }
              const cause = Exit.isFailure(exit)
                ? exit.cause
                : Cause.fail(
                    new ProviderAdapterEventStreamError({
                      driver: entry.runtime.driver,
                      providerSessionId: entry.runtime.providerSessionId,
                      cause: "Provider event stream ended unexpectedly.",
                    }),
                  );
              yield* publishToSubscribers(entry.eventSubscribers, {
                type: "failure",
                cause,
              });
              yield* Ref.set(entry.eventSubscribers, new Map());
              yield* releaseEntry({
                providerSessionId: entry.runtime.providerSessionId,
                reason: "runtime_error",
                detail: Cause.pretty(cause),
                expectedRuntime: entry.runtime,
              }).pipe(Effect.ignore);
            }),
          ),
          Effect.forkIn(layerScope),
        );
      };

      const shutdown = Effect.gen(function* () {
        // Fence first, in one synchronous pass: a startup that already
        // registered is found by the session scan below; one still opening
        // was created before this flag and is marked here so its
        // registration fence loses instead of slipping in while the
        // releases run. The flag is permanent — the manager is going away.
        shutdownInitiated = true;
        const starting = Array.from(opening.values());
        for (const record of starting) {
          if (record.failed === undefined) {
            record.closeRequested = true;
          }
        }
        const activeSessions = [...(yield* Ref.get(sessions)).values()];
        // Every wait below is independently bounded, and the phases target
        // disjoint resources — run all of them concurrently so a few wedged
        // provider processes cannot multiply the teardown wait. Ownership is
        // unchanged: shutdown still joins each tracked cleanup before it
        // returns.
        yield* Effect.all(
          [
            Effect.forEach(
              activeSessions,
              (entry) =>
                releaseEntry({
                  providerSessionId: entry.runtime.providerSessionId,
                  reason: "server_shutdown",
                  expectedRuntime: entry.runtime,
                }).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("orchestration-v2.driver-session.shutdown-release-failed", {
                      providerSessionId: entry.runtime.providerSessionId,
                      cause,
                    }),
                  ),
                ),
              { concurrency: "unbounded", discard: true },
            ),
            // Releases already claimed before this shutdown (a racing close,
            // detach, or idle sweep) are invisible to the sessions scan; join
            // each pending record so teardown does not return while cleanup
            // still runs against the manager's dependencies.
            Effect.forEach(
              [...releasing.values()],
              (release) =>
                releaseEntry({
                  providerSessionId: release.entry.runtime.providerSessionId,
                  reason: "server_shutdown",
                  joinOnly: true,
                  expectedRuntime: release.entry.runtime,
                }).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("orchestration-v2.driver-session.shutdown-release-failed", {
                      providerSessionId: release.entry.runtime.providerSessionId,
                      cause,
                    }),
                  ),
                ),
              { concurrency: "unbounded", discard: true },
            ),
            // Terminal-detach credential sweeps outlive their callers in
            // pendingRevocations; join each tracked tail (bounded like every
            // cleanup wait) so teardown does not return while a revocation is
            // still running. In-flight detaches are drained first: one still
            // inside its lock can register a tail after a single snapshot.
            joinTrackedRevocations(
              () => true,
              (threadId, done) =>
                Deferred.await(done).pipe(
                  Effect.timeoutOption(RELEASE_SCOPE_CLOSE_TIMEOUT_MS),
                  Effect.flatMap((settled) =>
                    Option.isNone(settled)
                      ? Effect.logWarning(
                          "orchestration-v2.driver-session.shutdown-revocation-pending",
                          { threadId },
                        )
                      : Effect.void,
                  ),
                  Effect.catchCause((cause) =>
                    Effect.logWarning("orchestration-v2.driver-session.shutdown-release-failed", {
                      threadId,
                      cause,
                    }),
                  ),
                ),
              (marker) =>
                Deferred.await(marker.detached).pipe(
                  Effect.timeoutOption(RELEASE_SCOPE_CLOSE_TIMEOUT_MS),
                  Effect.flatMap((settled) =>
                    Option.isNone(settled)
                      ? Effect.logWarning(
                          "orchestration-v2.driver-session.shutdown-detach-pending",
                          {
                            providerSessionId: marker.providerSessionId,
                            threadId: marker.threadId,
                          },
                        )
                      : Effect.void,
                  ),
                ),
              () => true,
            ).pipe(Effect.ignore),
            // In-flight startups own provider resources without a live entry;
            // they were marked above — join their bounded unwind during
            // shutdown too.
            Effect.forEach(
              starting,
              (record) =>
                releaseEntry({
                  providerSessionId: record.providerSessionId,
                  reason: "server_shutdown",
                }).pipe(
                  Effect.catchCause((cause) =>
                    Effect.logWarning("orchestration-v2.driver-session.shutdown-release-failed", {
                      providerSessionId: record.providerSessionId,
                      cause,
                    }),
                  ),
                ),
              { concurrency: "unbounded", discard: true },
            ),
          ],
          { concurrency: "unbounded", discard: true },
        );
      });
      yield* Effect.addFinalizer(() => shutdown);

      return ProviderSessionManagerV2.of({
        shutdown,
        open: (input) => {
          const open = sessionOpen.withLock(
            input.providerSessionId,
            Effect.gen(function* () {
              const key = sessionKey(input.providerSessionId);
              // The reservation from prepare protects the credential (which
              // eager adapters bake into the provider process during
              // openSession) from racing releases until this session's entry
              // is recorded below. Dropped exactly once on every path — the
              // pending id is captured as soon as prepare reserves it, and the
              // single onExit below covers every non-success exit of the
              // whole prepare→open→register sequence so no interleave can
              // strand the reservation.
              let pendingMcpCredentialId: string | undefined;
              let reservationDropped = false;
              const dropReservationNow = () => {
                if (!reservationDropped && pendingMcpCredentialId !== undefined) {
                  reservationDropped = true;
                  dropMcpCredentialReservation(input.threadId, pendingMcpCredentialId);
                }
              };
              const dropReservation = Effect.sync(dropReservationNow);
              const sessionScope = yield* Scope.make();
              // Track the startup before any suspension — the workspace stat
              // and adapter lookup included: a close or detach racing the open
              // marks closeRequested and joins this record's unwind instead of
              // reporting success while provider resources are being spawned.
              // sessionOpen serializes same-id opens, so a record found here
              // later can only be a failed leftover. The flag check and the
              // insert share one synchronous step so a startup can never
              // begin tracking after its instance's close already scanned.
              let entryRegistered = false;
              let registeredRuntime: ProviderAdapterV2SessionRuntime | undefined;
              // Registration and the unwind handler are one uninterruptible
              // handoff: an interrupt landing after `opening.set` but before
              // the onExit is installed would strand the record — a racing
              // close would mark it and join a `settled` that never
              // completes. The open itself stays interruptible under
              // `restore`; every exit from it still runs the unwind.
              const exposedRuntime = yield* Effect.uninterruptibleMask((restore) =>
                Effect.gen(function* () {
                  const openingRecord = yield* Effect.sync(
                    (): OpeningSessionRecord | "blocked" | undefined => {
                      if (
                        shutdownInitiated ||
                        closingInstanceCounts.has(input.modelSelection.instanceId)
                      ) {
                        return undefined;
                      }
                      // sessionOpen serializes same-id opens, so a record
                      // found here can only be a failed or still-unwinding
                      // leftover — it must keep blocking replacements.
                      if (opening.has(key)) {
                        return "blocked";
                      }
                      const record: OpeningSessionRecord = {
                        providerSessionId: input.providerSessionId,
                        threadId: input.threadId,
                        instanceId: input.modelSelection.instanceId,
                        closeRequested: false,
                        failed: undefined,
                        settled: Deferred.makeUnsafe<void, ProviderSessionReleaseError>(),
                      };
                      opening.set(key, record);
                      return record;
                    },
                  );
                  if (openingRecord === "blocked") {
                    return yield* new ProviderSessionOpenError({
                      instanceId: input.modelSelection.instanceId,
                      providerSessionId: input.providerSessionId,
                      cause: "A previous provider session has not finished cleanup.",
                    });
                  }
                  if (openingRecord === undefined) {
                    return yield* new ProviderSessionOpenError({
                      instanceId: input.modelSelection.instanceId,
                      providerSessionId: input.providerSessionId,
                      cause: "The provider session was closed before it finished opening.",
                    });
                  }
                  return yield* restore(
                    Effect.gen(function* () {
                      const cwd = input.runtimePolicy.cwd;
                      if (cwd !== null) {
                        const workspaceIsDirectory = yield* fileSystem.stat(cwd).pipe(
                          Effect.map((stat) => stat.type === "Directory"),
                          Effect.catch((error) => Effect.succeed(error.reason._tag !== "NotFound")),
                        );
                        if (!workspaceIsDirectory) {
                          return yield* new ProviderWorkspaceMissingError({
                            threadId: input.threadId,
                            cwd,
                          });
                        }
                      }
                      const existing = (yield* Ref.get(sessions)).get(key);
                      const pending = findPendingRelease(
                        input.providerSessionId,
                        input.threadId,
                        existing,
                      );
                      if (pending !== undefined) {
                        return yield* new ProviderSessionOpenError({
                          instanceId: input.modelSelection.instanceId,
                          providerSessionId: input.providerSessionId,
                          cause: `Provider session ${pending.entry.runtime.providerSessionId} has not finished cleanup.`,
                        });
                      }
                      // Block the replacement like a pending release: a failed or
                      // still-unwinding startup for the session id or the same thread
                      // may still own provider resources.
                      const blockingStartup = findBlockingStartup(
                        input.providerSessionId,
                        input.threadId,
                      );
                      if (blockingStartup !== undefined) {
                        return yield* new ProviderSessionOpenError({
                          instanceId: input.modelSelection.instanceId,
                          providerSessionId: input.providerSessionId,
                          cause: `Provider session ${blockingStartup.providerSessionId} has not finished cleanup.`,
                        });
                      }
                      if (existing !== undefined) {
                        if (
                          !existing.attachedThreadIds.has(input.threadId) &&
                          !existing.supportsMultipleProviderThreads
                        ) {
                          return yield* new ProviderSessionOpenError({
                            instanceId: input.modelSelection.instanceId,
                            providerSessionId: input.providerSessionId,
                            cause: `Provider ${existing.runtime.driver} does not support attaching multiple app threads to one session.`,
                          });
                        }
                        const attached = yield* ensureThreadAttached({
                          providerSessionId: input.providerSessionId,
                          threadId: input.threadId,
                          providerInstanceId: existing.runtime.instanceId,
                          expectedRuntime: existing.runtime,
                        });
                        if (attached === "closing" || attached === "released") {
                          return yield* new ProviderSessionOpenError({
                            instanceId: input.modelSelection.instanceId,
                            providerSessionId: input.providerSessionId,
                            cause: `Provider session ${input.providerSessionId} ${
                              attached === "closing"
                                ? "has not finished cleanup."
                                : "is no longer running."
                            }`,
                          });
                        }
                        yield* touchActivity(input.providerSessionId, existing.runtime);
                        return existing.exposedRuntime;
                      }

                      const adapter = yield* registry.get(input.modelSelection.instanceId).pipe(
                        Effect.mapError(
                          (cause) =>
                            new ProviderSessionOpenError({
                              instanceId: input.modelSelection.instanceId,
                              providerSessionId: input.providerSessionId,
                              cause,
                            }),
                        ),
                      );
                      const prepared = yield* prepareMcpSession(
                        input.threadId,
                        input.modelSelection.instanceId,
                        (mcpCredentialId) => {
                          pendingMcpCredentialId = mcpCredentialId;
                        },
                      );
                      const mcpCredentialId = prepared.mcpCredentialId;
                      // A close marked this startup while credentials were
                      // resolving: skip the spawn entirely and unwind. A mark
                      // landing after this read is still caught by the
                      // registration fence below.
                      if (openingRecord.closeRequested) {
                        return yield* new ProviderSessionOpenError({
                          instanceId: input.modelSelection.instanceId,
                          providerSessionId: input.providerSessionId,
                          cause: "The provider session was closed before it finished opening.",
                        });
                      }
                      const runtime = yield* adapter
                        .openSession({
                          threadId: input.threadId,
                          providerSessionId: input.providerSessionId,
                          modelSelection: input.modelSelection,
                          runtimePolicy: input.runtimePolicy,
                          ...(input.resumeFromSession === undefined
                            ? {}
                            : { resumeFromSession: input.resumeFromSession }),
                          ...(input.initialNativeThreadId === undefined
                            ? {}
                            : { initialNativeThreadId: input.initialNativeThreadId }),
                          ...(input.initialProviderItemIdentityVersion === undefined
                            ? {}
                            : {
                                initialProviderItemIdentityVersion:
                                  input.initialProviderItemIdentityVersion,
                              }),
                        })
                        .pipe(
                          Effect.provideService(Scope.Scope, sessionScope),
                          Effect.mapError(
                            (cause) =>
                              new ProviderSessionOpenError({
                                instanceId: input.modelSelection.instanceId,
                                providerSessionId: input.providerSessionId,
                                cause,
                              }),
                          ),
                        );
                      const eventSubscribers = yield* Ref.make<
                        ReadonlyMap<number, Queue.Queue<ProviderSessionEventSignal, Cause.Done>>
                      >(new Map());
                      const exposedRuntime = decorateRuntime(runtime, eventSubscribers);
                      const now = yield* Clock.currentTimeMillis;
                      const entry: LiveSessionEntry = {
                        attachedThreadIds: new Set([input.threadId]),
                        loadedProviderThreadKeyByThread: new Map(),
                        mcpCredentialIdByThread:
                          mcpCredentialId === undefined
                            ? new Map()
                            : new Map([[input.threadId, mcpCredentialId]]),
                        supportsMultipleProviderThreads:
                          runtime.providerSession.capabilities.sessions
                            .supportsMultipleProviderThreadsPerSession,
                        runtime,
                        exposedRuntime,
                        eventSubscribers,
                        requestEventPermit: yield* Semaphore.make(1),
                        scope: sessionScope,
                        idleGeneration: 0,
                        busyCount: 0,
                        lastActivityAtMs: now,
                        idleFiber: null,
                        pinnedSinceMs: null,
                      };
                      // Fenced in the same atomic step: a close that marked this
                      // startup (or a closeInstance/shutdown that fenced its
                      // instance) before the adapter returned must not see a live
                      // entry appear behind its back — the unwind below closes
                      // the scope and completes `settled` instead.
                      yield* Ref.modify(
                        sessions,
                        (current): readonly [boolean, Map<string, LiveSessionEntry>] => {
                          if (
                            openingRecord.closeRequested ||
                            shutdownInitiated ||
                            closingInstanceCounts.has(openingRecord.instanceId)
                          ) {
                            return [false, current] as const;
                          }
                          const updated = new Map(current);
                          updated.set(key, entry);
                          // Set inside the atomic update: from here the release path
                          // owns cleanup and the entry's credential record guards the
                          // credential.
                          entryRegistered = true;
                          registeredRuntime = runtime;
                          return [true, updated] as const;
                        },
                      );
                      if (entryRegistered) {
                        opening.delete(key);
                        yield* Deferred.done(openingRecord.settled, Exit.void);
                      } else {
                        // A close won the race: skip the spawn bookkeeping entirely
                        // and fail so the unwind closes the provider scope and
                        // settles the startup record the close is joining.
                        return yield* new ProviderSessionOpenError({
                          instanceId: input.modelSelection.instanceId,
                          providerSessionId: input.providerSessionId,
                          cause: "The provider session was closed before it finished opening.",
                        });
                      }
                      // The pre-open reservation can be dropped now; the onExit
                      // below also drops it so an interruption landing before this
                      // line cannot strand it.
                      yield* dropReservation;
                      // Ownership check, attach-event write, and recheck all run under
                      // releaseStatus — the lock the release path reports terminal
                      // status through. A close can claim the session while this write
                      // suspends (removal does not take the lock), so the recheck keeps
                      // open from returning a runtime that is already being released,
                      // and the in-lock check keeps a late attach event from
                      // overwriting the persisted stopped/error status.
                      const persisted = yield* releaseStatus
                        .withLock(
                          input.providerSessionId,
                          Effect.gen(function* () {
                            const owned = (yield* Ref.get(sessions)).get(key)?.runtime === runtime;
                            if (!owned) {
                              return false;
                            }
                            yield* withActivityError(
                              input.providerSessionId,
                              writeProviderSessionEvents({
                                runtime,
                                threadIds: [input.threadId],
                                type: "provider-session.attached",
                                payload: runtime.providerSession,
                              }),
                            );
                            return (yield* Ref.get(sessions)).get(key)?.runtime === runtime;
                          }),
                        )
                        .pipe(
                          Effect.tapError(() =>
                            releaseEntry({
                              providerSessionId: input.providerSessionId,
                              reason: "runtime_error",
                              detail: "Failed to persist the provider-session attachment.",
                              alreadyLocked: true,
                              expectedRuntime: runtime,
                            }).pipe(Effect.ignore),
                          ),
                        );
                      if (!persisted) {
                        return yield* new ProviderSessionOpenError({
                          instanceId: input.modelSelection.instanceId,
                          providerSessionId: input.providerSessionId,
                          cause: "The provider session was closed before it finished opening.",
                        });
                      }
                      yield* startEventPump(entry);
                      yield* scheduleIdleRelease(input.providerSessionId, runtime);
                      return exposedRuntime;
                    }),
                  ).pipe(
                    Effect.onExit((exit) =>
                      Exit.isSuccess(exit)
                        ? entryRegistered
                          ? Effect.void
                          : // Early returns — a reused live session or a
                            // rejected attach — never hand the record to the
                            // release path; settle it here or a racing close
                            // joins a deferred that never completes.
                            Effect.uninterruptible(
                              Effect.gen(function* () {
                                if (opening.get(key) === openingRecord) {
                                  opening.delete(key);
                                }
                                yield* Deferred.done(openingRecord.settled, Exit.void);
                              }),
                            )
                        : Effect.suspend(() => {
                            if (entryRegistered) {
                              // A registered entry guards the credential by its
                              // own record, so the reservation can go before the
                              // half-initialized entry is handed to the release
                              // path. Forked: this fiber still holds sessionOpen,
                              // which the release's waitForOpens needs.
                              dropReservationNow();
                              return releaseEntry({
                                providerSessionId: input.providerSessionId,
                                reason: "runtime_error",
                                detail: "Provider session open was interrupted.",
                                ...(registeredRuntime === undefined
                                  ? {}
                                  : { expectedRuntime: registeredRuntime }),
                              }).pipe(Effect.forkDetach({ startImmediately: true }), Effect.asVoid);
                            }
                            // A defecting finalizer must not keep the rest of the
                            // unwind from running — but its failure must stay
                            // visible: closing over a provider process that may
                            // still be alive keeps the opening record as a failed
                            // cleanup so replacement opens stay blocked until
                            // restart, and a racing close's join sees the error.
                            return Effect.gen(function* () {
                              // The record stays blocking while the unwind runs:
                              // attachments and replacements must wait for the
                              // scope close rather than racing a provider process
                              // that is still shutting down.
                              openingRecord.closeRequested = true;
                              const closeExit = yield* Scope.close(sessionScope, Exit.void).pipe(
                                Effect.exit,
                              );
                              // The reservation outlives a successful scope
                              // close: the provider process can still present
                              // the credential while it is shutting down, so a
                              // peer's terminal detach must keep seeing this
                              // claim until the close settles. A failed close
                              // keeps the reservation — and skips the sweep —
                              // because the provider may still own the
                              // credential.
                              if (Exit.isSuccess(closeExit)) {
                                dropReservationNow();
                              }
                              const sweepExit =
                                Exit.isFailure(closeExit) || pendingMcpCredentialId === undefined
                                  ? Exit.void
                                  : yield* releaseUnclaimedMcpCredential(
                                      input.threadId,
                                      pendingMcpCredentialId,
                                    ).pipe(Effect.exit);
                              const failed = Exit.isFailure(closeExit)
                                ? closeExit
                                : Exit.isFailure(sweepExit)
                                  ? sweepExit
                                  : undefined;
                              if (failed === undefined) {
                                opening.delete(key);
                                yield* Deferred.done(openingRecord.settled, Exit.void);
                                return;
                              }
                              const error = new ProviderSessionReleaseError({
                                providerSessionId: input.providerSessionId,
                                reason: "runtime_error",
                                cause: failed.cause,
                              });
                              openingRecord.failed = error;
                              yield* Deferred.done(openingRecord.settled, Exit.fail(error));
                            });
                          }),
                    ),
                  );
                }),
              );
              return exposedRuntime;
            }),
          );
          return Effect.gen(function* () {
            // Reusing an attached live session starts no new provider work.
            const existing = (yield* Ref.get(sessions)).get(sessionKey(input.providerSessionId));
            if (
              findPendingRelease(input.providerSessionId, input.threadId, existing) !== undefined ||
              findBlockingStartup(input.providerSessionId, input.threadId) !== undefined
            ) {
              return yield* new ProviderSessionOpenError({
                instanceId: input.modelSelection.instanceId,
                providerSessionId: input.providerSessionId,
                cause: "A previous provider session has not finished cleanup.",
              });
            }
            return yield* threadLifecycle.withLock(input.threadId, open);
          });
        },
        get: (providerSessionId) =>
          Effect.gen(function* () {
            const entry = (yield* Ref.get(sessions)).get(sessionKey(providerSessionId));
            if (entry === undefined) {
              return Option.none<ProviderAdapterV2SessionRuntime>();
            }
            yield* touchActivity(providerSessionId, entry.runtime);
            return Option.some(entry.exposedRuntime);
          }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderSessionLookupError({
                  providerSessionId,
                  cause,
                }),
            ),
          ),
        close: (providerSessionId) =>
          releaseEntry({ providerSessionId, reason: "manual_shutdown" }).pipe(
            Effect.mapError(
              (cause) =>
                new ProviderSessionCloseError({
                  providerSessionId,
                  cause,
                }),
            ),
          ),
        closeInstance: (instanceId) =>
          Effect.gen(function* () {
            // Fence first, in one synchronous pass (same reasoning as
            // shutdown): startups created after this point are rejected at
            // the record gate; the ones already tracked are marked so their
            // registration fence loses while the releases below run.
            closingInstanceCounts.set(instanceId, (closingInstanceCounts.get(instanceId) ?? 0) + 1);
            const starting = Array.from(opening.values()).filter(
              (record) => record.instanceId === instanceId,
            );
            for (const record of starting) {
              if (record.failed === undefined) {
                record.closeRequested = true;
              }
            }
            const active = [
              ...(yield* Ref.get(sessions)).values(),
              ...Array.from(releasing.values(), (release) => release.entry),
            ].filter((entry) => entry.runtime.instanceId === instanceId);
            const outcomes = yield* Effect.forEach(
              active.map((entry) => ({
                providerSessionId: entry.runtime.providerSessionId,
                expectedRuntime: entry.runtime,
              })),
              (target) =>
                releaseEntry({
                  providerSessionId: target.providerSessionId,
                  reason: "manual_shutdown",
                  detail: `Provider instance ${instanceId} logged out.`,
                  expectedRuntime: target.expectedRuntime,
                }).pipe(Effect.exit),
              { concurrency: "unbounded" },
            );
            // In-flight startups for this instance own provider resources
            // without a live entry; they were marked above — join their
            // bounded unwind as part of closing the instance. Join the
            // captured record's settled deferred directly: re-resolving by
            // session id could claim a different instance's same-id
            // replacement that registered after this record was removed.
            const startupOutcomes = yield* Effect.forEach(
              starting,
              (record) =>
                Deferred.await(record.settled).pipe(
                  Effect.timeoutOption(RELEASE_SCOPE_CLOSE_TIMEOUT_MS),
                  Effect.flatMap((settled) =>
                    Option.isNone(settled)
                      ? Effect.fail(
                          new ProviderSessionReleaseError({
                            providerSessionId: record.providerSessionId,
                            reason: "manual_shutdown",
                            cause:
                              "Provider session startup cleanup did not finish within 30 seconds. " +
                              "Replacement sessions are blocked until cleanup completes.",
                          }),
                        )
                      : Effect.void,
                  ),
                  Effect.exit,
                ),
              { concurrency: "unbounded" },
            );
            // Tracked credential sweeps outlive their detach callers; the
            // ones owned by this instance's sessions (or unattributed, where
            // the owning entry was already gone) still run under teardown.
            // Only unfinished records count, and each matching record is
            // joined on its own completion — not the tail's: a chained
            // successor may still be sweeping for another instance after
            // this instance's own sweep finishes. A completed predecessor's
            // caller is done and must not be kept waiting on a successor it
            // does not own. In-flight detaches are drained first: one still
            // inside its lock can register a tail after a single snapshot.
            const revocationOutcomes = yield* joinTrackedRevocations(
              (record) => record.instanceId === undefined || record.instanceId === instanceId,
              (threadId, done) =>
                Deferred.await(done).pipe(
                  Effect.timeoutOption(RELEASE_SCOPE_CLOSE_TIMEOUT_MS),
                  Effect.flatMap((settled) =>
                    Option.isNone(settled)
                      ? Effect.fail(
                          new ProviderSessionReleaseError({
                            providerSessionId: ProviderSessionId.make(
                              `provider-session:thread:${threadId}`,
                            ),
                            reason: "manual_shutdown",
                            cause:
                              "MCP credential revocation did not finish within 30 seconds and is still running.",
                          }),
                        )
                      : Effect.void,
                  ),
                ),
              (marker) =>
                Deferred.await(marker.detached).pipe(
                  Effect.timeoutOption(RELEASE_SCOPE_CLOSE_TIMEOUT_MS),
                  Effect.flatMap((settled) =>
                    Option.isNone(settled)
                      ? Effect.fail(
                          new ProviderSessionReleaseError({
                            providerSessionId: marker.providerSessionId,
                            reason: "manual_shutdown",
                            cause:
                              "An in-flight detach did not finish within 30 seconds and is still running.",
                          }),
                        )
                      : Effect.void,
                  ),
                ),
              // Drain only detaches whose sweep could match `owned` above: a
              // detach on a session provably owned by another instance cannot
              // register a tail this close must join, and waiting on one would
              // only stretch logout behind an unrelated stuck detach. The
              // marker's captured owner wins over a map re-resolution — the
              // session id may already name a same-id replacement.
              (marker, live) => {
                const key = sessionKey(marker.providerSessionId);
                const ownerInstance = marker.ownershipResolved
                  ? marker.instanceId
                  : (live.get(key)?.runtime.instanceId ??
                    releasing.get(key)?.entry.runtime.instanceId ??
                    opening.get(key)?.instanceId);
                return ownerInstance === undefined || ownerInstance === instanceId;
              },
            );
            const failure = [...outcomes, ...startupOutcomes, ...revocationOutcomes].find(
              Exit.isFailure,
            );
            if (failure !== undefined && Exit.isFailure(failure)) {
              return yield* Effect.failCause(failure.cause);
            }
          }).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                const remaining = (closingInstanceCounts.get(instanceId) ?? 1) - 1;
                if (remaining <= 0) {
                  closingInstanceCounts.delete(instanceId);
                } else {
                  closingInstanceCounts.set(instanceId, remaining);
                }
              }),
            ),
            Effect.mapError(
              (cause) =>
                new ProviderSessionCloseError({
                  providerSessionId: ProviderSessionId.make(
                    `provider-session:provider-instance:${instanceId}`,
                  ),
                  cause,
                }),
            ),
          ),
        release: releaseEntry,
        detach: (input) =>
          Effect.uninterruptibleMask((restore) =>
            Effect.suspend(() => {
              // Registered inside the mask before the body can suspend, and
              // removed on any exit below: teardown drains this set before
              // snapshotting pendingRevocations, so a detach already in
              // flight cannot register a credential sweep the join misses.
              const inflight: InflightDetach = {
                providerSessionId: input.providerSessionId,
                threadId: input.threadId,
                detached: Deferred.makeUnsafe<void, never>(),
                ownershipResolved: false,
                instanceId: undefined,
                revokeDone: undefined,
              };
              inflightDetaches.add(inflight);
              return restore(
                Effect.gen(function* () {
                  const key = sessionKey(input.providerSessionId);
                  const pendingRelease = releasing.get(key);
                  if (pendingRelease !== undefined) {
                    inflight.instanceId = pendingRelease.entry.runtime.instanceId;
                    inflight.ownershipResolved = true;
                    let revokeDone:
                      | Deferred.Deferred<void, ProviderSessionReleaseError>
                      | undefined;
                    if (input.revokeMcpCredential === true) {
                      const recorded = pendingRelease.mcpCredentialIdByThread.get(input.threadId);
                      // The claim-aware revocation can wait on a peer's stalled
                      // prepare; run it detached so this retry reaches the bounded
                      // join instead of blocking indefinitely first. The pending
                      // release's own sweep is the primary revocation path for a
                      // credential it still records — but a credential an earlier
                      // detach already pruned is absent from its record, so this
                      // tracked sweep is the only owner for that work.
                      revokeDone = yield* forkTrackedRevocation(
                        input.providerSessionId,
                        input.threadId,
                        revokeUnclaimedThreadCredentials(
                          input.threadId,
                          recorded === undefined ? [] : [recorded],
                        ),
                        pendingRelease.entry.runtime.instanceId,
                        (done) => {
                          inflight.revokeDone = done;
                        },
                      );
                    }
                    yield* releaseEntry({
                      providerSessionId: input.providerSessionId,
                      reason: "manual_shutdown",
                      joinRelease: pendingRelease,
                    });
                    // The release's sweep does not cover a credential pruned before
                    // its record was captured — joining only the release would
                    // report success while that revocation is still running.
                    if (revokeDone !== undefined) {
                      const settled = yield* Deferred.await(revokeDone).pipe(
                        Effect.timeoutOption(RELEASE_SCOPE_CLOSE_TIMEOUT_MS),
                      );
                      if (Option.isNone(settled)) {
                        return yield* new ProviderSessionReleaseError({
                          providerSessionId: input.providerSessionId,
                          reason: "runtime_error",
                          cause:
                            "MCP credential revocation did not finish within 30 seconds and is still running.",
                        });
                      }
                    }
                    return;
                  }
                  const currentEntry = (yield* Ref.get(sessions)).get(key);
                  inflight.instanceId =
                    currentEntry?.runtime.instanceId ?? opening.get(key)?.instanceId;
                  inflight.ownershipResolved = true;
                  const openingRecord = currentEntry === undefined ? opening.get(key) : undefined;
                  if (openingRecord !== undefined && openingRecord.threadId === input.threadId) {
                    // Detaching the thread an in-flight startup belongs to aborts
                    // it: mark the open like a close and join its bounded unwind
                    // instead of returning success while a provider process may
                    // still be spawning for this thread.
                    return yield* releaseEntry({
                      providerSessionId: input.providerSessionId,
                      reason: "manual_shutdown",
                    });
                  }
                  if (currentEntry?.supportsMultipleProviderThreads === true) {
                    const projection = yield* Effect.option(
                      projectionStore.getThreadProjection(input.threadId),
                    );
                    if (Option.isSome(projection)) {
                      const providerThreads = new Map(
                        projection.value.providerThreads
                          .filter((thread) => thread.providerSessionId === input.providerSessionId)
                          .map((thread) => [thread.id, thread] as const),
                      );
                      const activeTurns = projection.value.providerTurns.filter(
                        (turn) =>
                          turn.status === "running" && providerThreads.has(turn.providerThreadId),
                      );
                      yield* Effect.forEach(
                        activeTurns,
                        (turn) =>
                          currentEntry.exposedRuntime
                            .interruptTurn({
                              providerThread: providerThreads.get(turn.providerThreadId)!,
                              providerTurnId: turn.id,
                            })
                            .pipe(
                              Effect.catchCause((cause) =>
                                Effect.logWarning(
                                  "orchestration-v2.driver-session.detach-interrupt-failed",
                                  {
                                    providerSessionId: input.providerSessionId,
                                    threadId: input.threadId,
                                    providerTurnId: turn.id,
                                    cause,
                                  },
                                ),
                              ),
                            ),
                        { concurrency: 1, discard: true },
                      );
                    }
                  }
                  // The attachment mutation and credential cleanup run under the same
                  // [session, thread] lock an attach holds through its provisional
                  // bookkeeping, MCP preparation, and event write. Without it a detach
                  // can land between an in-flight attach's provisional add and its
                  // post-prepare completion: the attach would then record a credential
                  // and emit its attached event for a thread the entry no longer
                  // tracks, resurrecting a detached binding.
                  // The acquisition itself is bounded: an attach can hold this
                  // lock through MCP preparation, and a stalled holder must not
                  // keep a cleanup caller waiting past the bound. Timing out here
                  // leaves ownership with the lock holder — nothing this detach
                  // could have claimed is touched.
                  const locked = yield* threadAttach
                    .withLock(
                      threadAttachKey(
                        input.providerSessionId,
                        currentEntry?.runtime,
                        input.threadId,
                      ),
                      // Masked so the attachment mutation and the release handoff
                      // stay atomic with respect to interruption: once the last
                      // exclusive attachment is removed, the release must exist
                      // before this fiber can be interrupted out of the revocation
                      // wait below.
                      Effect.uninterruptibleMask((restore) =>
                        Effect.gen(function* () {
                          const detached = yield* Ref.modify(sessions, (current) => {
                            const entry = current.get(key);
                            if (
                              entry === undefined ||
                              currentEntry === undefined ||
                              // The entry read above may belong to a released session: a
                              // same-id reopen installs a new runtime, and this detach must
                              // never mutate the replacement's attachments.
                              entry.runtime !== currentEntry.runtime ||
                              !entry.attachedThreadIds.has(input.threadId)
                            ) {
                              return [
                                Option.none<{
                                  readonly entry: LiveSessionEntry;
                                  readonly priorMcpCredentialId: string | undefined;
                                  readonly release: PendingSessionRelease | undefined;
                                }>(),
                                current,
                              ] as const;
                            }
                            const attachedThreadIds = new Set(entry.attachedThreadIds);
                            attachedThreadIds.delete(input.threadId);
                            const loadedProviderThreadKeyByThread = new Map(
                              entry.loadedProviderThreadKeyByThread,
                            );
                            loadedProviderThreadKeyByThread.delete(input.threadId);
                            // For a plain (workspace-change) detach, the credential id stays
                            // recorded: the thread may re-attach and reuse it, and
                            // releaseEntry revokes it when the provider process finally goes
                            // away. A terminal detach (archive/delete) prunes the record so
                            // nothing vetoes the revocation below.
                            const mcpCredentialIdByThread =
                              input.revokeMcpCredential === true
                                ? (() => {
                                    const pruned = new Map(entry.mcpCredentialIdByThread);
                                    pruned.delete(input.threadId);
                                    return pruned;
                                  })()
                                : entry.mcpCredentialIdByThread;
                            const updatedEntry = {
                              ...entry,
                              attachedThreadIds,
                              loadedProviderThreadKeyByThread,
                              mcpCredentialIdByThread,
                            };
                            // An exclusive session whose last attachment just
                            // detached must move into `releasing` in this same
                            // atomic step: a close landing between the mutation and
                            // a later claim would otherwise register the emptied
                            // entry — a release record with no thread or credential
                            // ownership — and the thread-scoped cleanup gate would
                            // let this thread's replacement open while the provider
                            // process still runs. The record keeps the detached
                            // thread and its pruned credential so the release's own
                            // bounded sweep and its joiners cover them.
                            const release: PendingSessionRelease | undefined =
                              attachedThreadIds.size === 0 && !entry.supportsMultipleProviderThreads
                                ? {
                                    entry: {
                                      ...updatedEntry,
                                      attachedThreadIds: new Set([input.threadId]),
                                    },
                                    threadIds: new Set([
                                      input.threadId,
                                      ...entry.mcpCredentialIdByThread.keys(),
                                    ]),
                                    mcpCredentialIdByThread: new Map(entry.mcpCredentialIdByThread),
                                    done: Deferred.makeUnsafe<void, ProviderSessionReleaseError>(),
                                  }
                                : undefined;
                            const updated = new Map(current);
                            if (release === undefined) {
                              updated.set(key, updatedEntry);
                            } else {
                              releasing.set(key, release);
                              updated.delete(key);
                            }
                            return [
                              Option.some({
                                entry: updatedEntry,
                                priorMcpCredentialId: entry.mcpCredentialIdByThread.get(
                                  input.threadId,
                                ),
                                release,
                              }),
                              updated,
                            ] as const;
                          });
                          // Forked while masked so the handoff cannot be skipped by
                          // an interruption delivered during the revocation wait
                          // below, and joined by the caller after the lock is
                          // released. The record was already claimed atomically
                          // above, so this only starts the cleanup worker.
                          const releaseFiber =
                            Option.isSome(detached) && detached.value.release !== undefined
                              ? yield* releaseEntry({
                                  providerSessionId: input.providerSessionId,
                                  reason: "manual_shutdown",
                                  preclaimed: detached.value.release,
                                  ...(input.detail === undefined ? {} : { detail: input.detail }),
                                }).pipe(Effect.forkDetach({ startImmediately: true }))
                              : undefined;
                          // Plain detaches deliberately do not revoke: a detached thread's
                          // provider process may still be alive (shared multi-thread codex
                          // session across a workspace handoff) and holds its MCP client's
                          // credential for the thread it will re-attach with. Credentials
                          // are revoked when the session entry is released (process gone)
                          // or rotated on the next attach if they stopped resolving.
                          // Terminal detaches (thread archived or deleted) revoke the
                          // thread's credentials — claim-aware: a credential a live peer
                          // session still records survives until that holder's own cleanup
                          // revokes it, and a credential the releasing session still records
                          // is handled by that pending cleanup.
                          if (input.revokeMcpCredential === true) {
                            // Read the recorded credential only from a pending release
                            // that belongs to the session this detach targeted; a
                            // pending record for a same-id replacement owns a different
                            // credential map.
                            const pendingNow = releasing.get(key);
                            const sameInstancePending =
                              pendingNow !== undefined &&
                              currentEntry !== undefined &&
                              pendingNow.entry.runtime === currentEntry.runtime
                                ? pendingNow
                                : undefined;
                            const priorMcpCredentialId = Option.isSome(detached)
                              ? detached.value.priorMcpCredentialId
                              : sameInstancePending?.mcpCredentialIdByThread.get(input.threadId);
                            const revoke = revokeUnclaimedThreadCredentials(
                              input.threadId,
                              priorMcpCredentialId === undefined ? [] : [priorMcpCredentialId],
                            );
                            // Forked detached and tracked so interrupting this detach
                            // cannot strand the pruned credential: the sweep keeps the
                            // captured id and finishes under mcpPrepareLock even after
                            // this fiber is gone, and a retry joins `revokeDone`
                            // instead of forking a second sweep or reporting success
                            // over a running one. The fork stays masked — a pending
                            // interruption delivered by restore() below must not skip
                            // it — while the join stays interruptible so a completed
                            // detach still waits for revocation.
                            const revokeDone = yield* forkTrackedRevocation(
                              input.providerSessionId,
                              input.threadId,
                              revoke,
                              Option.isSome(detached)
                                ? detached.value.entry.runtime.instanceId
                                : (sameInstancePending?.entry.runtime.instanceId ??
                                    currentEntry?.runtime.instanceId),
                              (done) => {
                                inflight.revokeDone = done;
                              },
                            );
                            if (Option.isSome(detached) && releaseFiber === undefined) {
                              // No release owns this credential's sweep (the session
                              // stays live for other threads), so this join is the
                              // only wait on revocation — and the sweep acquires
                              // mcpPrepareLock, which a stalled peer prepare can hold
                              // indefinitely. Bound the wait like any cleanup: the
                              // detached sweep still finishes the revocation late,
                              // and the timeout keeps the reported state honest
                              // instead of blocking past the cleanup contract.
                              const settled = yield* restore(
                                Deferred.await(revokeDone).pipe(
                                  Effect.timeoutOption(RELEASE_SCOPE_CLOSE_TIMEOUT_MS),
                                ),
                              );
                              if (Option.isNone(settled)) {
                                return yield* new ProviderSessionReleaseError({
                                  providerSessionId: input.providerSessionId,
                                  reason: "runtime_error",
                                  cause:
                                    "MCP credential revocation did not finish within 30 seconds and is still running.",
                                });
                              }
                            }
                            // When a release was forked above, the pruned credential
                            // was handed to its record via extraMcpCredentials and its
                            // own bounded sweep revokes it — the bounded release join
                            // below is this detach's wait, so joining the tracked
                            // sweep too would only re-expose the unbounded
                            // mcpPrepareLock wait. When nothing detached, the post-
                            // lock tail joins `revokeDone` so a retry never reports
                            // success over a running revocation.
                            return { detached, releaseFiber, revokeDone };
                          }
                          return { detached, releaseFiber, revokeDone: undefined };
                        }),
                      ),
                    )
                    .pipe(Effect.timeoutOption(RELEASE_SCOPE_CLOSE_TIMEOUT_MS));
                  if (Option.isNone(locked)) {
                    return yield* new ProviderSessionReleaseError({
                      providerSessionId: input.providerSessionId,
                      reason: "runtime_error",
                      cause:
                        "An in-flight attachment or cleanup held this session's lock for over " +
                        "30 seconds; the detach could not run and ownership stays with the holder.",
                    });
                  }
                  const { detached, releaseFiber, revokeDone } = locked.value;
                  if (Option.isNone(detached)) {
                    // A close may have moved the entry into `releasing` while this
                    // detach was reading the projection or interrupting turns; join
                    // that cleanup like any retry instead of reporting success over
                    // still-pending work. The join is pinned to the ownership this
                    // detach observed at read time: a pending record for a same-id
                    // replacement is a different session and must not be joined.
                    // When no entry was seen at all, the pending-release check at
                    // the top already passed, so anything releasing now belongs to
                    // another instance.
                    if (currentEntry !== undefined && releasing.has(key)) {
                      yield* releaseEntry({
                        providerSessionId: input.providerSessionId,
                        reason: "manual_shutdown",
                        joinOnly: true,
                        expectedRuntime: currentEntry.runtime,
                      });
                    }
                    // An earlier terminal detach for this thread may have started
                    // a revocation this call must not outrun: the caller that
                    // forked it may already have timed out or been interrupted.
                    // Join the tracked sweep (bounded like any cleanup wait) so a
                    // retry only reports success once revocation actually finished.
                    // The release record above does not cover a credential pruned
                    // before it was captured, so this join runs whether or not a
                    // release was pending.
                    if (revokeDone !== undefined) {
                      const settled = yield* Deferred.await(revokeDone).pipe(
                        Effect.timeoutOption(RELEASE_SCOPE_CLOSE_TIMEOUT_MS),
                      );
                      if (Option.isNone(settled)) {
                        return yield* new ProviderSessionReleaseError({
                          providerSessionId: input.providerSessionId,
                          reason: "runtime_error",
                          cause:
                            "MCP credential revocation did not finish within 30 seconds and is still running.",
                        });
                      }
                    }
                    return;
                  }
                  if (releaseFiber !== undefined) {
                    // Forked inside the lock before the revocation wait so an
                    // interrupted detach cannot strand the session; the join keeps
                    // a completed detach waiting on the release outcome.
                    yield* Fiber.join(releaseFiber);
                    return;
                  }
                  yield* scheduleIdleRelease(input.providerSessionId, detached.value.entry.runtime);
                }).pipe(
                  Effect.catchCause((cause) =>
                    Effect.fail(
                      new ProviderSessionReleaseError({
                        providerSessionId: input.providerSessionId,
                        reason: "manual_shutdown",
                        cause,
                      }),
                    ),
                  ),
                ),
              ).pipe(
                Effect.onExit(() =>
                  Effect.andThen(
                    Deferred.done(inflight.detached, Exit.void),
                    Effect.sync(() => {
                      inflightDetaches.delete(inflight);
                    }),
                  ),
                ),
              );
            }),
          ),
      } satisfies ProviderSessionManagerV2Shape);
    }),
  );

export const layer = layerWithOptions();
