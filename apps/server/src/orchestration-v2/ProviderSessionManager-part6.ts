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

import type { PreparedMcpCredential, ProviderSessionStoreShape } from "./ProviderSessionManager-part4.ts";
import type { ProviderSessionReleaseShape } from "./ProviderSessionManager-part5.ts";

export const makeProviderSessionAttachShape = Effect.fn("ProviderSessionManager.makeAttachShape")(
  function* (store: ProviderSessionStoreShape, release: ProviderSessionReleaseShape) {
    const layerScope = yield* Effect.scope;
    const {
      sessions,
      sessionOpen,
      threadAttachment,
      threadAttachmentKey,
      idleTimeoutMs,
      maxIdlePinMs,
      prepareMcpSession,
      dropMcpCredentialReservation,
      isMcpCredentialReserved,
      clearMcpSession,
      cancelIdleFiber,
      writeProviderSessionEvents,
    } = store;
    const { releaseEntry } = release;
    const sessionKey = (providerSessionId: ProviderSessionId): string =>
      String(providerSessionId);
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

      // Provider activity restarts the pin budget, so background work that keeps
      // reporting progress (a long Claude workflow) is never cut off; only work
      // that went silent for maxIdlePinMs is released. This runs for every
      // provider event, so keep it untraced.
      const scheduleIdleReleaseInternal = Effect.fnUntraced(function* (
        providerSessionId: ProviderSessionId,
        options?: { readonly providerActivity?: boolean },
      ) {
        const key = sessionKey(providerSessionId);
        const current = yield* Ref.get(sessions);
        const entry = current.get(key);
        if (entry === undefined || entry.busyTurns.size > 0) {
          return;
        }

        yield* cancelIdleFiber(entry.idleFiber);
        const generation = entry.idleGeneration + 1;
        const idleFiber = yield* Effect.sleep(Duration.millis(idleTimeoutMs)).pipe(
          Effect.andThen(releaseIfStillIdle({ providerSessionId, generation })),
          Effect.forkIn(layerScope),
        );
        yield* Ref.update(sessions, (latest) => {
          const latestEntry = latest.get(key);
          if (latestEntry === undefined || latestEntry.busyTurns.size > 0) {
            return latest;
          }
          const updated = new Map(latest);
          updated.set(key, {
            ...latestEntry,
            idleGeneration: generation,
            idleFiber,
            ...(options?.providerActivity === true ? { pinnedSinceMs: null } : {}),
          });
          return updated;
        });
      });

      const scheduleIdleRelease = (providerSessionId: ProviderSessionId) =>
        withActivityError(providerSessionId, scheduleIdleReleaseInternal(providerSessionId));

      const touchActivity = (
        providerSessionId: ProviderSessionId,
        options?: { readonly providerActivity?: boolean },
      ) =>
        withActivityError(
          providerSessionId,
          scheduleIdleReleaseInternal(providerSessionId, options),
        );
      const releaseIfStillIdle = Effect.fn("ProviderSessionManager.releaseIfStillIdle")(
        function* (input: {
          readonly providerSessionId: ProviderSessionId;
          readonly generation: number;
        }): Effect.fn.Return<void> {
          const current = yield* Ref.get(sessions);
          const key = sessionKey(input.providerSessionId);
          const entry = current.get(key);
          if (
            entry === undefined ||
            entry.busyTurns.size > 0 ||
            entry.idleGeneration !== input.generation
          ) {
            return;
          }
          // Capture runtime identity before yielding; replacements can reuse the session id.
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
                  latestEntry.busyTurns.size > 0 ||
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
                return;
              }
              yield* Effect.logInfo("orchestration-v2.driver-session.idle-release-deferred", {
                providerSessionId: input.providerSessionId,
                pinnedForMs: now - pinnedSinceMs,
              });
              // Recheck on this fiber; scheduleIdleReleaseInternal would interrupt it and self-deadlock.
              yield* Effect.sleep(Duration.millis(idleTimeoutMs));
              return yield* releaseIfStillIdle(input);
            }
            yield* Effect.logWarning("orchestration-v2.driver-session.idle-release-pin-expired", {
              providerSessionId: input.providerSessionId,
              pinnedForMs: now - pinnedSinceMs,
            });
          }
          // Adapter probes yield; guard busyTurns and idleGeneration atomically when removing the entry.
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
        },
      );
      const attachThread = (input: {
        readonly providerSessionId: ProviderSessionId;
        readonly threadId: ThreadId;
      }) =>
        withActivityError(
          input.providerSessionId,
          Ref.modify(sessions, (current) => {
            const entry = current.get(sessionKey(input.providerSessionId));
            if (entry === undefined || entry.attachedThreadIds.has(input.threadId)) {
              return [undefined, current] as const;
            }
            const updated = new Map(current);
            updated.set(sessionKey(input.providerSessionId), {
              ...entry,
              attachedThreadIds: new Set([...entry.attachedThreadIds, input.threadId]),
            });
            return [entry.runtime, updated] as const;
          }),
        );

      const removeThreadAttachment = (input: {
        readonly providerSessionId: ProviderSessionId;
        readonly threadId: ThreadId;
        readonly runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime;
      }) =>
        Ref.update(sessions, (current) => {
          const key = sessionKey(input.providerSessionId);
          const entry = current.get(key);
          if (
            entry === undefined ||
            entry.runtime !== input.runtime ||
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
      }) =>
        Ref.get(sessions).pipe(
          Effect.map(
            (current) =>
              current
                .get(sessionKey(input.providerSessionId))
                ?.loadedProviderThreadKeyByThread.get(input.threadId) === input.providerThreadKey,
          ),
        );

      const markProviderThreadLoaded = (input: {
        readonly providerSessionId: ProviderSessionId;
        readonly threadId: ThreadId;
        readonly providerThreadKey: string;
      }) =>
        Ref.update(sessions, (current) => {
          const key = sessionKey(input.providerSessionId);
          const entry = current.get(key);
          if (entry === undefined) {
            return current;
          }
          const loadedProviderThreadKeyByThread = new Map(entry.loadedProviderThreadKeyByThread);
          loadedProviderThreadKeyByThread.set(input.threadId, input.providerThreadKey);
          const updated = new Map(current);
          updated.set(key, { ...entry, loadedProviderThreadKeyByThread });
          return updated;
        });

      const ensureThreadAttached = (input: {
        readonly providerSessionId: ProviderSessionId;
        readonly threadId: ThreadId;
        readonly providerInstanceId: ProviderInstanceId;
      }) =>
        Effect.suspend(() => {
          let attachedTo: ProviderAdapter.ProviderAdapterV2SessionRuntime | undefined;
          let preparedForCleanup: PreparedMcpCredential | undefined;
          let reservationDropped = false;
          const dropReservation = () => {
            if (!reservationDropped && preparedForCleanup?.mcpCredentialId !== undefined) {
              reservationDropped = true;
              dropMcpCredentialReservation(input.threadId, preparedForCleanup.mcpCredentialId);
            }
          };
          // Lock attach through rollback so concurrent attaches cannot observe an attachment about to be undone.
          const attach = Effect.gen(function* () {
            const attached = yield* attachThread(input).pipe(
              // Record without interruption so cleanup undoes only this call's attachment.
              Effect.tap((runtime) => Effect.sync(() => (attachedTo = runtime))),
              Effect.uninterruptible,
            );
            if (attached !== undefined) {
              const prepared = yield* prepareMcpSession(input.threadId, input.providerInstanceId);
              preparedForCleanup = prepared;
              if (prepared.mcpCredentialId !== undefined) {
                const mcpCredentialId = prepared.mcpCredentialId;
                yield* Ref.update(sessions, (current) => {
                  const key = sessionKey(input.providerSessionId);
                  const entry = current.get(key);
                  if (entry === undefined) return current;
                  const mcpCredentialIdByThread = new Map(entry.mcpCredentialIdByThread);
                  mcpCredentialIdByThread.set(input.threadId, mcpCredentialId);
                  const updated = new Map(current);
                  updated.set(key, { ...entry, mcpCredentialIdByThread });
                  return updated;
                });
              }
              const entry = (yield* Ref.get(sessions)).get(sessionKey(input.providerSessionId));
              if (entry !== undefined) {
                yield* withActivityError(
                  input.providerSessionId,
                  writeProviderSessionEvents({
                    runtime: entry.runtime,
                    threadIds: [input.threadId],
                    type: "provider-session.attached",
                    payload: entry.runtime.providerSession,
                  }),
                );
              }
            }
          }).pipe(
            Effect.onError(() =>
              attachedTo === undefined
                ? Effect.void
                : removeThreadAttachment({ ...input, runtime: attachedTo }).pipe(
                    Effect.andThen(
                      Effect.suspend(() => {
                        dropReservation();
                        // Other live processes hold reused MCP credentials; revocation would break their clients.
                        if (preparedForCleanup?.issued !== true) return Effect.void;
                        const mcpCredentialId = preparedForCleanup.mcpCredentialId;
                        const attachedRuntime = attachedTo;
                        return Ref.get(sessions).pipe(
                          Effect.flatMap((current) =>
                            (mcpCredentialId !== undefined &&
                              isMcpCredentialReserved(input.threadId, mcpCredentialId)) ||
                            Array.from(current.values()).some(
                              (other) =>
                                other.runtime !== attachedRuntime &&
                                (other.attachedThreadIds.has(input.threadId) ||
                                  (mcpCredentialId !== undefined &&
                                    other.mcpCredentialIdByThread.get(input.threadId) ===
                                      mcpCredentialId)),
                            )
                              ? Effect.void
                              : clearMcpSession(input.threadId, mcpCredentialId),
                          ),
                        );
                      }),
                    ),
                  ),
            ),
          );
          return threadAttachment
            .withLock(threadAttachmentKey(input), attach)
            .pipe(Effect.ensuring(Effect.sync(dropReservation)));
        });
      // Marks only the entry this runtime belongs to: a released or replaced session must not
      // gain a busy turn that never ends. Succeeds with whether the turn was marked.
      const markBusy = (
        providerSessionId: ProviderSessionId,
        turnKey: string,
        runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime,
      ) =>
        withActivityError(
          providerSessionId,
          Effect.gen(function* () {
            const key = sessionKey(providerSessionId);
            const marked = yield* Ref.modify(sessions, (current) => {
              const entry = current.get(key);
              if (entry === undefined || entry.runtime !== runtime) {
                return [undefined, current] as const;
              }
              const updated = new Map(current);
              updated.set(key, {
                ...entry,
                busyTurns: new Set(entry.busyTurns).add(turnKey),
                idleFiber: null,
                pinnedSinceMs: null,
              });
              return [{ idleFiber: entry.idleFiber }, updated] as const;
            });
            if (marked === undefined) return false;
            yield* cancelIdleFiber(marked.idleFiber);
            return true;
          }),
        );

      const markIdle = (
        providerSessionId: ProviderSessionId,
        providerThreadId: ProviderThreadId,
        runOrdinal: number,
      ) =>
        withActivityError(
          providerSessionId,
          Effect.gen(function* () {
            const key = sessionKey(providerSessionId);
            yield* Ref.update(sessions, (current) => {
              const entry = current.get(key);
              if (entry === undefined) {
                return current;
              }
              const busyTurns = new Set(entry.busyTurns);
              busyTurns.delete(busyTurnKey(providerThreadId, runOrdinal));
              const updated = new Map(current);
              updated.set(key, {
                ...entry,
                busyTurns,
              });
              return updated;
            });
            yield* scheduleIdleReleaseInternal(providerSessionId);
            yield* scheduleThreadUnload(providerSessionId, providerThreadId);
          }),
        );

      const hasBusyTurn = (entry: LiveSessionEntry, providerThreadId: ProviderThreadId) => {
        const prefix = busyTurnPrefix(providerThreadId);
        for (const turnKey of entry.busyTurns) {
          if (turnKey.startsWith(prefix)) return true;
        }
        return false;
      };
      const updateIdleThreadUnload = (
        providerSessionId: ProviderSessionId,
        threadId: ThreadId,
        update: (current: IdleThreadUnload | undefined) => IdleThreadUnload | undefined,
      ) =>
        Ref.modify(sessions, (current) => {
          const key = sessionKey(providerSessionId);
          const entry = current.get(key);
          if (entry === undefined) return [undefined, current] as const;
          const previous = entry.idleThreadUnloads.get(threadId);
          const next = update(previous);
          const idleThreadUnloads = new Map(entry.idleThreadUnloads);
          if (next === undefined) idleThreadUnloads.delete(threadId);
          else idleThreadUnloads.set(threadId, next);
          const updated = new Map(current);
          updated.set(key, { ...entry, idleThreadUnloads });
          return [previous, updated] as const;
        });

      /**
       * Called before the thread is resumed or given a turn, so an unload
       * cannot land between a resume that found the thread loaded and the turn
       * that relies on it.
       */
      const holdThreadLoaded = Effect.fn("ProviderSessionManager.holdThreadLoaded")(
        function* (input: {
          readonly providerSessionId: ProviderSessionId;
          readonly threadId: ThreadId;
          readonly providerThread: OrchestrationV2ProviderThread;
        }) {
          const entry = (yield* Ref.get(sessions)).get(sessionKey(input.providerSessionId));
          if (
            entry === undefined ||
            !entry.supportsMultipleProviderThreads ||
            entry.exposedRuntime.unloadThread === undefined ||
            input.providerThread.nativeThreadRef === null
          ) {
            return;
          }
          const previous = yield* updateIdleThreadUnload(
            input.providerSessionId,
            input.threadId,
            (current) => ({
              providerThread: input.providerThread,
              generation: (current?.generation ?? 0) + 1,
              fiber: null,
            }),
          );
          yield* cancelIdleFiber(previous?.fiber ?? null);
        },
      );

      const scheduleThreadUnload = Effect.fn("ProviderSessionManager.scheduleThreadUnload")(
        function* (providerSessionId: ProviderSessionId, providerThreadId: ProviderThreadId) {
          const entry = (yield* Ref.get(sessions)).get(sessionKey(providerSessionId));
          if (entry === undefined || hasBusyTurn(entry, providerThreadId)) return;
          const tracked = Array.from(entry.idleThreadUnloads).find(
            ([, pending]) => pending.providerThread.id === providerThreadId,
          );
          if (tracked === undefined) return;
          const [threadId, pending] = tracked;
          const generation = pending.generation + 1;
          const fiber = yield* Effect.sleep(Duration.millis(idleTimeoutMs)).pipe(
            Effect.andThen(unloadIdleThread({ providerSessionId, threadId, generation })),
            Effect.forkIn(layerScope),
          );
          const previous = yield* updateIdleThreadUnload(providerSessionId, threadId, (current) =>
            current?.generation === pending.generation
              ? { ...current, generation, fiber }
              : current,
          );
          yield* cancelIdleFiber(
            previous?.generation === pending.generation ? previous.fiber : fiber,
          );
        },
      );

      const unloadIdleThread = Effect.fn("ProviderSessionManager.unloadIdleThread")(
        function* (input: {
          readonly providerSessionId: ProviderSessionId;
          readonly threadId: ThreadId;
          readonly generation: number;
        }): Effect.fn.Return<void> {
          const outcome = yield* threadAttachment.withLock(
            threadAttachmentKey(input),
            Effect.gen(function* () {
              const key = sessionKey(input.providerSessionId);
              const entry = (yield* Ref.get(sessions)).get(key);
              const pending = entry?.idleThreadUnloads.get(input.threadId);
              const unloadThread = entry?.exposedRuntime.unloadThread;
              if (
                entry === undefined ||
                pending === undefined ||
                pending.generation !== input.generation ||
                unloadThread === undefined ||
                !entry.attachedThreadIds.has(input.threadId) ||
                hasBusyTurn(entry, pending.providerThread.id)
              ) {
                return "skipped" as const;
              }
              // Unloading kills background terminals; keep threads with pending work loaded.
              const hasPendingWork =
                entry.runtime.hasPendingBackgroundWorkForThread === undefined
                  ? false
                  : yield* entry.runtime
                      .hasPendingBackgroundWorkForThread(pending.providerThread)
                      .pipe(Effect.catchCause(() => Effect.succeed(false)));
              if (hasPendingWork) return "deferred" as const;
              const unloading = yield* Ref.modify(sessions, (current) => {
                const latest = current.get(key);
                if (
                  latest?.runtime !== entry.runtime ||
                  latest.idleThreadUnloads.get(input.threadId)?.generation !== input.generation
                ) {
                  return [false, current] as const;
                }
                const loadedProviderThreadKeyByThread = new Map(
                  latest.loadedProviderThreadKeyByThread,
                );
                loadedProviderThreadKeyByThread.delete(input.threadId);
                const idleThreadUnloads = new Map(latest.idleThreadUnloads);
                idleThreadUnloads.delete(input.threadId);
                const updated = new Map(current);
                updated.set(key, {
                  ...latest,
                  loadedProviderThreadKeyByThread,
                  idleThreadUnloads,
                });
                return [true, updated] as const;
              });
              if (!unloading) return "skipped" as const;
              yield* unloadThread({ providerThread: pending.providerThread }).pipe(
                Effect.timeout(UNLOAD_THREAD_TIMEOUT_MS),
                Effect.catchCause((cause) =>
                  Effect.logWarning("orchestration-v2.driver-session.idle-unload-failed", {
                    providerSessionId: input.providerSessionId,
                    threadId: input.threadId,
                    providerThreadId: pending.providerThread.id,
                    cause,
                  }),
                ),
              );
              return "unloaded" as const;
            }),
          );
          // Wait outside the lock so the next attach is not blocked.
          if (outcome === "deferred") {
            yield* Effect.sleep(Duration.millis(idleTimeoutMs));
            return yield* unloadIdleThread(input);
          }
        },
      );

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

    return {
      withActivityError,
      touchActivity,
      scheduleIdleRelease,
      attachThread,
      removeThreadAttachment,
      isProviderThreadLoaded,
      markProviderThreadLoaded,
      ensureThreadAttached,
      markBusy,
      markIdle,
      hasBusyTurn,
      holdThreadLoaded,
      scheduleThreadUnload,
      unloadIdleThread,
      observeActivity,
    } as const;
  },
);

export type ProviderSessionAttachShape = Effect.Success<
  ReturnType<typeof makeProviderSessionAttachShape>
>;
