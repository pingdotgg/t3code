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

import type { ProviderSessionStoreShape } from "./ProviderSessionManager-part4.ts";
import type { ProviderSessionReleaseShape } from "./ProviderSessionManager-part5.ts";
import type { ProviderSessionAttachShape } from "./ProviderSessionManager-part6.ts";

export const makeProviderRuntimeShape = Effect.fn("ProviderSessionManager.makeRuntimeShape")(
  function* (
    store: ProviderSessionStoreShape,
    release: ProviderSessionReleaseShape,
    attach: ProviderSessionAttachShape,
  ) {
    const layerScope = yield* Effect.scope;
    const commandOutput = yield* CommandOutputHub.CommandOutputHub;
    const providerEventIngestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
    const {
      sessions,
      shutdownSignal,
      nextSubscriberId,
      publishToSubscribers,
      writeProviderSessionEvents,
    } = store;
    const {
      observeActivity,
      ensureThreadAttached,
      holdThreadLoaded,
      isProviderThreadLoaded,
      markProviderThreadLoaded,
      markBusy,
      markIdle,
      touchActivity,
    } = attach;
    const { releaseEntry, logReleaseFailure } = release;
    const sessionKey = (providerSessionId: ProviderSessionId): string =>
      String(providerSessionId);

      const makeEventSubscription = Effect.fn("ProviderSessionManager.makeEventSubscription")(
        function* (
          subscribers: Ref.Ref<
            ReadonlyMap<number, Queue.Queue<ProviderSessionEventSignal, Cause.Done>>
          >,
        ): Effect.fn.Return<ProviderAdapter.ProviderAdapterV2EventSubscription> {
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
          return { events, close } satisfies ProviderAdapter.ProviderAdapterV2EventSubscription;
        },
      );

      const decorateRuntime = (
        runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime,
        eventSubscribers: Ref.Ref<
          ReadonlyMap<number, Queue.Queue<ProviderSessionEventSignal, Cause.Done>>
        >,
      ): ProviderAdapter.ProviderAdapterV2SessionRuntime => {
        const providerSessionId = runtime.providerSessionId;
        const subscribeEvents = makeEventSubscription(eventSubscribers);
        const turnMetrics = (operation: string, model?: string) =>
          withMetrics({
            counter: providerTurnsTotal,
            ...(operation === "send" ? { timer: providerTurnDuration } : {}),
            attributes: {
              provider: runtime.driver,
              operation,
              modelFamily: normalizeModelMetricLabel(model),
            },
          });
        return {
          ...runtime,
          subscribeEvents,
          events: Stream.unwrap(
            subscribeEvents.pipe(Effect.map((subscription) => subscription.events)),
          ),
          ensureThread: (input) =>
            observeActivity(
              providerSessionId,
              ensureThreadAttached({
                providerSessionId,
                threadId: input.threadId,
                providerInstanceId: runtime.instanceId,
              }),
            ).pipe(
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
                }),
              ),
            ),
          resumeThread: (input) => {
            const threadId = input.threadId ?? input.providerThread.appThreadId;
            if (threadId === null || threadId === undefined) {
              return runtime.resumeThread(input);
            }
            const providerThreadKey = providerThreadLoadKey({
              providerThread: input.providerThread,
              ...(input.modelSelection === undefined
                ? {}
                : { modelSelection: input.modelSelection }),
              ...(input.runtimePolicy === undefined ? {} : { runtimePolicy: input.runtimePolicy }),
            });
            return observeActivity(
              providerSessionId,
              ensureThreadAttached({
                providerSessionId,
                threadId,
                providerInstanceId: runtime.instanceId,
              }),
            ).pipe(
              Effect.andThen(
                holdThreadLoaded({
                  providerSessionId,
                  threadId,
                  providerThread: input.providerThread,
                }),
              ),
              Effect.andThen(
                isProviderThreadLoaded({ providerSessionId, threadId, providerThreadKey }),
              ),
              Effect.flatMap((loaded) =>
                loaded ? Effect.succeed(input.providerThread) : runtime.resumeThread(input),
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
                }),
              ),
            );
          },
          forkThread: (input) =>
            observeActivity(
              providerSessionId,
              ensureThreadAttached({
                providerSessionId,
                threadId: input.targetThreadId,
                providerInstanceId: runtime.instanceId,
              }),
            ).pipe(
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
                }),
              ),
            ),
          startTurn: (input) =>
            observeActivity(
              providerSessionId,
              ensureThreadAttached({
                providerSessionId,
                threadId: input.threadId,
                providerInstanceId: runtime.instanceId,
              }),
            ).pipe(
              // Failed or stopped starts may omit turn.terminal; clear their turns so sessions can idle.
              Effect.andThen(
                holdThreadLoaded({
                  providerSessionId,
                  threadId: input.threadId,
                  providerThread: input.providerThread,
                }),
              ),
              Effect.andThen(
                Effect.acquireUseRelease(
                  markBusy(
                    providerSessionId,
                    busyTurnKey(input.providerThread.id, input.runOrdinal),
                    runtime,
                  ).pipe(
                    Effect.catchCause((cause) =>
                      Effect.logWarning("orchestration-v2.driver-session.activity-failed", {
                        providerSessionId,
                        cause,
                      }).pipe(Effect.as(true)),
                    ),
                    // A release between attach and markBusy leaves nothing to mark: fail the
                    // start instead of running it on a runtime being torn down.
                    Effect.flatMap((marked) =>
                      marked
                        ? Effect.void
                        : Effect.fail(
                            new ProviderAdapter.ProviderAdapterTurnStartError({
                              driver: runtime.driver,
                              threadId: input.threadId,
                              providerThreadId: input.providerThread.id,
                              runId: input.runId,
                              cause: "The provider session was released while the turn started.",
                            }),
                          ),
                    ),
                  ),
                  () =>
                    runtime.startTurn(input).pipe(turnMetrics("send", input.modelSelection.model)),
                  (_, exit) =>
                    Exit.isFailure(exit)
                      ? observeActivity(
                          providerSessionId,
                          markIdle(providerSessionId, input.providerThread.id, input.runOrdinal),
                        )
                      : Effect.void,
                ),
              ),
            ),
          steerTurn: (input) =>
            observeActivity(providerSessionId, touchActivity(providerSessionId)).pipe(
              Effect.andThen(runtime.steerTurn(input).pipe(turnMetrics("steer"))),
            ),
          // A provider starved of memory can stop answering, so no caller may wait on it unbounded.
          interruptTurn: (input) =>
            observeActivity(providerSessionId, touchActivity(providerSessionId)).pipe(
              Effect.andThen(
                runtime.interruptTurn(input).pipe(
                  Effect.timeoutOrElse({
                    duration: PROVIDER_INTERRUPT_TIMEOUT_MS,
                    orElse: () =>
                      Effect.fail(
                        new ProviderAdapter.ProviderAdapterInterruptTimeoutError({
                          driver: runtime.driver,
                          providerThreadId: input.providerThread.id,
                          providerTurnId: input.providerTurnId,
                          timeoutMs: PROVIDER_INTERRUPT_TIMEOUT_MS,
                        }),
                      ),
                  }),
                  turnMetrics("interrupt"),
                ),
              ),
            ),
          respondToRuntimeRequest: (input) =>
            observeActivity(providerSessionId, touchActivity(providerSessionId)).pipe(
              Effect.andThen(
                runtime
                  .respondToRuntimeRequest(input)
                  .pipe(turnMetrics("runtime-request-response")),
              ),
            ),
        };
      };
      const persistProviderSessionUpdate = Effect.fn(
        "ProviderSessionManager.persistProviderSessionUpdate",
      )(
        function* (
          entry: LiveSessionEntry,
          event: Extract<
            ProviderAdapter.ProviderAdapterV2Event,
            { readonly type: "provider_session.updated" }
          >,
        ) {
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
        },
        (effect, entry, _event) =>
          effect.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("orchestration-v2.driver-session.status-persist-failed", {
                providerSessionId: entry.runtime.providerSessionId,
                cause,
              }),
            ),
          ),
      );

      const startEventPump = (entry: LiveSessionEntry) => {
        let stoppedByProvider = false;
        return entry.runtime.events.pipe(
          Stream.runForEach((event) => {
            if (shutdownSignal.received) return Effect.void;
            // Live output bypasses persistence and subscribers so floods cannot delay domain events.
            if (event.type === "command_output.delta") {
              return commandOutput.append(event);
            }
            const releaseLiveOutput =
              event.type === "turn_item.updated" &&
              event.turnItem.type === "command_execution" &&
              !isOrchestrationV2WorkActive(event.turnItem.status)
                ? commandOutput.finish({
                    threadId: event.turnItem.threadId,
                    itemId: event.turnItem.id,
                  })
                : Effect.void;
            if (
              event.type === "provider_session.updated" &&
              event.providerSession.status === "stopped"
            ) {
              stoppedByProvider = true;
            }
            return observeActivity(
              entry.runtime.providerSessionId,
              event.type === "turn.terminal"
                ? markIdle(
                    entry.runtime.providerSessionId,
                    event.providerThreadId,
                    event.runOrdinal,
                  )
                : touchActivity(entry.runtime.providerSessionId, { providerActivity: true }),
            ).pipe(
              Effect.andThen(
                event.type === "provider_session.updated"
                  ? persistProviderSessionUpdate(entry, event)
                  : Effect.void,
              ),
              Effect.andThen(
                Effect.gen(function* () {
                  if (
                    event.type === "provider_thread.updated" &&
                    event.providerThread.status === "error"
                  ) {
                    const threadId = event.providerThread.appThreadId;
                    yield* Ref.update(sessions, (sessions) => {
                      const key = sessionKey(entry.runtime.providerSessionId);
                      const latest = sessions.get(key);
                      if (latest?.runtime !== entry.runtime || threadId === null) return sessions;
                      const loadedProviderThreadKeyByThread = new Map(
                        latest.loadedProviderThreadKeyByThread,
                      );
                      loadedProviderThreadKeyByThread.delete(threadId);
                      return new Map(sessions).set(key, {
                        ...latest,
                        loadedProviderThreadKeyByThread,
                      });
                    });
                  }
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
                              new ProviderAdapter.ProviderAdapterEventStreamError({
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
                  yield* releaseLiveOutput;
                }),
              ),
            );
          }),
          Effect.exit,
          Effect.flatMap((exit) =>
            Effect.gen(function* () {
              if (shutdownSignal.received) return;
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
                }).pipe(logReleaseFailure(entry.runtime.providerSessionId));
                return;
              }
              // Subscribers read an interrupt as server shutdown, so keep it for that.
              const cause =
                Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)
                  ? exit.cause
                  : Cause.fail(
                      new ProviderAdapter.ProviderAdapterEventStreamError({
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
              // lastError is the thread banner, so it gets the same bounded
              // message as a failed turn; the raw cause survives only in the log.
              yield* Effect.logWarning("orchestration-v2.provider-session-runtime-failed", {
                providerSessionId: entry.runtime.providerSessionId,
                cause,
              });
              yield* releaseEntry({
                providerSessionId: entry.runtime.providerSessionId,
                reason: "runtime_error",
                detail: makeProviderFailure({ cause }).message,
              }).pipe(logReleaseFailure(entry.runtime.providerSessionId));
            }),
          ),
          Effect.forkIn(layerScope),
        );
      };

    return {
      makeEventSubscription,
      decorateRuntime,
      persistProviderSessionUpdate,
      startEventPump,
    } as const;
  });

export type ProviderSessionRuntimeShape = Effect.Success<
  ReturnType<typeof makeProviderRuntimeShape>
>;

export type { ProviderSessionStoreShape };
