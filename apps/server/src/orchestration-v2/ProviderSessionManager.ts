import { AgentScope } from "@t3tools/shared/AgentScope";
import * as KeyedLock from "@t3tools/shared/KeyedLock";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  isOrchestrationV2WorkActive,
  ModelSelection,
  OrchestrationV2DomainEvent,
  OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  OrchestrationV2RuntimeRequest,
  ProviderInstanceId,
  ProviderSessionId,
  ThreadId,
  type ProviderThreadId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FiberSet from "effect/FiberSet";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";

import { normalizeModelMetricLabel } from "../observability/Attributes.ts";
import {
  providerSessionsTotal,
  providerTurnDuration,
  providerTurnsTotal,
  withMetrics,
} from "../observability/Metrics.ts";
import { ProviderWorkspaceMissingError } from "../provider/Errors.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import * as ServerSettings from "../serverSettings.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as EventSink from "./EventSink.ts";
import * as CommandOutputHub from "./CommandOutputHub.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import type { ProviderSessionManagerV2Shape, ProviderSessionReleaseReason } from "./ProviderSessionManager-part2.ts";
import { DEFAULT_IDLE_TIMEOUT_MS, DEFAULT_MAX_IDLE_PIN_MS, PROVIDER_INTERRUPT_TIMEOUT_MS, ProviderSessionActivityError, ProviderSessionCloseError, ProviderSessionLookupError, ProviderSessionOpenError, ProviderSessionReleaseError, RELEASE_SCOPE_CLOSE_TIMEOUT_MS, UNLOAD_THREAD_TIMEOUT_MS, WORKING_RUN_STATUSES, busyTurnKey, busyTurnPrefix } from "./ProviderSessionManager-part2.ts";
import type { IdleThreadUnload, LiveSessionEntry, ProviderSessionEventSignal, ProviderSessionManagerV2LayerOptions } from "./ProviderSessionManager-part3.ts";
import { providerThreadLoadKey, releaseStatusFor, releasedRuntimeRequestStatusFor, sessionKey, sessionScopedRuntimeRequestThreadId } from "./ProviderSessionManager-part3.ts";

export class ProviderSessionManagerV2 extends Context.Service<
  ProviderSessionManagerV2,
  ProviderSessionManagerV2Shape
>()("t3/orchestration-v2/ProviderSessionManager/ProviderSessionManagerV2") {}

import { makeProviderSessionStoreShape } from "./ProviderSessionManager-part4.ts";
import { makeProviderSessionReleaseShape } from "./ProviderSessionManager-part5.ts";
import { makeProviderSessionAttachShape } from "./ProviderSessionManager-part6.ts";
import { makeProviderRuntimeShape } from "./ProviderSessionManager-part7.ts";

export const layerWithOptions = (
  options: ProviderSessionManagerV2LayerOptions = {},
): Layer.Layer<
  ProviderSessionManagerV2,
  never,
  | CommandOutputHub.CommandOutputHub
  | EventSink.EventSinkV2
  | FileSystem.FileSystem
  | IdAllocator.IdAllocatorV2
  | McpProviderSessions.McpProviderSessions
  | McpSessionRegistry.McpSessionRegistry
  | ProjectionStore.ProjectionStoreV2
  | ProviderEventIngestor.ProviderEventIngestorV2
  | ProviderAdapterRegistry.ProviderAdapterRegistryV2
> =>
  Layer.effect(
    ProviderSessionManagerV2,
    Effect.gen(function* () {
      const registry = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
      const fileSystem = yield* FileSystem.FileSystem;
      const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
      const agentScope = yield* AgentScope;

      const store = yield* makeProviderSessionStoreShape(options);
      const release = yield* makeProviderSessionReleaseShape(store);
      const attach = yield* makeProviderSessionAttachShape(store, release);
      const runtimeTools = yield* makeProviderRuntimeShape(store, release, attach);

      const {
        sessions,
        sessionOpen,
        threadAttachment,
        threadAttachmentKey,
        idleTimeoutMs,
        prepareMcpSession,
        dropMcpCredentialReservation,
        clearMcpSession,
        cancelIdleFiber,
        writeProviderSessionEvents,
      } = store;
      const { releaseEntry, closeScopeWithin, logReleaseFailure } = release;
      const {
        withActivityError,
        ensureThreadAttached,
        markIdle,
        scheduleIdleRelease,
        touchActivity,
        observeActivity,
      } = attach;
      const { decorateRuntime, startEventPump } = runtimeTools;
      const sessionKey = (providerSessionId: ProviderSessionId): string =>
        String(providerSessionId);

      // Shutdown must fit the launcher's 5 s deadline with up to 15 sessions.
      const sessionScopes = yield* Scope.make("parallel");
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
          { concurrency: "unbounded", discard: true },
        );
      });
      yield* Effect.addFinalizer(() =>
        shutdown.pipe(
          Effect.ensuring(closeScopeWithin(sessionScopes, { reason: "server_shutdown" })),
        ),
      );

      return ProviderSessionManagerV2.of({
        shutdown,
        open: (input) =>
          sessionOpen.withLock(
            input.providerSessionId,
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
              const key = sessionKey(input.providerSessionId);
              const existing = (yield* Ref.get(sessions)).get(key);
              if (existing !== undefined) {
                const attached = existing.attachedThreadIds.has(input.threadId);
                if (!attached && !existing.supportsMultipleProviderThreads) {
                  return yield* new ProviderSessionOpenError({
                    instanceId: input.modelSelection.instanceId,
                    providerSessionId: input.providerSessionId,
                    cause: `Provider ${existing.runtime.driver} does not support attaching multiple app threads to one session.`,
                  });
                }
                if (!attached) yield* agentScope.clear(input.threadId);
                yield* ensureThreadAttached({
                  providerSessionId: input.providerSessionId,
                  threadId: input.threadId,
                  providerInstanceId: existing.runtime.instanceId,
                });
                yield* touchActivity(input.providerSessionId);
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
              );
              const mcpCredentialId = prepared.mcpCredentialId;
              let reservationDropped = mcpCredentialId === undefined;
              const dropReservation = Effect.sync(() => {
                if (!reservationDropped && mcpCredentialId !== undefined) {
                  reservationDropped = true;
                  dropMcpCredentialReservation(input.threadId, mcpCredentialId);
                }
              });
              const sessionScope = yield* Scope.fork(sessionScopes);
              yield* agentScope.clear(input.threadId);
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
                  // Bound scope close after cleanup; a wedged finalizer must not hold the open lock or interrupter.
                  Effect.onError(() =>
                    dropReservation.pipe(
                      Effect.andThen(
                        prepared.issued
                          ? clearMcpSession(input.threadId, mcpCredentialId)
                          : Effect.void,
                      ),
                      Effect.ensuring(
                        closeScopeWithin(sessionScope, {
                          providerSessionId: input.providerSessionId,
                          reason: "open_failed",
                        }),
                      ),
                    ),
                  ),
                  Effect.mapError(
                    (cause) =>
                      new ProviderSessionOpenError({
                        instanceId: input.modelSelection.instanceId,
                        providerSessionId: input.providerSessionId,
                        cause,
                      }),
                  ),
                  withMetrics({
                    counter: providerSessionsTotal,
                    attributes: { provider: adapter.driver, operation: "open" },
                  }),
                );
              const eventSubscribers = yield* Ref.make<
                ReadonlyMap<number, Queue.Queue<ProviderSessionEventSignal, Cause.Done>>
              >(new Map());
              const exposedRuntime = decorateRuntime(runtime, eventSubscribers);
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
                busyTurns: new Set(),
                idleFiber: null,
                pinnedSinceMs: null,
                idleThreadUnloads: new Map(),
              };
              yield* Ref.update(sessions, (current) => {
                const updated = new Map(current);
                updated.set(key, entry);
                return updated;
              });
              yield* dropReservation;
              yield* withActivityError(
                input.providerSessionId,
                writeProviderSessionEvents({
                  runtime,
                  threadIds: [input.threadId],
                  type: "provider-session.attached",
                  payload: runtime.providerSession,
                }),
              ).pipe(
                // Release on interruption too; no event pump or idle timer exists to clean up yet.
                Effect.onError((cause) =>
                  releaseEntry(
                    Cause.hasInterruptsOnly(cause)
                      ? {
                          providerSessionId: input.providerSessionId,
                          reason: "manual_shutdown",
                          detail: "The provider session start was interrupted.",
                        }
                      : {
                          providerSessionId: input.providerSessionId,
                          reason: "runtime_error",
                          detail: "Failed to persist the provider-session attachment.",
                        },
                  ).pipe(logReleaseFailure(input.providerSessionId)),
                ),
              );
              yield* startEventPump(entry);
              yield* scheduleIdleRelease(input.providerSessionId);
              return exposedRuntime;
            }),
          ),
        isLive: (providerSessionId) =>
          Ref.get(sessions).pipe(
            Effect.map((current) => current.has(sessionKey(providerSessionId))),
          ),
        get: Effect.fn("ProviderSessionManager.get")(
          function* (providerSessionId) {
            const entry = (yield* Ref.get(sessions)).get(sessionKey(providerSessionId));
            if (entry === undefined) {
              return Option.none<ProviderAdapter.ProviderAdapterV2SessionRuntime>();
            }
            yield* touchActivity(providerSessionId);
            return Option.some(entry.exposedRuntime);
          },
          (effect, providerSessionId) =>
            effect.pipe(
              Effect.mapError(
                (cause) =>
                  new ProviderSessionLookupError({
                    providerSessionId,
                    cause,
                  }),
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
        closeInstance: Effect.fn("ProviderSessionManager.closeInstance")(
          function* (instanceId) {
            const active = [...(yield* Ref.get(sessions)).values()].filter(
              (entry) => entry.runtime.instanceId === instanceId,
            );
            const outcomes = yield* Effect.forEach(
              active,
              (entry) =>
                releaseEntry({
                  providerSessionId: entry.runtime.providerSessionId,
                  reason: "manual_shutdown",
                  detail: `Provider instance ${instanceId} logged out.`,
                }).pipe(Effect.exit),
              { concurrency: "unbounded" },
            );
            const failure = outcomes.find(Exit.isFailure);
            if (failure !== undefined && Exit.isFailure(failure)) {
              return yield* Effect.failCause(failure.cause);
            }
          },
          (effect, instanceId) =>
            effect.pipe(
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
        ),
        release: releaseEntry,
        releaseUnlessBusy: Effect.fn("ProviderSessionManager.releaseUnlessBusy")(function* (input) {
          const key = sessionKey(input.providerSessionId);
          const before = (yield* Ref.get(sessions)).get(key);
          yield* releaseEntry({
            providerSessionId: input.providerSessionId,
            reason: input.reason,
            ...(input.detail === undefined ? {} : { detail: input.detail }),
            keepIfBusyOtherThan: input.ownProviderThreadIds,
          });
          // Identity, not presence: open can install a replacement under the same id meanwhile.
          return before !== undefined && (yield* Ref.get(sessions)).get(key) !== before;
        }),
        otherWorkingThreads: Effect.fn("ProviderSessionManager.otherWorkingThreads")(
          function* (input) {
            const entry = (yield* Ref.get(sessions)).get(sessionKey(input.providerSessionId));
            if (entry === undefined || !entry.supportsMultipleProviderThreads) return [];
            return yield* Effect.filter(
              [...entry.attachedThreadIds].filter((threadId) => threadId !== input.threadId),
              (threadId) =>
                // Runs, not the shell's activeRunId: the shell omits silent runs such as idle
                // compaction. Background work outlives its run and still needs the process.
                Effect.zipWith(
                  projectionStore.getThreadRecords(threadId, ["runs"]),
                  projectionStore.getThreadShell(threadId),
                  ({ runs }, shell) =>
                    runs.some((run) => WORKING_RUN_STATUSES.has(run.status)) ||
                    (shell?.pendingBackgroundTasks?.length ?? 0) > 0,
                ).pipe(
                  // An unreadable thread may still be working; never kill it unseen.
                  Effect.orElseSucceed(() => true),
                ),
            );
          },
        ),
        detach: Effect.fn("ProviderSessionManager.detach")(
          function* (input) {
            const key = sessionKey(input.providerSessionId);
            const currentEntry = (yield* Ref.get(sessions)).get(key);
            let detachedProviderThreads: ReadonlyArray<OrchestrationV2ProviderThread> = [];
            if (currentEntry?.supportsMultipleProviderThreads === true) {
              const projection = yield* Effect.option(
                projectionStore.getThreadRecords(input.threadId, [
                  "providerThreads",
                  "providerTurns",
                ]),
              );
              if (Option.isSome(projection)) {
                const providerThreads = new Map(
                  projection.value.providerThreads
                    .filter((thread) => thread.providerSessionId === input.providerSessionId)
                    .map((thread) => [thread.id, thread] as const),
                );
                detachedProviderThreads = [...providerThreads.values()];
                const activeTurns = projection.value.providerTurns.filter(
                  (turn) => turn.status === "running" && providerThreads.has(turn.providerThreadId),
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
            const detachResult = yield* Ref.modify(sessions, (current) => {
              const entry = current.get(key);
              if (entry === undefined || !entry.attachedThreadIds.has(input.threadId)) {
                return [
                  Option.none<{
                    readonly entry: LiveSessionEntry;
                    readonly idleUnloadFiber: Fiber.Fiber<void, never> | null;
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
              const mcpCredentialIdByThread =
                input.revokeMcpCredential === true
                  ? (() => {
                      const pruned = new Map(entry.mcpCredentialIdByThread);
                      pruned.delete(input.threadId);
                      return pruned;
                    })()
                  : entry.mcpCredentialIdByThread;
              const idleThreadUnloads = new Map(entry.idleThreadUnloads);
              idleThreadUnloads.delete(input.threadId);
              const updatedEntry = {
                ...entry,
                attachedThreadIds,
                loadedProviderThreadKeyByThread,
                mcpCredentialIdByThread,
                idleThreadUnloads,
              };
              const updated = new Map(current);
              updated.set(key, updatedEntry);
              return [
                Option.some({
                  entry: updatedEntry,
                  idleUnloadFiber: entry.idleThreadUnloads.get(input.threadId)?.fiber ?? null,
                }),
                updated,
              ] as const;
            });
            if (Option.isSome(detachResult)) {
              yield* cancelIdleFiber(detachResult.value.idleUnloadFiber);
            }
            const detached = Option.map(detachResult, (result) => result.entry);
            // Plain detaches preserve credentials held by live shared providers across workspace handoffs.
            if (input.revokeMcpCredential === true) {
              yield* clearMcpSession(input.threadId);
            }
            if (Option.isNone(detached)) {
              return;
            }
            if (
              detached.value.attachedThreadIds.size === 0 &&
              !detached.value.supportsMultipleProviderThreads
            ) {
              yield* releaseEntry({
                providerSessionId: input.providerSessionId,
                reason: "manual_shutdown",
                ...(input.detail === undefined ? {} : { detail: input.detail }),
                detachedThreadId: input.threadId,
              });
              return;
            }
            const unloadThread = detached.value.exposedRuntime.unloadThread;
            if (detached.value.supportsMultipleProviderThreads && unloadThread !== undefined) {
              // The projection includes native children owned by other app threads;
              // lock each owner so an attached child stays loaded and later attaches wait.
              for (const providerThread of detachedProviderThreads) {
                if (providerThread.nativeThreadRef === null) continue;
                const ownerThreadId = providerThread.appThreadId ?? input.threadId;
                yield* threadAttachment.withLock(
                  threadAttachmentKey({
                    providerSessionId: input.providerSessionId,
                    threadId: ownerThreadId,
                  }),
                  Effect.gen(function* () {
                    const entry = (yield* Ref.get(sessions)).get(key);
                    if (
                      entry?.runtime !== detached.value.runtime ||
                      entry.attachedThreadIds.has(ownerThreadId)
                    ) {
                      return;
                    }
                    yield* unloadThread({ providerThread }).pipe(
                      Effect.timeout(UNLOAD_THREAD_TIMEOUT_MS),
                      Effect.catchCause((cause) =>
                        Effect.logWarning("orchestration-v2.driver-session.detach-unload-failed", {
                          providerSessionId: input.providerSessionId,
                          threadId: ownerThreadId,
                          providerThreadId: providerThread.id,
                          cause,
                        }),
                      ),
                    );
                  }),
                );
              }
            }
            yield* scheduleIdleRelease(input.providerSessionId);
          },
          (effect, input) =>
            effect.pipe(
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
        ),
      } satisfies ProviderSessionManagerV2Shape);
    }),
  );

export const layer = layerWithOptions();
export * from "./ProviderSessionManager-part2.ts";