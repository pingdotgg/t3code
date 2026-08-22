import {
  ModelSelection,
  OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  OrchestrationV2ProviderSession,
  OrchestrationV2RuntimeRequest,
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
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as McpProviderSession from "../mcp/McpProviderSession.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import { EventSinkV2 } from "./EventSink.ts";
import { IdAllocatorV2 } from "./IdAllocator.ts";
import { makeKeyedSerialExecutor } from "./KeyedSerialExecutor.ts";
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
import { ProjectionStoreThreadNotFoundError, ProjectionStoreV2 } from "./ProjectionStore.ts";
import { randomUuidV4 } from "./RandomUuid.ts";

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;
const DEFAULT_MAX_IDLE_PIN_MS = 4 * 60 * 60 * 1000;
const RELEASE_SCOPE_CLOSE_TIMEOUT_MS = 30 * 1000;
const RUNTIME_OPERATION_DRAIN_TIMEOUT_MS = 30 * 1000;
const isProjectionStoreThreadNotFoundError = Schema.is(ProjectionStoreThreadNotFoundError);

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
export class ProviderSessionOpenError extends Schema.TaggedErrorClass<ProviderSessionOpenError>()(
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

export class ProviderSessionLookupError extends Schema.TaggedErrorClass<ProviderSessionLookupError>()(
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

export class ProviderSessionCloseError extends Schema.TaggedErrorClass<ProviderSessionCloseError>()(
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

export class ProviderSessionReleaseError extends Schema.TaggedErrorClass<ProviderSessionReleaseError>()(
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

export class ProviderSessionActivityError extends Schema.TaggedErrorClass<ProviderSessionActivityError>()(
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
  }) => Effect.Effect<ProviderAdapterV2SessionRuntime, ProviderSessionManagerV2Error>;
  readonly get: (
    providerSessionId: ProviderSessionId,
  ) => Effect.Effect<Option.Option<ProviderAdapterV2SessionRuntime>, ProviderSessionManagerV2Error>;
  readonly listAttached: (
    threadId: ThreadId,
  ) => Effect.Effect<ReadonlyArray<OrchestrationV2ProviderSession>>;
  readonly close: (
    providerSessionId: ProviderSessionId,
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
    /** Archive generation that must still be current before mutating a live runtime. */
    readonly expectedArchivedAt?: string;
    /**
     * True for terminal detaches (thread archived or deleted): the thread's
     * MCP credentials are revoked immediately instead of surviving for a
     * potential re-attach.
     */
    readonly revokeMcpCredential?: boolean;
    /**
     * True only when the application thread is permanently deleted. Adapters
     * with native thread deletion remove it before the runtime is detached.
     */
    readonly deleteProviderThread?: boolean;
    /**
     * Persisted deletion targets used when the managed runtime has already
     * stopped by the time the replay-safe detach effect executes.
     */
    readonly providerInstanceId?: ProviderInstanceId;
    readonly providerSession?: OrchestrationV2ProviderSession;
    readonly providerThreads?: ReadonlyArray<OrchestrationV2ProviderThread>;
    /** Persisted effects require an incarnation token before touching a live entry. */
    readonly requireExpectedRuntime?: boolean;
  }) => Effect.Effect<void, ProviderSessionManagerV2Error>;
}

export class ProviderSessionManagerV2 extends Context.Service<
  ProviderSessionManagerV2,
  ProviderSessionManagerV2Shape
>()("t3/orchestration-v2/ProviderSessionManager/ProviderSessionManagerV2") {}

interface LiveSessionEntry {
  readonly attachedThreadIds: ReadonlySet<ThreadId>;
  readonly loadedProviderThreadKeyByThread: ReadonlyMap<ThreadId, string>;
  /** Latest native thread materialized by an admitted manager operation. */
  readonly loadedProviderThreadByThread: ReadonlyMap<ThreadId, OrchestrationV2ProviderThread>;
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
  /** Running turns observed directly from the adapter event pump. */
  readonly activeProviderTurns: Ref.Ref<
    ReadonlyMap<OrchestrationV2ProviderTurn["id"], OrchestrationV2ProviderTurn>
  >;
  /** Start calls do not complete until the event pump observes their running turn. */
  readonly startTurnObservations: Ref.Ref<ReadonlyMap<string, Deferred.Deferred<void>>>;
  /** Busy start attempts, bound to their provider turn after the pump observes it. */
  readonly busyStartAttempts: Ref.Ref<
    ReadonlyMap<string, OrchestrationV2ProviderTurn["id"] | null>
  >;
  readonly scope: Scope.Closeable;
  readonly idleGeneration: number;
  readonly busyCount: number;
  readonly lastActivityAtMs: number;
  readonly idleFiber: Fiber.Fiber<void, never> | null;
  /** Set when idle release is deferred for pending background work; bounds total deferral. */
  readonly pinnedSinceMs: number | null;
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
  /** Test hook that runs after session commit and before pump startup. */
  readonly afterEntryCommit?: Effect.Effect<void>;
  /** Test hook that runs while reusing a live session before idle cancellation. */
  readonly beforeReuseActivity?: Effect.Effect<void>;
  /** Override for deterministic scope-close timeout tests. */
  readonly releaseScopeCloseTimeoutMs?: number;
  /** Override for deterministic runtime-operation drain timeout tests. */
  readonly runtimeOperationDrainTimeoutMs?: number;
  /** Test hook that runs after the raw pump observes a provider turn. */
  readonly afterProviderTurnObservation?: (
    providerTurn: OrchestrationV2ProviderTurn,
  ) => Effect.Effect<void>;
  /** Test hook that parks a stale archive detach before its guarded restoration. */
  readonly beforeStaleArchiveRestore?: Effect.Effect<void>;
  /** Test hook that runs after a runtime operation is admitted but before it starts. */
  readonly afterRuntimeOperationAdmission?: (
    runtime: ProviderAdapterV2SessionRuntime,
  ) => Effect.Effect<void>;
  /** Test hook that parks operation completion before its idle generation is rearmed. */
  readonly beforeRuntimeOperationIdleRearm?: Effect.Effect<void>;
  /** Test hook that parks an idle schedule after its generation is reserved. */
  readonly afterIdleScheduleReservation?: (input: {
    readonly providerSessionId: ProviderSessionId;
    readonly generation: number;
  }) => Effect.Effect<void>;
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
  | IdAllocatorV2
  | McpSessionRegistry.McpSessionRegistry
  | ProjectionStoreV2
  | ProviderAdapterRegistryV2
> =>
  Layer.effect(
    ProviderSessionManagerV2,
    Effect.gen(function* () {
      const registry = yield* ProviderAdapterRegistryV2;
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
      const agentBrowserAccessEnabled = Option.match(serverSettings, {
        onNone: () => Effect.succeed(true),
        onSome: (settings) =>
          settings.getSettings.pipe(
            Effect.map((resolved) => resolved.enableAgentBrowserAccess),
            Effect.catch((cause) =>
              Effect.logWarning(
                "Could not read server settings; withholding agent browser access for this session.",
                { cause },
              ).pipe(Effect.as(false)),
            ),
          ),
      });
      const eventSink = yield* EventSinkV2;
      const idAllocator = yield* IdAllocatorV2;
      const projectionStore = yield* ProjectionStoreV2;
      const layerScope = yield* Effect.scope;
      const sessions = yield* Ref.make(new Map<string, LiveSessionEntry>());
      const nextSubscriberId = yield* Ref.make(0);
      const sessionLifecycle = yield* makeKeyedSerialExecutor<ProviderSessionId>();
      const sessionOpen = yield* makeKeyedSerialExecutor<ProviderSessionId>();
      const withSessionMutationLocks = <A, E, R>(
        providerSessionId: ProviderSessionId,
        effect: Effect.Effect<A, E, R>,
      ) =>
        sessionOpen.withLock(
          providerSessionId,
          sessionLifecycle.withLock(providerSessionId, effect),
        );
      interface SessionOperationGate {
        readonly phase: "open" | "draining" | "closing";
        readonly active: number;
        readonly drained?: Deferred.Deferred<void>;
      }
      const sessionOperationGates = yield* Ref.make(
        new Map<ProviderAdapterV2SessionRuntime, SessionOperationGate>(),
      );
      const idleTimeoutMs = Math.max(1, options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS);
      const maxIdlePinMs = Math.max(0, options.maxIdlePinMs ?? DEFAULT_MAX_IDLE_PIN_MS);
      const releaseScopeCloseTimeoutMs = Math.max(
        0,
        options.releaseScopeCloseTimeoutMs ?? RELEASE_SCOPE_CLOSE_TIMEOUT_MS,
      );
      const runtimeOperationDrainTimeoutMs = Math.max(
        0,
        options.runtimeOperationDrainTimeoutMs ?? RUNTIME_OPERATION_DRAIN_TIMEOUT_MS,
      );
      const loadThreadProjectionIfPresent = (
        threadId: ThreadId,
        providerSessionId: ProviderSessionId,
      ) =>
        projectionStore.getThreadProjection(threadId).pipe(
          Effect.map(Option.some),
          Effect.catch((cause) =>
            isProjectionStoreThreadNotFoundError(cause)
              ? Effect.succeed(Option.none())
              : Effect.fail(new ProviderSessionLookupError({ providerSessionId, cause })),
          ),
        );
      interface PreparedMcpCredential {
        readonly mcpCredentialId: string | undefined;
        /** True when this call minted the credential (vs reusing a live one). */
        readonly issued: boolean;
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
        `${threadId} ${mcpCredentialId}`;
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
      const isMcpCredentialHeldElsewhere = (
        threadId: ThreadId,
        mcpCredentialId: string,
        excludedEntry?: LiveSessionEntry,
      ) =>
        Effect.gen(function* () {
          if (isMcpCredentialReserved(threadId, mcpCredentialId)) return true;
          const current = yield* Ref.get(sessions);
          return Array.from(current.values()).some(
            (entry) =>
              entry.runtime !== excludedEntry?.runtime &&
              entry.mcpCredentialIdByThread.get(threadId) === mcpCredentialId,
          );
        });
      const mcpPrepareLock = yield* makeKeyedSerialExecutor<ThreadId>();
      /**
       * Resolves (or mints) the thread's MCP credential and returns it with a
       * reservation held; the caller must drop the reservation exactly once.
       * Serialized per thread so two concurrent prepares cannot interleave
       * their rotate steps and revoke each other's freshly minted credential.
       */
      const prepareMcpSession = (
        threadId: ThreadId,
        providerInstanceId: ProviderInstanceId,
      ): Effect.Effect<PreparedMcpCredential> =>
        options.configureMcp === false
          ? Effect.sync((): PreparedMcpCredential => {
              McpProviderSession.clearMcpProviderSession(threadId);
              return { mcpCredentialId: undefined, issued: false };
            })
          : mcpPrepareLock.withLock(
              threadId,
              Effect.gen(function* () {
                // Tracks the reservation held by this in-flight prepare so an
                // error or interrupt cannot strand it (or a freshly issued
                // credential) before the caller takes ownership. Idempotent:
                // the first run clears the tracked reservation.
                let reserved:
                  | {
                      readonly credentialId: string;
                    }
                  | undefined;
                const abandon = Effect.uninterruptible(
                  Effect.gen(function* () {
                    const current = reserved;
                    if (current === undefined) return;
                    reserved = undefined;
                    dropMcpCredentialReservation(threadId, current.credentialId);
                    if (!(yield* isMcpCredentialHeldElsewhere(threadId, current.credentialId))) {
                      yield* clearMcpSession(threadId, current.credentialId).pipe(
                        Effect.catchCause((cause) =>
                          Effect.logWarning(
                            "orchestration-v2.provider-session.prepare-cleanup-revoke-failed",
                            {
                              threadId,
                              cause,
                            },
                          ),
                        ),
                      );
                    }
                  }),
                );
                return yield* Effect.gen(function* () {
                  // Reuse a still-valid credential for this thread instead of
                  // rotating: long-lived provider processes (codex app-server)
                  // build their MCP client once per conversation and keep using
                  // the credential it started with, so a thread that detaches and
                  // re-attaches across a workspace handoff must come back to the
                  // same token or the process's tool calls fail auth.
                  const browserToolsAvailable = yield* agentBrowserAccessEnabled;
                  const existing = McpProviderSession.readMcpProviderSession(threadId);
                  if (existing !== undefined) {
                    // Reserve before the async resolve so a release cannot
                    // revoke the credential between validation and reservation.
                    reserveMcpCredential(threadId, existing.providerSessionId);
                    reserved = { credentialId: existing.providerSessionId };
                    const rawToken = existing.authorizationHeader.replace(/^Bearer\s+/, "");
                    const resolved = yield* mcpSessionRegistry.resolve(rawToken);
                    if (
                      resolved !== undefined &&
                      resolved.threadId === threadId &&
                      resolved.providerInstanceId === providerInstanceId &&
                      // A flipped browser-access setting must not survive through
                      // credential reuse: rotate so the new scope reflects it.
                      resolved.capabilities.has("preview") === browserToolsAvailable
                    ) {
                      // Hand the reservation to the caller; it owns the drop.
                      reserved = undefined;
                      return { mcpCredentialId: existing.providerSessionId, issued: false };
                    }
                    yield* abandon;
                  }
                  yield* mcpSessionRegistry.revokeThread(threadId);
                  const credential = yield* mcpSessionRegistry.issue({
                    threadId,
                    providerInstanceId,
                    browserToolsAvailable,
                  });
                  McpProviderSession.setMcpProviderSession(credential.config);
                  reserveMcpCredential(threadId, credential.config.providerSessionId);
                  reserved = { credentialId: credential.config.providerSessionId };
                  // Hand the reservation to the caller; it owns the drop.
                  reserved = undefined;
                  return { mcpCredentialId: credential.config.providerSessionId, issued: true };
                }).pipe(Effect.onExit((exit) => (Exit.isFailure(exit) ? abandon : Effect.void)));
              }),
            );
      /**
       * With a credential id, revocation is scoped to that credential and the
       * config slot is cleared only while it still holds it; a replacement
       * session's newer credential survives. Without one (attach failed before
       * a credential was recorded), fall back to thread-wide revocation.
       */
      const clearMcpSession = (threadId: ThreadId, mcpCredentialId?: string) =>
        mcpCredentialId === undefined
          ? mcpSessionRegistry
              .revokeThread(threadId)
              .pipe(
                Effect.tap(() =>
                  Effect.sync(() => McpProviderSession.clearMcpProviderSession(threadId)),
                ),
              )
          : mcpSessionRegistry.revokeProviderSession(mcpCredentialId).pipe(
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
      const clearMcpSessionIfUnheld = (
        threadId: ThreadId,
        mcpCredentialId: string,
        excludedEntry?: LiveSessionEntry,
      ) =>
        mcpPrepareLock.withLock(
          threadId,
          isMcpCredentialHeldElsewhere(threadId, mcpCredentialId, excludedEntry).pipe(
            Effect.flatMap((heldElsewhere) =>
              heldElsewhere ? Effect.void : clearMcpSession(threadId, mcpCredentialId),
            ),
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
                (item) => item.type === "approval_request" && item.requestId === request.id,
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

      interface ReleaseEntryInput {
        readonly providerSessionId: ProviderSessionId;
        readonly reason: ProviderSessionReleaseReason;
        readonly detail?: string;
        readonly cancelIdleFiber?: boolean;
        readonly onlyIfIdleGeneration?: number;
        /** When set, release only if the map still holds this exact runtime. */
        readonly onlyIfRuntime?: ProviderAdapterV2SessionRuntime;
      }
      interface ReleaseEntryState {
        entry: Option.Option<LiveSessionEntry>;
      }
      const acquireReleasedEntry = (input: ReleaseEntryInput, releaseState: ReleaseEntryState) =>
        sessionLifecycle.withLock(
          input.providerSessionId,
          Effect.uninterruptible(
            Effect.gen(function* () {
              const operationGates = yield* Ref.get(sessionOperationGates);
              const entry = yield* Ref.modify(sessions, (current) => {
                const key = sessionKey(input.providerSessionId);
                const existing = current.get(key);
                if (existing === undefined) {
                  return [Option.none<LiveSessionEntry>(), current] as const;
                }
                if (
                  input.onlyIfIdleGeneration !== undefined &&
                  (existing.busyCount > 0 ||
                    existing.idleGeneration !== input.onlyIfIdleGeneration ||
                    (operationGates.get(existing.runtime)?.active ?? 0) > 0)
                ) {
                  return [Option.none<LiveSessionEntry>(), current] as const;
                }
                if (input.onlyIfRuntime !== undefined && existing.runtime !== input.onlyIfRuntime) {
                  return [Option.none<LiveSessionEntry>(), current] as const;
                }
                const updated = new Map(current);
                updated.delete(key);
                return [Option.some(existing), updated] as const;
              });
              releaseState.entry = entry;
              if (Option.isNone(entry)) return;
              if (input.reason === "server_shutdown") {
                yield* closeSubscribers(entry.value);
              } else {
                yield* failSubscribers(
                  entry.value,
                  input.detail ?? `Provider session released: ${input.reason}.`,
                );
              }
              yield* writeReleasedSessionEvents({
                entry: entry.value,
                reason: input.reason,
                ...(input.detail === undefined ? {} : { detail: input.detail }),
              });
              yield* writeReleasedRuntimeRequestEvents({
                entry: entry.value,
                reason: input.reason,
              });
            }),
          ),
        );
      const finalizeReleasedEntry = (input: ReleaseEntryInput, entry: LiveSessionEntry) =>
        Effect.gen(function* () {
          if (input.cancelIdleFiber !== false) {
            yield* cancelIdleFiber(entry.idleFiber);
          }
          // Released state is persisted under sessionLifecycle before
          // a replacement can commit. Close the old runtime afterward
          // so a wedged finalizer neither blocks replacement nor
          // clobbers its projection later.
          const closeFiber = yield* Scope.close(entry.scope, Exit.void).pipe(
            Effect.exit,
            Effect.forkDetach({ startImmediately: true }),
          );
          const closeExit = yield* Fiber.join(closeFiber).pipe(
            Effect.timeoutOption(releaseScopeCloseTimeoutMs),
          );
          if (Option.isNone(closeExit)) {
            yield* Effect.logWarning("orchestration-v2.provider-session-scope-close-timeout", {
              providerSessionId: input.providerSessionId,
              reason: input.reason,
              timeoutMs: releaseScopeCloseTimeoutMs,
            });
            yield* Fiber.join(closeFiber).pipe(
              Effect.flatMap((exit) =>
                Exit.isFailure(exit)
                  ? Effect.logWarning("orchestration-v2.provider-session-scope-close-failed", {
                      providerSessionId: input.providerSessionId,
                      reason: input.reason,
                      cause: exit.cause,
                    })
                  : Effect.logInfo("orchestration-v2.provider-session-scope-close-completed-late", {
                      providerSessionId: input.providerSessionId,
                      reason: input.reason,
                    }),
              ),
              Effect.forkDetach,
            );
          }
          // Revoke every credential this session recorded, including for
          // threads that detached without re-attaching: the provider
          // process is gone, so nothing holds them anymore. Skip threads
          // a live replacement session took over, since credential reuse
          // means the replacement may hold this very credential.
          yield* Effect.forEach(
            entry.mcpCredentialIdByThread,
            ([threadId, mcpCredentialId]) =>
              clearMcpSessionIfUnheld(threadId, mcpCredentialId, entry),
            { discard: true },
          );
          if (Option.isSome(closeExit) && Exit.isFailure(closeExit.value)) {
            return yield* Effect.failCause(closeExit.value.cause);
          }
        });
      const releaseEntry = (input: ReleaseEntryInput) =>
        Effect.acquireUseRelease(
          Effect.sync((): ReleaseEntryState => ({ entry: Option.none() })),
          (releaseState) => acquireReleasedEntry(input, releaseState),
          ({ entry }) =>
            Option.match(entry, {
              onNone: () => Effect.void,
              onSome: (entry) => finalizeReleasedEntry(input, entry),
            }),
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.fail(
              new ProviderSessionReleaseError({
                providerSessionId: input.providerSessionId,
                reason: input.reason,
                cause,
              }),
            ),
          ),
        );

      // Annotated to break the releaseIfStillIdle <-> scheduleIdleReleaseInternal
      // inference cycle introduced by the pin re-arm below.
      const releaseIfStillIdle = (input: {
        readonly providerSessionId: ProviderSessionId;
        readonly generation: number;
      }): Effect.Effect<void> =>
        Effect.gen(function* () {
          const current = yield* Ref.get(sessions);
          const key = sessionKey(input.providerSessionId);
          const entry = current.get(key);
          if (
            entry === undefined ||
            entry.busyCount > 0 ||
            entry.idleGeneration !== input.generation
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
        Effect.uninterruptible(
          Effect.gen(function* () {
            const key = sessionKey(providerSessionId);
            const lastActivityAtMs = yield* Clock.currentTimeMillis;
            const reservation = yield* Ref.modify(sessions, (current) => {
              const entry = current.get(key);
              if (
                entry === undefined ||
                entry.busyCount > 0 ||
                (expectedRuntime !== undefined && entry.runtime !== expectedRuntime)
              ) {
                return [undefined, current] as const;
              }
              const generation = entry.idleGeneration + 1;
              const updated = new Map(current);
              updated.set(key, {
                ...entry,
                idleGeneration: generation,
                idleFiber: null,
                lastActivityAtMs,
              });
              return [
                {
                  generation,
                  previousIdleFiber: entry.idleFiber,
                  runtime: entry.runtime,
                },
                updated,
              ] as const;
            });
            if (reservation === undefined) {
              return;
            }

            yield* cancelIdleFiber(reservation.previousIdleFiber);
            if (options.afterIdleScheduleReservation !== undefined) {
              yield* options.afterIdleScheduleReservation({
                providerSessionId,
                generation: reservation.generation,
              });
            }
            const idleFiber = yield* Effect.sleep(Duration.millis(idleTimeoutMs)).pipe(
              Effect.andThen(
                releaseIfStillIdle({
                  providerSessionId,
                  generation: reservation.generation,
                }),
              ),
              Effect.forkIn(layerScope),
            );
            const installed = yield* Ref.modify(sessions, (latest) => {
              const latestEntry = latest.get(key);
              if (
                latestEntry === undefined ||
                latestEntry.busyCount > 0 ||
                latestEntry.runtime !== reservation.runtime ||
                latestEntry.idleGeneration !== reservation.generation
              ) {
                return [false, latest] as const;
              }
              const updated = new Map(latest);
              updated.set(key, { ...latestEntry, idleFiber });
              return [true, updated] as const;
            });
            if (!installed) {
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
            yield* Ref.update(sessions, (current) => {
              const entry = current.get(sessionKey(providerSessionId));
              if (
                entry === undefined ||
                (expectedRuntime !== undefined && entry.runtime !== expectedRuntime)
              ) {
                return current;
              }
              const updated = new Map(current);
              updated.set(sessionKey(providerSessionId), {
                ...entry,
                lastActivityAtMs,
              });
              return updated;
            });
            yield* scheduleIdleReleaseInternal(providerSessionId, expectedRuntime);
          }),
        );

      const attachThread = (input: {
        readonly providerSessionId: ProviderSessionId;
        readonly threadId: ThreadId;
        readonly runtime: ProviderAdapterV2SessionRuntime;
      }) =>
        withActivityError(
          input.providerSessionId,
          Ref.modify(sessions, (current) => {
            const entry = current.get(sessionKey(input.providerSessionId));
            if (
              entry === undefined ||
              entry.runtime !== input.runtime ||
              entry.attachedThreadIds.has(input.threadId)
            ) {
              return [false, current] as const;
            }
            const updated = new Map(current);
            updated.set(sessionKey(input.providerSessionId), {
              ...entry,
              attachedThreadIds: new Set([...entry.attachedThreadIds, input.threadId]),
            });
            return [true, updated] as const;
          }),
        );

      const removeThreadAttachment = (input: {
        readonly providerSessionId: ProviderSessionId;
        readonly threadId: ThreadId;
        readonly runtime: ProviderAdapterV2SessionRuntime;
      }) =>
        Ref.modify(sessions, (current) => {
          const key = sessionKey(input.providerSessionId);
          const entry = current.get(key);
          if (
            entry === undefined ||
            entry.runtime !== input.runtime ||
            !entry.attachedThreadIds.has(input.threadId)
          ) {
            return [Option.none<LiveSessionEntry>(), current] as const;
          }
          const attachedThreadIds = new Set(entry.attachedThreadIds);
          attachedThreadIds.delete(input.threadId);
          const loadedProviderThreadKeyByThread = new Map(entry.loadedProviderThreadKeyByThread);
          loadedProviderThreadKeyByThread.delete(input.threadId);
          const loadedProviderThreadByThread = new Map(entry.loadedProviderThreadByThread);
          loadedProviderThreadByThread.delete(input.threadId);
          const updated = new Map(current);
          const updatedEntry = {
            ...entry,
            attachedThreadIds,
            loadedProviderThreadKeyByThread,
            loadedProviderThreadByThread,
          };
          updated.set(key, updatedEntry);
          return [Option.some(updatedEntry), updated] as const;
        });

      const isProviderThreadLoaded = (input: {
        readonly providerSessionId: ProviderSessionId;
        readonly threadId: ThreadId;
        readonly providerThreadKey: string;
        readonly runtime: ProviderAdapterV2SessionRuntime;
      }) =>
        Ref.get(sessions).pipe(
          Effect.map((current) => {
            const entry = current.get(sessionKey(input.providerSessionId));
            return (
              entry?.runtime === input.runtime &&
              entry.loadedProviderThreadKeyByThread.get(input.threadId) === input.providerThreadKey
            );
          }),
        );

      const markProviderThreadLoaded = (input: {
        readonly providerSessionId: ProviderSessionId;
        readonly threadId: ThreadId;
        readonly providerThreadKey: string;
        readonly providerThread: OrchestrationV2ProviderThread;
        readonly runtime: ProviderAdapterV2SessionRuntime;
      }) =>
        Ref.update(sessions, (current) => {
          const key = sessionKey(input.providerSessionId);
          const entry = current.get(key);
          if (entry === undefined || entry.runtime !== input.runtime) {
            return current;
          }
          const loadedProviderThreadKeyByThread = new Map(entry.loadedProviderThreadKeyByThread);
          loadedProviderThreadKeyByThread.set(input.threadId, input.providerThreadKey);
          const loadedProviderThreadByThread = new Map(entry.loadedProviderThreadByThread);
          loadedProviderThreadByThread.set(input.threadId, input.providerThread);
          const updated = new Map(current);
          updated.set(key, {
            ...entry,
            loadedProviderThreadKeyByThread,
            loadedProviderThreadByThread,
          });
          return updated;
        });

      const ensureThreadAttached = (input: {
        readonly providerSessionId: ProviderSessionId;
        readonly threadId: ThreadId;
        readonly providerInstanceId: ProviderInstanceId;
        readonly runtime: ProviderAdapterV2SessionRuntime;
        readonly sessionMutationLocksHeld?: boolean;
      }) =>
        Effect.suspend(() => {
          let preparedForCleanup: PreparedMcpCredential | undefined;
          let reservationDropped = false;
          const dropReservation = () => {
            if (!reservationDropped && preparedForCleanup?.mcpCredentialId !== undefined) {
              reservationDropped = true;
              dropMcpCredentialReservation(input.threadId, preparedForCleanup.mcpCredentialId);
            }
          };
          return Effect.gen(function* () {
            const attached = yield* attachThread(input);
            if (attached) {
              const prepared = yield* prepareMcpSession(input.threadId, input.providerInstanceId);
              preparedForCleanup = prepared;
              if (prepared.mcpCredentialId !== undefined) {
                const mcpCredentialId = prepared.mcpCredentialId;
                const recorded = yield* Ref.modify(sessions, (current) => {
                  const key = sessionKey(input.providerSessionId);
                  const entry = current.get(key);
                  if (entry === undefined || entry.runtime !== input.runtime) {
                    return [false, current] as const;
                  }
                  const mcpCredentialIdByThread = new Map(entry.mcpCredentialIdByThread);
                  mcpCredentialIdByThread.set(input.threadId, mcpCredentialId);
                  const updated = new Map(current);
                  updated.set(key, { ...entry, mcpCredentialIdByThread });
                  return [true, updated] as const;
                });
                if (!recorded) {
                  return yield* new ProviderSessionActivityError({
                    providerSessionId: input.providerSessionId,
                    cause: "Provider session is no longer active.",
                  });
                }
              }
              const persistAttachment = Effect.gen(function* () {
                const entry = (yield* Ref.get(sessions)).get(sessionKey(input.providerSessionId));
                if (entry?.runtime !== input.runtime) return;
                yield* writeProviderSessionEvents({
                  runtime: entry.runtime,
                  threadIds: [input.threadId],
                  type: "provider-session.attached",
                  payload: entry.runtime.providerSession,
                });
              });
              yield* withActivityError(
                input.providerSessionId,
                input.sessionMutationLocksHeld === true
                  ? persistAttachment
                  : withSessionMutationLocks(input.providerSessionId, persistAttachment),
              );
            }
          }).pipe(
            Effect.tapError(() =>
              removeThreadAttachment(input).pipe(
                // Revoke only a credential this attach freshly minted: a REUSED
                // credential is by definition held by another live provider
                // process, and revoking it thread-wide would break that
                // process's MCP client mid-conversation. Still drop the
                // reservation so a failed attach cannot pin the token forever.
                Effect.flatMap((removedFromEntry) =>
                  mcpPrepareLock.withLock(
                    input.threadId,
                    Effect.suspend(() => {
                      const credentialId = preparedForCleanup?.mcpCredentialId;
                      dropReservation();
                      if (preparedForCleanup?.issued !== true || credentialId === undefined) {
                        return Effect.void;
                      }
                      return isMcpCredentialHeldElsewhere(
                        input.threadId,
                        credentialId,
                        Option.getOrUndefined(removedFromEntry),
                      ).pipe(
                        Effect.flatMap((heldElsewhere) =>
                          heldElsewhere
                            ? Effect.void
                            : clearMcpSession(input.threadId, credentialId),
                        ),
                      );
                    }),
                  ),
                ),
              ),
            ),
            // The entry's own record (written above while the thread is
            // attached) guards the credential from here on; the reservation
            // is only needed until then. Ensuring covers defects/interrupts.
            Effect.ensuring(Effect.sync(dropReservation)),
          );
        });

      const markBusy = (
        providerSessionId: ProviderSessionId,
        expectedRuntime: ProviderAdapterV2SessionRuntime,
      ) =>
        withActivityError(
          providerSessionId,
          Effect.gen(function* () {
            const key = sessionKey(providerSessionId);
            const now = yield* Clock.currentTimeMillis;
            const idleFiber = yield* Ref.modify(sessions, (current) => {
              const entry = current.get(key);
              if (entry === undefined || entry.runtime !== expectedRuntime) {
                return [null, current] as const;
              }
              const updated = new Map(current);
              updated.set(key, {
                ...entry,
                busyCount: entry.busyCount + 1,
                idleFiber: null,
                lastActivityAtMs: now,
                pinnedSinceMs: null,
              });
              return [entry.idleFiber, updated] as const;
            });
            yield* cancelIdleFiber(idleFiber);
          }),
        );

      const markIdle = (
        providerSessionId: ProviderSessionId,
        expectedRuntime: ProviderAdapterV2SessionRuntime,
      ) =>
        withActivityError(
          providerSessionId,
          Effect.gen(function* () {
            const key = sessionKey(providerSessionId);
            const now = yield* Clock.currentTimeMillis;
            const updatedEntry = yield* Ref.modify(sessions, (current) => {
              const entry = current.get(key);
              if (entry === undefined || entry.runtime !== expectedRuntime) {
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
            if (updatedEntry) {
              yield* scheduleIdleReleaseInternal(providerSessionId, expectedRuntime);
            }
          }),
        );

      const releaseBusyStartAttempt = (
        busyStartAttempts: LiveSessionEntry["busyStartAttempts"],
        matches: (
          attemptKey: string,
          providerTurnId: OrchestrationV2ProviderTurn["id"] | null,
        ) => boolean,
      ) =>
        Ref.modify(busyStartAttempts, (current) => {
          const match = [...current].find(([attemptKey, providerTurnId]) =>
            matches(attemptKey, providerTurnId),
          );
          if (match === undefined) return [false, current] as const;
          const updated = new Map(current);
          updated.delete(match[0]);
          return [true, updated] as const;
        });

      const observeActivity = (
        providerSessionId: ProviderSessionId,
        activity: Effect.Effect<void, ProviderSessionActivityError>,
      ) =>
        activity.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("orchestration-v2.driver-session.activity-failed", {
              providerSessionId,
              cause,
            }),
          ),
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

      const beginRuntimeOperation = (
        runtime: ProviderAdapterV2SessionRuntime,
        allowDuringDrain = false,
      ) =>
        sessionLifecycle.withLock(
          runtime.providerSessionId,
          Ref.modify(sessionOperationGates, (current) => {
            const existing = current.get(runtime);
            const canBegin =
              existing === undefined ||
              existing.phase === "open" ||
              (allowDuringDrain && existing.phase === "draining");
            if (!canBegin) return [false, current] as const;
            const updated = new Map(current);
            updated.set(runtime, {
              phase: existing?.phase ?? "open",
              active: (existing?.active ?? 0) + 1,
              ...(existing?.drained === undefined ? {} : { drained: existing.drained }),
            });
            return [true, updated] as const;
          }),
        );

      const endRuntimeOperation = (runtime: ProviderAdapterV2SessionRuntime) =>
        sessionLifecycle
          .withLock(
            runtime.providerSessionId,
            Ref.modify(sessionOperationGates, (current) => {
              const existing = current.get(runtime);
              if (existing === undefined) {
                return [{ drained: undefined, scheduleIdle: false }, current] as const;
              }
              const active = Math.max(0, existing.active - 1);
              const updated = new Map(current);
              if (active === 0 && existing.phase === "open") {
                updated.delete(runtime);
              } else {
                updated.set(runtime, { ...existing, active });
              }
              return [
                {
                  drained: active === 0 ? existing.drained : undefined,
                  scheduleIdle: active === 0 && existing.phase === "open",
                },
                updated,
              ] as const;
            }).pipe(
              Effect.flatMap(({ drained, scheduleIdle }) =>
                Effect.all(
                  [
                    ...(drained === undefined ? [] : [Deferred.succeed(drained, undefined)]),
                    ...(scheduleIdle
                      ? [
                          (options.beforeRuntimeOperationIdleRearm ?? Effect.void).pipe(
                            Effect.andThen(
                              scheduleIdleReleaseInternal(runtime.providerSessionId, runtime),
                            ),
                          ),
                        ]
                      : []),
                  ],
                  { discard: true },
                ),
              ),
            ),
          )
          .pipe(Effect.asVoid);

      const markRuntimeDraining = (runtime: ProviderAdapterV2SessionRuntime) =>
        Ref.update(sessionOperationGates, (current) => {
          const existing = current.get(runtime);
          const updated = new Map(current);
          updated.set(runtime, {
            phase: "draining",
            active: existing?.active ?? 0,
          });
          return updated;
        });

      const closeAndDrainRuntimeOperations = (runtime: ProviderAdapterV2SessionRuntime) =>
        Effect.gen(function* () {
          const drained = yield* Deferred.make<void>();
          const active = yield* Ref.modify(sessionOperationGates, (current) => {
            const existing = current.get(runtime);
            const updated = new Map(current);
            const active = existing?.active ?? 0;
            updated.set(runtime, { phase: "closing", active, drained });
            return [active, updated] as const;
          });
          if (active === 0) return true;
          return Option.isSome(
            yield* Deferred.await(drained).pipe(
              Effect.timeoutOption(runtimeOperationDrainTimeoutMs),
            ),
          );
        });

      const finishRuntimeDrain = (runtime: ProviderAdapterV2SessionRuntime) =>
        Ref.update(sessionOperationGates, (current) => {
          if (!current.has(runtime)) return current;
          const updated = new Map(current);
          updated.delete(runtime);
          return updated;
        });

      const decorateRuntime = (
        runtime: ProviderAdapterV2SessionRuntime,
        eventSubscribers: Ref.Ref<
          ReadonlyMap<number, Queue.Queue<ProviderSessionEventSignal, Cause.Done>>
        >,
        startTurnObservations: Ref.Ref<ReadonlyMap<string, Deferred.Deferred<void>>>,
        busyStartAttempts: LiveSessionEntry["busyStartAttempts"],
      ): ProviderAdapterV2SessionRuntime => {
        const providerSessionId = runtime.providerSessionId;
        const subscribeEvents = makeEventSubscription(eventSubscribers);
        const ensureThreadAttachment = (threadId: ThreadId) =>
          ensureThreadAttached({
            providerSessionId,
            threadId,
            providerInstanceId: runtime.instanceId,
            runtime,
          }).pipe(
            Effect.mapError(
              () =>
                new ProviderAdapterProtocolError({
                  driver: runtime.driver,
                  detail: `Provider session ${providerSessionId} could not attach its application thread`,
                }),
            ),
          );
        const ensureRuntimeStillActive = <A>(value: A) =>
          Ref.get(sessions).pipe(
            Effect.flatMap((current) =>
              current.get(sessionKey(providerSessionId))?.runtime === runtime
                ? Effect.succeed(value)
                : Effect.fail(
                    new ProviderAdapterProtocolError({
                      driver: runtime.driver,
                      detail: `Provider session ${providerSessionId} is no longer active`,
                    }),
                  ),
            ),
          );
        const runOperation = <A>(
          effect: Effect.Effect<A, ProviderAdapterV2Error>,
          allowDuringDrain = false,
        ) =>
          Effect.acquireUseRelease(
            beginRuntimeOperation(runtime, allowDuringDrain),
            (acquired) =>
              acquired
                ? Ref.get(sessions).pipe(
                    Effect.flatMap((current) =>
                      current.get(sessionKey(providerSessionId))?.runtime === runtime
                        ? (options.afterRuntimeOperationAdmission?.(runtime) ?? Effect.void).pipe(
                            Effect.andThen(effect),
                            Effect.flatMap(ensureRuntimeStillActive),
                          )
                        : Effect.fail(
                            new ProviderAdapterProtocolError({
                              driver: runtime.driver,
                              detail: `Provider session ${providerSessionId} is no longer active`,
                            }),
                          ),
                    ),
                  )
                : Effect.fail(
                    new ProviderAdapterProtocolError({
                      driver: runtime.driver,
                      detail: `Provider session ${providerSessionId} is detaching`,
                    }),
                  ),
            (acquired) => (acquired ? endRuntimeOperation(runtime) : Effect.void),
          );
        return {
          ...runtime,
          subscribeEvents,
          events: Stream.unwrap(
            subscribeEvents.pipe(Effect.map((subscription) => subscription.events)),
          ),
          ensureThread: (input) =>
            runOperation(
              ensureThreadAttachment(input.threadId).pipe(
                Effect.andThen(runtime.ensureThread(input)),
                Effect.tap((providerThread) =>
                  markProviderThreadLoaded({
                    providerSessionId,
                    threadId: input.threadId,
                    providerThreadKey: providerThreadLoadKey({
                      providerThread,
                      modelSelection: input.modelSelection,
                      runtimePolicy: input.runtimePolicy,
                    }),
                    providerThread,
                    runtime,
                  }),
                ),
              ),
            ),
          resumeThread: (input) => {
            const threadId = input.threadId ?? input.providerThread.appThreadId;
            if (threadId === null || threadId === undefined) {
              return runOperation(runtime.resumeThread(input));
            }
            const providerThreadKey = providerThreadLoadKey({
              providerThread: input.providerThread,
              ...(input.modelSelection === undefined
                ? {}
                : { modelSelection: input.modelSelection }),
              ...(input.runtimePolicy === undefined ? {} : { runtimePolicy: input.runtimePolicy }),
            });
            return runOperation(
              ensureThreadAttachment(threadId).pipe(
                Effect.andThen(
                  isProviderThreadLoaded({
                    providerSessionId,
                    threadId,
                    providerThreadKey,
                    runtime,
                  }),
                ),
                Effect.flatMap((loaded) =>
                  loaded && input.providerThread.status !== "error"
                    ? Effect.succeed(input.providerThread)
                    : runtime.resumeThread(input),
                ),
                Effect.tap((providerThread) =>
                  markProviderThreadLoaded({
                    providerSessionId,
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
                    providerThread,
                    runtime,
                  }),
                ),
              ),
            );
          },
          forkThread: (input) =>
            runOperation(
              ensureThreadAttachment(input.targetThreadId).pipe(
                Effect.andThen(runtime.forkThread(input)),
                Effect.tap((providerThread) =>
                  markProviderThreadLoaded({
                    providerSessionId,
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
                    providerThread,
                    runtime,
                  }),
                ),
              ),
            ),
          startTurn: (input) =>
            runOperation(
              Effect.gen(function* () {
                const observed = yield* Deferred.make<void>();
                const attemptKey = String(input.attemptId);
                yield* Ref.update(startTurnObservations, (current) => {
                  const updated = new Map(current);
                  updated.set(attemptKey, observed);
                  return updated;
                });
                return yield* ensureThreadAttachment(input.threadId).pipe(
                  Effect.andThen(
                    Ref.update(busyStartAttempts, (current) => {
                      const updated = new Map(current);
                      updated.set(attemptKey, null);
                      return updated;
                    }),
                  ),
                  Effect.andThen(
                    observeActivity(providerSessionId, markBusy(providerSessionId, runtime)),
                  ),
                  Effect.andThen(
                    runtime.startTurn(input).pipe(
                      Effect.onExit((exit) =>
                        Exit.isSuccess(exit)
                          ? Effect.void
                          : releaseBusyStartAttempt(
                              busyStartAttempts,
                              (candidateAttemptKey, providerTurnId) =>
                                candidateAttemptKey === attemptKey && providerTurnId === null,
                            ).pipe(
                              Effect.flatMap((released) =>
                                released
                                  ? releaseEntry({
                                      providerSessionId,
                                      reason: "runtime_error",
                                      detail: `Provider session ${providerSessionId} start exited before observing turn ${input.attemptId}`,
                                      onlyIfRuntime: runtime,
                                    }).pipe(
                                      Effect.catchCause((cause) =>
                                        Effect.logWarning(
                                          "orchestration-v2.provider-session-start-exit-release-failed",
                                          {
                                            providerSessionId,
                                            attemptId: input.attemptId,
                                            cause,
                                          },
                                        ),
                                      ),
                                    )
                                  : Effect.void,
                              ),
                            ),
                      ),
                    ),
                  ),
                  Effect.andThen(
                    Deferred.await(observed).pipe(
                      Effect.timeoutOption(runtimeOperationDrainTimeoutMs),
                      Effect.flatMap((completed) =>
                        Option.isSome(completed)
                          ? Effect.void
                          : releaseEntry({
                              providerSessionId,
                              reason: "runtime_error",
                              detail: `Provider session ${providerSessionId} did not observe started turn ${input.attemptId}`,
                              onlyIfRuntime: runtime,
                            }).pipe(
                              Effect.catchCause((cause) =>
                                Effect.logWarning(
                                  "orchestration-v2.provider-session-start-observation-release-failed",
                                  {
                                    providerSessionId,
                                    attemptId: input.attemptId,
                                    cause,
                                  },
                                ),
                              ),
                              Effect.andThen(
                                Effect.fail(
                                  new ProviderAdapterProtocolError({
                                    driver: runtime.driver,
                                    detail: `Provider session ${providerSessionId} did not observe started turn ${input.attemptId}`,
                                  }),
                                ),
                              ),
                            ),
                      ),
                    ),
                  ),
                  Effect.ensuring(
                    Ref.update(startTurnObservations, (current) => {
                      if (current.get(attemptKey) !== observed) return current;
                      const updated = new Map(current);
                      updated.delete(attemptKey);
                      return updated;
                    }),
                  ),
                );
              }),
            ),
          steerTurn: (input) =>
            runOperation(
              observeActivity(providerSessionId, touchActivity(providerSessionId, runtime)).pipe(
                Effect.andThen(runtime.steerTurn(input)),
              ),
            ),
          interruptTurn: (input) =>
            runOperation(
              observeActivity(providerSessionId, touchActivity(providerSessionId, runtime)).pipe(
                Effect.andThen(runtime.interruptTurn(input)),
              ),
              true,
            ),
          respondToRuntimeRequest: (input) =>
            runOperation(
              observeActivity(providerSessionId, touchActivity(providerSessionId, runtime)).pipe(
                Effect.andThen(runtime.respondToRuntimeRequest(input)),
              ),
            ),
          readThreadSnapshot: (input) => runOperation(runtime.readThreadSnapshot(input)),
          rollbackThread: (input) => runOperation(runtime.rollbackThread(input)),
          ...(runtime.deleteThread === undefined
            ? {}
            : {
                deleteThread: (providerThread) =>
                  runOperation(runtime.deleteThread!(providerThread)),
              }),
        };
      };

      const persistProviderSessionUpdate = (
        entry: LiveSessionEntry,
        event: Extract<ProviderAdapterV2Event, { readonly type: "provider_session.updated" }>,
      ) =>
        withSessionMutationLocks(
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
              payload: {
                ...event.providerSession,
                incarnationId: entry.runtime.providerSession.incarnationId,
              },
            });
          }),
        ).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("orchestration-v2.driver-session.status-persist-failed", {
              providerSessionId: entry.runtime.providerSessionId,
              cause,
            }),
          ),
        );

      const observeProviderTurnEvent = (entry: LiveSessionEntry, event: ProviderAdapterV2Event) =>
        Effect.gen(function* () {
          if (event.type === "provider_turn.updated") {
            const providerTurn = event.providerTurn;
            if (providerTurn.status !== "pending" && providerTurn.runAttemptId !== null) {
              const attemptKey = String(providerTurn.runAttemptId);
              yield* Ref.update(entry.busyStartAttempts, (current) => {
                if (!current.has(attemptKey)) return current;
                const updated = new Map(current);
                updated.set(attemptKey, providerTurn.id);
                return updated;
              });
            }
            yield* Ref.update(entry.activeProviderTurns, (current) => {
              const updated = new Map(current);
              if (providerTurn.status === "running") {
                updated.set(providerTurn.id, providerTurn);
              } else {
                updated.delete(providerTurn.id);
              }
              return updated;
            });
            if (options.afterProviderTurnObservation !== undefined) {
              yield* options.afterProviderTurnObservation(providerTurn);
            }
            if (providerTurn.status !== "pending" && providerTurn.runAttemptId !== null) {
              const attemptKey = String(providerTurn.runAttemptId);
              const observation = yield* Ref.modify(entry.startTurnObservations, (current) => {
                const existing = current.get(attemptKey);
                if (existing === undefined) return [undefined, current] as const;
                const updated = new Map(current);
                updated.delete(attemptKey);
                return [existing, updated] as const;
              });
              if (observation !== undefined) {
                yield* Deferred.succeed(observation, undefined);
              }
            }
            return;
          }
          if (event.type === "turn.terminal") {
            yield* Ref.update(entry.activeProviderTurns, (current) => {
              if (!current.has(event.providerTurnId)) return current;
              const updated = new Map(current);
              updated.delete(event.providerTurnId);
              return updated;
            });
            const released = yield* releaseBusyStartAttempt(
              entry.busyStartAttempts,
              (_attemptKey, providerTurnId) => providerTurnId === event.providerTurnId,
            );
            if (!released) return;
            yield* observeActivity(
              entry.runtime.providerSessionId,
              markIdle(entry.runtime.providerSessionId, entry.runtime),
            );
          }
        });

      const startEventPump = (entry: LiveSessionEntry) =>
        Effect.gen(function* () {
          const processingQueue = yield* Queue.unbounded<ProviderAdapterV2Event, Cause.Done>();
          const processingFiber = yield* Stream.fromQueue(processingQueue).pipe(
            Stream.runForEach((event) =>
              (event.type === "provider_session.updated"
                ? persistProviderSessionUpdate(entry, event)
                : Effect.void
              ).pipe(
                Effect.andThen(
                  publishToSubscribers(entry.eventSubscribers, { type: "event", event }),
                ),
              ),
            ),
            Effect.forkIn(layerScope),
          );
          const exit = yield* entry.runtime.events.pipe(
            Stream.runForEach((event) =>
              observeProviderTurnEvent(entry, event).pipe(
                Effect.andThen(
                  observeActivity(
                    entry.runtime.providerSessionId,
                    event.type === "turn.terminal"
                      ? Effect.void
                      : touchActivity(entry.runtime.providerSessionId, entry.runtime),
                  ),
                ),
                Effect.andThen(Queue.offer(processingQueue, event)),
              ),
            ),
            Effect.exit,
          );
          yield* Queue.end(processingQueue);
          yield* Fiber.await(processingFiber);
          yield* Effect.gen(function* () {
            const current = (yield* Ref.get(sessions)).get(
              sessionKey(entry.runtime.providerSessionId),
            );
            if (current?.runtime !== entry.runtime) {
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
            }).pipe(Effect.ignore);
          });
        }).pipe(Effect.forkIn(layerScope));

      const shutdown = Effect.gen(function* () {
        const activeSessions = [...(yield* Ref.get(sessions)).values()];
        yield* Effect.forEach(
          activeSessions,
          (entry) =>
            releaseEntry({
              providerSessionId: entry.runtime.providerSessionId,
              reason: "server_shutdown",
            }).pipe(
              Effect.catchCause((cause) =>
                Effect.logWarning("orchestration-v2.driver-session.shutdown-release-failed", {
                  providerSessionId: entry.runtime.providerSessionId,
                  cause,
                }),
              ),
            ),
          { discard: true },
        );
      });
      yield* Effect.addFinalizer(() => shutdown);

      return ProviderSessionManagerV2.of({
        shutdown,
        open: (input) =>
          sessionOpen.withLock(
            input.providerSessionId,
            Effect.gen(function* () {
              const key = sessionKey(input.providerSessionId);
              const existingRuntime = yield* sessionLifecycle.withLock(
                input.providerSessionId,
                Effect.gen(function* () {
                  const existing = (yield* Ref.get(sessions)).get(key);
                  if (existing === undefined) {
                    return Option.none<ProviderAdapterV2SessionRuntime>();
                  }
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
                  yield* ensureThreadAttached({
                    providerSessionId: input.providerSessionId,
                    threadId: input.threadId,
                    providerInstanceId: existing.runtime.instanceId,
                    runtime: existing.runtime,
                    sessionMutationLocksHeld: true,
                  });
                  if (options.beforeReuseActivity !== undefined) {
                    yield* options.beforeReuseActivity;
                  }
                  yield* touchActivity(input.providerSessionId, existing.runtime);
                  return Option.some(existing.exposedRuntime);
                }),
              );
              if (Option.isSome(existingRuntime)) return existingRuntime.value;

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
              // Pre-commit open state. prepareMcpSession and openSession can
              // suspend, so an interrupt (or failure) can land anywhere in
              // this window; cleanupOpen owns every resource until the entry
              // commit below hands them off to releaseEntry.
              let sessionScope: Scope.Closeable | null = null;
              let prepared: PreparedMcpCredential | undefined;
              let reservationDropped = false;
              let committed = false;
              const dropReservation = Effect.sync(() => {
                const credentialId = prepared?.mcpCredentialId;
                if (!reservationDropped && credentialId !== undefined) {
                  reservationDropped = true;
                  dropMcpCredentialReservation(input.threadId, credentialId);
                }
              });
              // Cleanup for an open that failed or was interrupted before its
              // entry was committed: closes the independently-created session
              // scope (a provider process spawned mid-openSession must not
              // leak), drops the credential reservation, and revokes the
              // credential when no other entry or open holds it. Idempotent
              // (the reservation drop is flag-guarded;
              // Scope.close and credential revocation are safe to repeat) and
              // uninterruptible, so a racing interrupt cannot strand the scope
              // or the token. Once the entry is committed, releaseEntry owns
              // both and cleanup must not touch them.
              const cleanupOpen = Effect.uninterruptible(
                Effect.gen(function* () {
                  if (committed) return;
                  const scope = sessionScope;
                  if (scope !== null) {
                    const closeFiber = yield* Scope.close(scope, Exit.void).pipe(
                      Effect.exit,
                      Effect.forkDetach({ startImmediately: true }),
                    );
                    const closeExit = yield* Effect.raceFirst(
                      Fiber.join(closeFiber).pipe(Effect.map(Option.some)),
                      Effect.sleep(`${releaseScopeCloseTimeoutMs} millis`).pipe(
                        Effect.as(Option.none()),
                      ),
                    );
                    if (Option.isNone(closeExit)) {
                      yield* Effect.logWarning(
                        "orchestration-v2.provider-session-open-scope-close-timeout",
                        {
                          providerSessionId: input.providerSessionId,
                          timeoutMs: releaseScopeCloseTimeoutMs,
                        },
                      );
                    }
                  }
                  yield* mcpPrepareLock.withLock(
                    input.threadId,
                    Effect.gen(function* () {
                      yield* dropReservation;
                      const credentialId = prepared?.mcpCredentialId;
                      if (
                        credentialId !== undefined &&
                        !(yield* isMcpCredentialHeldElsewhere(input.threadId, credentialId))
                      ) {
                        yield* clearMcpSession(input.threadId, credentialId).pipe(
                          Effect.catchCause((cause) =>
                            Effect.logWarning(
                              "orchestration-v2.provider-session.open-cleanup-revoke-failed",
                              {
                                providerSessionId: input.providerSessionId,
                                cause,
                              },
                            ),
                          ),
                        );
                      }
                    }),
                  );
                }),
              );
              const entry = yield* Effect.gen(function* () {
                prepared = yield* prepareMcpSession(
                  input.threadId,
                  input.modelSelection.instanceId,
                );
                const mcpCredentialId = prepared.mcpCredentialId;
                sessionScope = yield* Scope.make();
                const adapterRuntime = yield* adapter
                  .openSession({
                    threadId: input.threadId,
                    providerSessionId: input.providerSessionId,
                    modelSelection: input.modelSelection,
                    runtimePolicy: input.runtimePolicy,
                    ...(input.resumeFromSession === undefined
                      ? {}
                      : { resumeFromSession: input.resumeFromSession }),
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
                const incarnationId = yield* randomUuidV4;
                const runtime: ProviderAdapterV2SessionRuntime = {
                  ...adapterRuntime,
                  providerSession: {
                    ...adapterRuntime.providerSession,
                    incarnationId,
                  },
                };
                const eventSubscribers = yield* Ref.make<
                  ReadonlyMap<number, Queue.Queue<ProviderSessionEventSignal, Cause.Done>>
                >(new Map());
                const activeProviderTurns = yield* Ref.make<
                  ReadonlyMap<OrchestrationV2ProviderTurn["id"], OrchestrationV2ProviderTurn>
                >(new Map());
                const startTurnObservations = yield* Ref.make<
                  ReadonlyMap<string, Deferred.Deferred<void>>
                >(new Map());
                const busyStartAttempts = yield* Ref.make<
                  ReadonlyMap<string, OrchestrationV2ProviderTurn["id"] | null>
                >(new Map());
                const exposedRuntime = decorateRuntime(
                  runtime,
                  eventSubscribers,
                  startTurnObservations,
                  busyStartAttempts,
                );
                const now = yield* Clock.currentTimeMillis;
                const openedEntry: LiveSessionEntry = {
                  attachedThreadIds: new Set([input.threadId]),
                  loadedProviderThreadKeyByThread: new Map(),
                  loadedProviderThreadByThread: new Map(),
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
                  activeProviderTurns,
                  startTurnObservations,
                  busyStartAttempts,
                  scope: sessionScope,
                  idleGeneration: 0,
                  busyCount: 0,
                  lastActivityAtMs: now,
                  idleFiber: null,
                  pinnedSinceMs: null,
                };
                return openedEntry;
              }).pipe(Effect.onExit((exit) => (Exit.isFailure(exit) ? cleanupOpen : Effect.void)));
              const releaseAfterCommit = releaseEntry({
                providerSessionId: input.providerSessionId,
                reason: "runtime_error",
                detail: "Provider session setup was interrupted after commit.",
              }).pipe(Effect.ignore);
              // Commit, drop the reservation, and mark the entry committed
              // as one uninterruptible handoff. Serialize the attached event
              // with release events so an old runtime cannot update projection
              // state after a replacement commits under the same id.
              yield* sessionLifecycle
                .withLock(
                  input.providerSessionId,
                  Effect.gen(function* () {
                    yield* Effect.uninterruptible(
                      Effect.gen(function* () {
                        yield* Ref.update(sessions, (current) => {
                          const updated = new Map(current);
                          updated.set(key, entry);
                          return updated;
                        });
                        yield* dropReservation;
                        committed = true;
                      }),
                    );
                    yield* withActivityError(
                      input.providerSessionId,
                      writeProviderSessionEvents({
                        runtime: entry.runtime,
                        threadIds: [input.threadId],
                        type: "provider-session.attached",
                        payload: entry.runtime.providerSession,
                      }),
                    );
                  }),
                )
                .pipe(
                  Effect.tapError(() => releaseAfterCommit),
                  Effect.onInterrupt(() => releaseAfterCommit),
                );
              return yield* Effect.gen(function* () {
                if (options.afterEntryCommit !== undefined) {
                  yield* options.afterEntryCommit;
                }
                yield* startEventPump(entry);
                yield* scheduleIdleRelease(input.providerSessionId, entry.runtime);
                return entry.exposedRuntime;
              }).pipe(
                Effect.tapError(() => releaseAfterCommit),
                Effect.onInterrupt(() => releaseAfterCommit),
              );
            }),
          ),
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
        listAttached: (threadId) =>
          Ref.get(sessions).pipe(
            Effect.map((current) =>
              [...current.values()].flatMap((entry) =>
                entry.attachedThreadIds.has(threadId) ? [entry.runtime.providerSession] : [],
              ),
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
        release: releaseEntry,
        detach: (input) => {
          let drainingRuntime: ProviderAdapterV2SessionRuntime | undefined;
          let deferredDeletionFailure:
            | Cause.Cause<ProviderAdapterV2Error | ProviderSessionLookupError>
            | undefined;
          let detachedRelease:
            | { readonly input: ReleaseEntryInput; readonly state: ReleaseEntryState }
            | undefined;
          return Effect.gen(function* () {
            const key = sessionKey(input.providerSessionId);
            const currentEntry = (yield* Ref.get(sessions)).get(key);
            let archiveGenerationMatches = false;
            if (input.expectedArchivedAt !== undefined) {
              const projection = yield* loadThreadProjectionIfPresent(
                input.threadId,
                input.providerSessionId,
              );
              if (Option.isNone(projection)) return;
              const archivedAt = projection.value.thread.archivedAt;
              archiveGenerationMatches =
                archivedAt !== null && DateTime.formatIso(archivedAt) === input.expectedArchivedAt;
              if (!archiveGenerationMatches) {
                if (archivedAt === null && currentEntry !== undefined) {
                  const capturedRestoreRuntime = currentEntry.runtime;
                  yield* sessionLifecycle.withLock(
                    input.providerSessionId,
                    Effect.gen(function* () {
                      const refreshedProjection = yield* loadThreadProjectionIfPresent(
                        input.threadId,
                        input.providerSessionId,
                      );
                      if (
                        Option.isNone(refreshedProjection) ||
                        refreshedProjection.value.thread.archivedAt !== null
                      ) {
                        return;
                      }
                      const refreshedEntry = (yield* Ref.get(sessions)).get(key);
                      const expectedIncarnationId = input.providerSession?.incarnationId;
                      if (
                        refreshedEntry === undefined ||
                        refreshedEntry.runtime !== capturedRestoreRuntime ||
                        !refreshedEntry.attachedThreadIds.has(input.threadId) ||
                        (expectedIncarnationId !== undefined &&
                          refreshedEntry.runtime.providerSession.incarnationId !==
                            expectedIncarnationId)
                      ) {
                        return;
                      }
                      if (options.beforeStaleArchiveRestore !== undefined) {
                        yield* options.beforeStaleArchiveRestore;
                      }
                      yield* writeProviderSessionEvents({
                        runtime: refreshedEntry.runtime,
                        threadIds: [input.threadId],
                        type: "provider-session.attached",
                        payload: refreshedEntry.runtime.providerSession,
                      });
                    }),
                  );
                }
                return;
              }
            }
            const expectedIncarnationId = input.providerSession?.incarnationId;
            const expectedRuntimeDoesNotMatch =
              currentEntry !== undefined &&
              ((input.requireExpectedRuntime === true && expectedIncarnationId === undefined) ||
                (expectedIncarnationId !== undefined &&
                  currentEntry.runtime.providerSession.incarnationId !== expectedIncarnationId));
            if (
              currentEntry !== undefined &&
              expectedRuntimeDoesNotMatch &&
              input.deleteProviderThread !== true &&
              !archiveGenerationMatches
            ) {
              return;
            }
            // Capture runtime identity before any yield: a replacement session
            // can reuse the same providerSessionId while this fiber is parked.
            const capturedRuntime = currentEntry?.runtime;
            let resolvedProviderSession = input.providerSession ?? capturedRuntime?.providerSession;
            if (capturedRuntime !== undefined) {
              drainingRuntime = capturedRuntime;
              yield* markRuntimeDraining(capturedRuntime);
            }
            // Prefer caller-supplied threads for historical deletion and for
            // interrupt targets. Projection is refreshed after drain so any
            // already-admitted startTurn can project a running turn first.
            const providerThreads = new Map<string, OrchestrationV2ProviderThread>();
            const providerThreadByLogicalId = new Map<
              OrchestrationV2ProviderThread["id"],
              OrchestrationV2ProviderThread
            >();
            const addProviderThread = (providerThread: OrchestrationV2ProviderThread) => {
              // A null native reference is only a logical placeholder. There
              // is no provider-owned thread to interrupt or delete yet.
              if (providerThread.nativeThreadRef === null) {
                return;
              }
              if (!providerThreadByLogicalId.has(providerThread.id)) {
                providerThreadByLogicalId.set(providerThread.id, providerThread);
              }
              const runtimeKey = providerThreadRuntimeKey(providerThread);
              if (providerThreads.has(runtimeKey)) {
                return;
              }
              providerThreads.set(runtimeKey, providerThread);
            };
            for (const providerThread of input.providerThreads ?? []) {
              addProviderThread(providerThread);
            }
            let deletionFailure: Exit.Exit<void, ProviderAdapterV2Error> | null = null;
            let nativeDeletionAttempted = false;
            const deleteDetachedProviderThreads = Effect.gen(function* () {
              if (providerThreads.size === 0) {
                return null;
              }
              if (input.providerInstanceId === undefined || resolvedProviderSession === undefined) {
                if (deferredDeletionFailure === undefined) {
                  deferredDeletionFailure = Cause.fail(
                    new ProviderSessionLookupError({
                      providerSessionId: input.providerSessionId,
                      cause: "Provider session metadata is unavailable for native deletion.",
                    }),
                  );
                }
                return null;
              }
              const adapterExit = yield* Effect.exit(
                registry.get(input.providerInstanceId).pipe(
                  Effect.mapError(
                    (cause) =>
                      new ProviderSessionLookupError({
                        providerSessionId: input.providerSessionId,
                        cause,
                      }),
                  ),
                ),
              );
              if (Exit.isFailure(adapterExit)) {
                deferredDeletionFailure = adapterExit.cause;
                return null;
              }
              const adapter = adapterExit.value;
              const deleteDetachedThread = adapter.deleteDetachedThread;
              if (deleteDetachedThread === undefined) return null;
              const providerSession = resolvedProviderSession;
              const exits = yield* Effect.scoped(
                Effect.forEach(providerThreads.values(), (providerThread) =>
                  Effect.exit(
                    deleteDetachedThread({
                      providerSession,
                      providerThread,
                    }),
                  ),
                ),
              );
              return exits.find(Exit.isFailure) ?? null;
            });
            const stillOwnsCapturedRuntime = () =>
              Ref.get(sessions).pipe(
                Effect.map((current) => {
                  const entry = current.get(key);
                  return (
                    entry !== undefined &&
                    capturedRuntime !== undefined &&
                    entry.runtime === capturedRuntime
                  );
                }),
              );
            // Drain already-admitted work before snapshotting active turns.
            // An admitted startTurn can create a running provider turn after
            // detach begins; waiting first makes that turn visible to the
            // interrupt pass below. Use the raw captured runtime for those
            // interrupts because the exposed runtime rejects new operations
            // once the gate enters closing.
            if (capturedRuntime !== undefined) {
              const drained = yield* closeAndDrainRuntimeOperations(capturedRuntime);
              if (!drained) {
                const releaseInput = {
                  providerSessionId: input.providerSessionId,
                  reason: "runtime_error",
                  onlyIfRuntime: capturedRuntime,
                  detail: "Provider session operation drain timed out during detach.",
                } satisfies ReleaseEntryInput;
                const releaseState: ReleaseEntryState = { entry: Option.none() };
                detachedRelease = { input: releaseInput, state: releaseState };
                yield* acquireReleasedEntry(releaseInput, releaseState);
                return yield* new ProviderAdapterProtocolError({
                  driver: capturedRuntime.driver,
                  detail: `Provider session ${input.providerSessionId} operation drain timed out`,
                });
              }
            }
            const shouldLoadProviderThreads =
              input.deleteProviderThread === true ||
              currentEntry?.supportsMultipleProviderThreads === true;
            const projection = shouldLoadProviderThreads
              ? yield* loadThreadProjectionIfPresent(input.threadId, input.providerSessionId)
              : Option.none();
            if (Option.isSome(projection)) {
              for (const providerThread of projection.value.providerThreads) {
                if (providerThread.providerSessionId === input.providerSessionId) {
                  addProviderThread(providerThread);
                }
              }
            }
            const refreshedEntry = (yield* Ref.get(sessions)).get(key);
            if (refreshedEntry !== undefined && refreshedEntry.runtime === capturedRuntime) {
              const loadedProviderThread = refreshedEntry.loadedProviderThreadByThread.get(
                input.threadId,
              );
              if (loadedProviderThread !== undefined) {
                const loadedNativeThreadRef = loadedProviderThread.nativeThreadRef;
                const loadedRuntimeKey = providerThreadRuntimeKey(loadedProviderThread);
                const alreadyPersisted = Option.isSome(projection)
                  ? projection.value.providerThreads.some(
                      (providerThread) =>
                        providerThread.providerSessionId === input.providerSessionId &&
                        providerThreadRuntimeKey(providerThread) === loadedRuntimeKey,
                    )
                  : false;
                let deletionTarget = loadedProviderThread;
                if (
                  input.deleteProviderThread === true &&
                  loadedNativeThreadRef !== null &&
                  !alreadyPersisted
                ) {
                  const placeholder = Option.isSome(projection)
                    ? (projection.value.providerThreads.find(
                        (providerThread) =>
                          providerThread.nativeThreadRef === null &&
                          providerThread.id === projection.value.thread.activeProviderThreadId &&
                          providerThread.providerSessionId === input.providerSessionId,
                      ) ??
                      projection.value.providerThreads.find(
                        (providerThread) =>
                          providerThread.providerSessionId === input.providerSessionId &&
                          providerThread.nativeThreadRef === null,
                      ))
                    : undefined;
                  const projectedLogicalIdConflict = Option.isSome(projection)
                    ? projection.value.providerThreads.some(
                        (providerThread) =>
                          providerThread.id === loadedProviderThread.id &&
                          providerThread.nativeThreadRef !== null,
                      )
                    : false;
                  deletionTarget =
                    placeholder === undefined
                      ? projectedLogicalIdConflict
                        ? {
                            ...loadedProviderThread,
                            id: idAllocator.derive.providerThread({
                              driver: loadedNativeThreadRef.driver,
                              nativeThreadId: loadedNativeThreadRef.nativeId ?? loadedRuntimeKey,
                            }),
                          }
                        : loadedProviderThread
                      : {
                          ...loadedProviderThread,
                          id: placeholder.id,
                          providerSessionId: input.providerSessionId,
                          appThreadId: input.threadId,
                          ownerNodeId: placeholder.ownerNodeId,
                          firstRunOrdinal: placeholder.firstRunOrdinal,
                          lastRunOrdinal: placeholder.lastRunOrdinal,
                          handoffIds: placeholder.handoffIds,
                          forkedFrom: placeholder.forkedFrom,
                          createdAt: placeholder.createdAt,
                        };
                  const now = yield* DateTime.now;
                  yield* eventSink.write({
                    events: [
                      {
                        id: yield* idAllocator.allocate.event({ threadId: input.threadId }),
                        type: "provider-thread.updated",
                        threadId: input.threadId,
                        driver: deletionTarget.driver,
                        providerInstanceId: deletionTarget.providerInstanceId,
                        occurredAt: now,
                        payload: deletionTarget,
                      },
                    ],
                  });
                }
                addProviderThread(deletionTarget);
                providerThreadByLogicalId.set(loadedProviderThread.id, deletionTarget);
                providerThreadByLogicalId.set(deletionTarget.id, deletionTarget);
                if (Option.isSome(projection)) {
                  for (const providerThread of projection.value.providerThreads) {
                    if (
                      providerThread.providerSessionId === input.providerSessionId &&
                      providerThread.nativeThreadRef === null
                    ) {
                      providerThreadByLogicalId.set(providerThread.id, deletionTarget);
                    }
                  }
                }
              }
            }
            if (
              input.deleteProviderThread === true &&
              resolvedProviderSession === undefined &&
              providerThreads.size > 0
            ) {
              const sessionLookup = yield* Effect.exit(
                projectionStore
                  .getProviderSessionsByIds(input.threadId, [input.providerSessionId])
                  .pipe(
                    Effect.mapError(
                      (cause) =>
                        new ProviderSessionLookupError({
                          providerSessionId: input.providerSessionId,
                          cause,
                        }),
                    ),
                  ),
              );
              if (Exit.isFailure(sessionLookup)) {
                deferredDeletionFailure = sessionLookup.cause;
              } else {
                resolvedProviderSession = sessionLookup.value.find(
                  (session) => session.id === input.providerSessionId,
                );
              }
            }
            if (
              currentEntry !== undefined &&
              capturedRuntime !== undefined &&
              (currentEntry.supportsMultipleProviderThreads ||
                input.deleteProviderThread === true) &&
              (yield* stillOwnsCapturedRuntime())
            ) {
              const projectedTurns = Option.isSome(projection)
                ? projection.value.providerTurns.filter((turn) => turn.status === "running")
                : [];
              const trackedTurns = [...(yield* Ref.get(currentEntry.activeProviderTurns)).values()];
              const activeTurns = [
                ...new Map(
                  [...projectedTurns, ...trackedTurns]
                    .filter((turn) => providerThreadByLogicalId.has(turn.providerThreadId))
                    .map((turn) => [turn.id, turn] as const),
                ).values(),
              ];
              yield* Effect.forEach(
                activeTurns,
                (turn) =>
                  capturedRuntime
                    .interruptTurn({
                      providerThread: providerThreadByLogicalId.get(turn.providerThreadId)!,
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
            if (
              input.deleteProviderThread === true &&
              capturedRuntime?.deleteThread !== undefined &&
              (yield* stillOwnsCapturedRuntime())
            ) {
              nativeDeletionAttempted = true;
              const deleteThread = capturedRuntime.deleteThread;
              const exits = yield* Effect.forEach(
                providerThreads.values(),
                (providerThread) => Effect.exit(deleteThread(providerThread)),
                { concurrency: 1 },
              );
              deletionFailure = exits.find(Exit.isFailure) ?? deletionFailure;
            }
            if (input.deleteProviderThread === true && !nativeDeletionAttempted) {
              deletionFailure = (yield* deleteDetachedProviderThreads) ?? deletionFailure;
            }
            const detached = yield* Ref.modify(sessions, (current) => {
              const entry = current.get(key);
              // Only mutate the runtime we captured. A missing capture means
              // the entry was already gone (historical retry); never detach a
              // replacement that reused the same providerSessionId.
              if (
                entry === undefined ||
                !entry.attachedThreadIds.has(input.threadId) ||
                entry.runtime !== capturedRuntime
              ) {
                return [Option.none<LiveSessionEntry>(), current] as const;
              }
              const attachedThreadIds = new Set(entry.attachedThreadIds);
              attachedThreadIds.delete(input.threadId);
              const loadedProviderThreadKeyByThread = new Map(
                entry.loadedProviderThreadKeyByThread,
              );
              loadedProviderThreadKeyByThread.delete(input.threadId);
              const loadedProviderThreadByThread = new Map(entry.loadedProviderThreadByThread);
              loadedProviderThreadByThread.delete(input.threadId);
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
                loadedProviderThreadByThread,
                mcpCredentialIdByThread,
              };
              const updated = new Map(current);
              updated.set(key, updatedEntry);
              return [Option.some(updatedEntry), updated] as const;
            });
            // Plain detaches deliberately do not revoke: a detached thread's
            // provider process may still be alive (shared multi-thread codex
            // session across a workspace handoff) and holds its MCP client's
            // credential for the thread it will re-attach with. Credentials
            // are revoked when the session entry is released (process gone)
            // or rotated on the next attach if they stopped resolving.
            // Terminal detaches (thread archived or deleted) revoke the
            // thread's credential once no live replacement or in-flight open
            // holds it. A stale retry must not revoke a credential issued after
            // the thread was unarchived and reopened.
            if (input.revokeMcpCredential === true) {
              const credentialId = McpProviderSession.readMcpProviderSession(
                input.threadId,
              )?.providerSessionId;
              if (credentialId !== undefined) {
                yield* clearMcpSessionIfUnheld(input.threadId, credentialId);
              }
            }
            if (Option.isSome(detached)) {
              if (
                detached.value.attachedThreadIds.size === 0 &&
                !detached.value.supportsMultipleProviderThreads
              ) {
                const releaseInput = {
                  providerSessionId: input.providerSessionId,
                  reason: "manual_shutdown",
                  onlyIfRuntime: detached.value.runtime,
                  ...(input.detail === undefined ? {} : { detail: input.detail }),
                } satisfies ReleaseEntryInput;
                const releaseState: ReleaseEntryState = { entry: Option.none() };
                detachedRelease = { input: releaseInput, state: releaseState };
                yield* acquireReleasedEntry(releaseInput, releaseState);
              } else {
                yield* scheduleIdleRelease(input.providerSessionId, detached.value.runtime);
              }
            }
            if (deletionFailure !== null && Exit.isFailure(deletionFailure)) {
              deferredDeletionFailure = deletionFailure.cause;
            }
          }).pipe(
            Effect.ensuring(
              Effect.suspend(() =>
                drainingRuntime === undefined ? Effect.void : finishRuntimeDrain(drainingRuntime),
              ),
            ),
            (effect) => sessionOpen.withLock(input.providerSessionId, effect),
            Effect.ensuring(
              Effect.suspend(() =>
                detachedRelease === undefined || Option.isNone(detachedRelease.state.entry)
                  ? Effect.void
                  : finalizeReleasedEntry(detachedRelease.input, detachedRelease.state.entry.value),
              ),
            ),
            Effect.andThen(
              Effect.suspend(() =>
                deferredDeletionFailure === undefined
                  ? Effect.void
                  : Effect.failCause(deferredDeletionFailure),
              ),
            ),
            Effect.catchCause((cause) =>
              Effect.fail(
                new ProviderSessionReleaseError({
                  providerSessionId: input.providerSessionId,
                  reason: "manual_shutdown",
                  cause,
                }),
              ),
            ),
          );
        },
      } satisfies ProviderSessionManagerV2Shape);
    }),
  );

export const layer = layerWithOptions();
