import {
  ModelSelection,
  OrchestrationV2DomainEvent,
  OrchestrationV2ProviderSession,
  OrchestrationV2RuntimeRequest,
  ProviderKind,
  ProviderSessionId,
  ThreadId,
} from "@t3tools/contracts";
import {
  Cause,
  Clock,
  Context,
  DateTime,
  Duration,
  Effect,
  Exit,
  Fiber,
  Layer,
  Option,
  Ref,
  Schema,
  Scope,
  Stream,
} from "effect";

import { EventSinkV2 } from "./EventSink.ts";
import { IdAllocatorV2 } from "./IdAllocator.ts";
import {
  ProviderAdapterV2RuntimePolicy,
  type ProviderAdapterV2SessionRuntime,
} from "./ProviderAdapter.ts";
import { ProviderAdapterRegistryV2 } from "./ProviderAdapterRegistry.ts";
import { ProjectionStoreV2 } from "./ProjectionStore.ts";

const DEFAULT_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

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
 * It intentionally does not decide whether a provider failure should be retried.
 * The next recovery layer should classify adapter failures into canonical runtime
 * failure kinds before attempting recovery:
 *
 * - process_exited / transport_unavailable: bounded restart + native thread resume.
 * - network_unavailable: wait for ConnectivityService to report online, then resume.
 * - provider_rate_limited: retry only when retry-after/idempotency/retry budget allow it.
 * - provider_quota_exceeded / auth_invalid / permission_denied / invalid_request:
 *   terminal until user or configuration changes.
 *
 * This keeps lifecycle cleanup separate from policy-driven recovery.
 */
export class ProviderSessionOpenError extends Schema.TaggedErrorClass<ProviderSessionOpenError>()(
  "ProviderSessionOpenError",
  {
    provider: ProviderKind,
    providerSessionId: ProviderSessionId,
    cause: Schema.optional(Schema.Defect),
  },
) {
  override get message(): string {
    return `Failed to open ${this.provider} provider session ${this.providerSessionId}.`;
  }
}

export class ProviderSessionLookupError extends Schema.TaggedErrorClass<ProviderSessionLookupError>()(
  "ProviderSessionLookupError",
  {
    providerSessionId: ProviderSessionId,
    cause: Schema.optional(Schema.Defect),
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
    cause: Schema.optional(Schema.Defect),
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
    cause: Schema.optional(Schema.Defect),
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
    cause: Schema.optional(Schema.Defect),
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
  readonly close: (
    providerSessionId: ProviderSessionId,
  ) => Effect.Effect<void, ProviderSessionManagerV2Error>;
  readonly release: (input: {
    readonly providerSessionId: ProviderSessionId;
    readonly reason: ProviderSessionReleaseReason;
    readonly detail?: string;
  }) => Effect.Effect<void, ProviderSessionManagerV2Error>;
}

export class ProviderSessionManagerV2 extends Context.Service<
  ProviderSessionManagerV2,
  ProviderSessionManagerV2Shape
>()("t3/orchestration-v2/ProviderSessionManager") {}

interface LiveSessionEntry {
  readonly attachedThreadIds: ReadonlySet<ThreadId>;
  readonly runtime: ProviderAdapterV2SessionRuntime;
  readonly exposedRuntime: ProviderAdapterV2SessionRuntime;
  readonly scope: Scope.Closeable;
  readonly idleGeneration: number;
  readonly busyCount: number;
  readonly lastActivityAtMs: number;
  readonly idleFiber: Fiber.Fiber<void, never> | null;
}

export interface ProviderSessionManagerV2LayerOptions {
  readonly idleTimeoutMs?: number;
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

export const layerWithOptions = (
  options: ProviderSessionManagerV2LayerOptions = {},
): Layer.Layer<
  ProviderSessionManagerV2,
  never,
  EventSinkV2 | IdAllocatorV2 | ProjectionStoreV2 | ProviderAdapterRegistryV2
> =>
  Layer.effect(
    ProviderSessionManagerV2,
    Effect.gen(function* () {
      const registry = yield* ProviderAdapterRegistryV2;
      const eventSink = yield* EventSinkV2;
      const idAllocator = yield* IdAllocatorV2;
      const projectionStore = yield* ProjectionStoreV2;
      const layerScope = yield* Effect.scope;
      const sessions = yield* Ref.make(new Map<string, LiveSessionEntry>());
      const idleTimeoutMs = Math.max(1, options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS);

      const cancelIdleFiber = (fiber: Fiber.Fiber<void, never> | null) =>
        fiber === null ? Effect.void : Fiber.interrupt(fiber).pipe(Effect.ignore);

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
          const events = yield* Effect.forEach(
            Array.from(input.entry.attachedThreadIds),
            (threadId) =>
              Effect.gen(function* () {
                return {
                  id: yield* idAllocator.allocate.event({
                    threadId,
                    providerSessionId: input.entry.runtime.providerSessionId,
                  }),
                  type: "provider-session.updated",
                  threadId,
                  provider: input.entry.runtime.provider,
                  occurredAt: now,
                  payload,
                } satisfies OrchestrationV2DomainEvent;
              }),
          );
          yield* eventSink.write({ events });
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
                provider: input.entry.runtime.provider,
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
                  provider: input.entry.runtime.provider,
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
                  provider: input.entry.runtime.provider,
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
      }) =>
        Effect.gen(function* () {
          const key = sessionKey(input.providerSessionId);
          const entry = yield* Ref.modify(sessions, (current) => {
            const existing = current.get(key);
            if (existing === undefined) {
              return [Option.none<LiveSessionEntry>(), current] as const;
            }
            const updated = new Map(current);
            updated.delete(key);
            return [Option.some(existing), updated] as const;
          });
          if (Option.isNone(entry)) {
            return;
          }

          if (input.cancelIdleFiber !== false) {
            yield* cancelIdleFiber(entry.value.idleFiber);
          }
          const closeExit = yield* Effect.exit(Scope.close(entry.value.scope, Exit.void));
          yield* writeReleasedSessionEvents({
            entry: entry.value,
            reason: input.reason,
            ...(input.detail === undefined ? {} : { detail: input.detail }),
          });
          yield* writeReleasedRuntimeRequestEvents({
            entry: entry.value,
            reason: input.reason,
          });
          if (Exit.isFailure(closeExit)) {
            return yield* Effect.failCause(closeExit.cause);
          }
        }).pipe(
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

      const releaseIfStillIdle = (input: {
        readonly providerSessionId: ProviderSessionId;
        readonly generation: number;
      }) =>
        Effect.gen(function* () {
          const current = yield* Ref.get(sessions);
          const entry = current.get(sessionKey(input.providerSessionId));
          if (
            entry === undefined ||
            entry.busyCount > 0 ||
            entry.idleGeneration !== input.generation
          ) {
            return;
          }
          yield* releaseEntry({
            providerSessionId: input.providerSessionId,
            reason: "idle_timeout",
            cancelIdleFiber: false,
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("orchestration-v2.provider-session.idle-release-failed", {
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

      const scheduleIdleReleaseInternal = (providerSessionId: ProviderSessionId) =>
        Effect.gen(function* () {
          const key = sessionKey(providerSessionId);
          const current = yield* Ref.get(sessions);
          const entry = current.get(key);
          if (entry === undefined || entry.busyCount > 0) {
            return;
          }

          yield* cancelIdleFiber(entry.idleFiber);
          const generation = entry.idleGeneration + 1;
          const idleFiber = yield* Effect.sleep(Duration.millis(idleTimeoutMs)).pipe(
            Effect.andThen(releaseIfStillIdle({ providerSessionId, generation })),
            Effect.forkIn(layerScope),
          );
          const lastActivityAtMs = yield* Clock.currentTimeMillis;
          yield* Ref.update(sessions, (latest) => {
            const latestEntry = latest.get(key);
            if (latestEntry === undefined || latestEntry.busyCount > 0) {
              return latest;
            }
            const updated = new Map(latest);
            updated.set(key, {
              ...latestEntry,
              idleGeneration: generation,
              idleFiber,
              lastActivityAtMs,
            });
            return updated;
          });
        });

      const scheduleIdleRelease = (providerSessionId: ProviderSessionId) =>
        withActivityError(providerSessionId, scheduleIdleReleaseInternal(providerSessionId));

      const touchActivity = (providerSessionId: ProviderSessionId) =>
        withActivityError(
          providerSessionId,
          Effect.gen(function* () {
            const lastActivityAtMs = yield* Clock.currentTimeMillis;
            yield* Ref.update(sessions, (current) => {
              const entry = current.get(sessionKey(providerSessionId));
              if (entry === undefined) {
                return current;
              }
              const updated = new Map(current);
              updated.set(sessionKey(providerSessionId), {
                ...entry,
                lastActivityAtMs,
              });
              return updated;
            });
            yield* scheduleIdleReleaseInternal(providerSessionId);
          }),
        );

      const attachThread = (input: {
        readonly providerSessionId: ProviderSessionId;
        readonly threadId: ThreadId;
      }) =>
        withActivityError(
          input.providerSessionId,
          Ref.update(sessions, (current) => {
            const entry = current.get(sessionKey(input.providerSessionId));
            if (entry === undefined || entry.attachedThreadIds.has(input.threadId)) {
              return current;
            }
            const updated = new Map(current);
            updated.set(sessionKey(input.providerSessionId), {
              ...entry,
              attachedThreadIds: new Set([...entry.attachedThreadIds, input.threadId]),
            });
            return updated;
          }),
        );

      const markBusy = (providerSessionId: ProviderSessionId) =>
        withActivityError(
          providerSessionId,
          Effect.gen(function* () {
            const key = sessionKey(providerSessionId);
            const now = yield* Clock.currentTimeMillis;
            const idleFiber = yield* Ref.modify(sessions, (current) => {
              const entry = current.get(key);
              if (entry === undefined) {
                return [null, current] as const;
              }
              const updated = new Map(current);
              updated.set(key, {
                ...entry,
                busyCount: entry.busyCount + 1,
                idleFiber: null,
                lastActivityAtMs: now,
              });
              return [entry.idleFiber, updated] as const;
            });
            yield* cancelIdleFiber(idleFiber);
          }),
        );

      const markIdle = (providerSessionId: ProviderSessionId) =>
        withActivityError(
          providerSessionId,
          Effect.gen(function* () {
            const key = sessionKey(providerSessionId);
            const now = yield* Clock.currentTimeMillis;
            yield* Ref.update(sessions, (current) => {
              const entry = current.get(key);
              if (entry === undefined) {
                return current;
              }
              const updated = new Map(current);
              updated.set(key, {
                ...entry,
                busyCount: Math.max(0, entry.busyCount - 1),
                lastActivityAtMs: now,
              });
              return updated;
            });
            yield* scheduleIdleReleaseInternal(providerSessionId);
          }),
        );

      const observeActivity = (
        providerSessionId: ProviderSessionId,
        activity: Effect.Effect<void, ProviderSessionActivityError>,
      ) =>
        activity.pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("orchestration-v2.provider-session.activity-failed", {
              providerSessionId,
              cause,
            }),
          ),
        );

      const decorateRuntime = (
        runtime: ProviderAdapterV2SessionRuntime,
      ): ProviderAdapterV2SessionRuntime => {
        const providerSessionId = runtime.providerSessionId;
        return {
          ...runtime,
          events: runtime.events.pipe(
            Stream.tap((event) =>
              event.type === "turn.terminal"
                ? observeActivity(providerSessionId, markIdle(providerSessionId))
                : observeActivity(providerSessionId, touchActivity(providerSessionId)),
            ),
            Stream.catchCause((cause) =>
              Stream.fromEffect(
                releaseEntry({
                  providerSessionId,
                  reason: "runtime_error",
                  detail: Cause.pretty(cause),
                }).pipe(Effect.ignore, Effect.andThen(Effect.failCause(cause))),
              ),
            ),
          ),
          ensureThread: (input) =>
            observeActivity(
              providerSessionId,
              attachThread({ providerSessionId, threadId: input.threadId }),
            ).pipe(Effect.andThen(runtime.ensureThread(input))),
          resumeThread: (input) =>
            input.providerThread.appThreadId === null
              ? runtime.resumeThread(input)
              : observeActivity(
                  providerSessionId,
                  attachThread({
                    providerSessionId,
                    threadId: input.providerThread.appThreadId,
                  }),
                ).pipe(Effect.andThen(runtime.resumeThread(input))),
          startTurn: (input) =>
            observeActivity(
              providerSessionId,
              attachThread({ providerSessionId, threadId: input.threadId }),
            ).pipe(
              Effect.andThen(observeActivity(providerSessionId, markBusy(providerSessionId))),
              Effect.andThen(runtime.startTurn(input)),
              Effect.catch((error) =>
                observeActivity(providerSessionId, markIdle(providerSessionId)).pipe(
                  Effect.andThen(Effect.fail(error)),
                ),
              ),
            ),
          steerTurn: (input) =>
            observeActivity(providerSessionId, touchActivity(providerSessionId)).pipe(
              Effect.andThen(runtime.steerTurn(input)),
            ),
          interruptTurn: (input) =>
            observeActivity(providerSessionId, touchActivity(providerSessionId)).pipe(
              Effect.andThen(runtime.interruptTurn(input)),
            ),
          respondToRuntimeRequest: (input) =>
            observeActivity(providerSessionId, touchActivity(providerSessionId)).pipe(
              Effect.andThen(runtime.respondToRuntimeRequest(input)),
            ),
        };
      };

      return ProviderSessionManagerV2.of({
        open: (input) =>
          Effect.gen(function* () {
            const key = sessionKey(input.providerSessionId);
            const existing = (yield* Ref.get(sessions)).get(key);
            if (existing !== undefined) {
              yield* attachThread({
                providerSessionId: input.providerSessionId,
                threadId: input.threadId,
              });
              yield* touchActivity(input.providerSessionId);
              return existing.exposedRuntime;
            }

            const adapter = yield* registry.get(input.modelSelection.provider).pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderSessionOpenError({
                    provider: input.modelSelection.provider,
                    providerSessionId: input.providerSessionId,
                    cause,
                  }),
              ),
            );
            const sessionScope = yield* Scope.make();
            const runtime = yield* adapter
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
                Effect.tapError(() => Scope.close(sessionScope, Exit.void).pipe(Effect.ignore)),
                Effect.mapError(
                  (cause) =>
                    new ProviderSessionOpenError({
                      provider: input.modelSelection.provider,
                      providerSessionId: input.providerSessionId,
                      cause,
                    }),
                ),
              );
            const exposedRuntime = decorateRuntime(runtime);
            const now = yield* Clock.currentTimeMillis;
            yield* Ref.update(sessions, (current) => {
              const updated = new Map(current);
              updated.set(key, {
                attachedThreadIds: new Set([input.threadId]),
                runtime,
                exposedRuntime,
                scope: sessionScope,
                idleGeneration: 0,
                busyCount: 0,
                lastActivityAtMs: now,
                idleFiber: null,
              });
              return updated;
            });
            yield* scheduleIdleRelease(input.providerSessionId);
            return exposedRuntime;
          }),
        get: (providerSessionId) =>
          Effect.gen(function* () {
            const entry = (yield* Ref.get(sessions)).get(sessionKey(providerSessionId));
            if (entry === undefined) {
              return Option.none<ProviderAdapterV2SessionRuntime>();
            }
            yield* touchActivity(providerSessionId);
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
        release: releaseEntry,
      } satisfies ProviderSessionManagerV2Shape);
    }),
  );

export const layer = layerWithOptions();
