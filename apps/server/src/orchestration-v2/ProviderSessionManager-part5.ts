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

import type { ProviderSessionStoreShape, ReleasedBackgroundTasks } from "./ProviderSessionManager-part4.ts";

export const makeProviderSessionReleaseShape = Effect.fn(
  "ProviderSessionManager.makeReleaseShape",
)(function* (store: ProviderSessionStoreShape) {
    const {
      sessions,
      sessionOpen,
      releaseRecordRetries,
      cancelIdleFiber,
      failSubscribers,
      interruptSubscribers,
      endSubscribers,
      readReleasedBackgroundTasks,
      writeReleasedSessionEvents,
      writeReleasedRuntimeRequestEvents,
      writeReleasedBackgroundWorkEvents,
      isMcpCredentialReserved,
      clearMcpSession,
    } = store;
    const sessionKey = (providerSessionId: ProviderSessionId): string =>
      String(providerSessionId);

      const writeReleaseRecords = (input: {
        readonly entry: LiveSessionEntry;
        readonly reason: ProviderSessionReleaseReason;
        readonly detail?: string;
        readonly releasedBackgroundTasks: ReadonlyArray<ReleasedBackgroundTasks>;
        readonly releasedAt: DateTime.Utc;
        readonly replaced: boolean;
      }) =>
        Effect.all(
          [
            input.replaced
              ? Effect.succeed(Exit.void)
              : Effect.exit(writeReleasedSessionEvents(input)),
            Effect.exit(
              writeReleasedRuntimeRequestEvents(input).pipe(
                input.entry.requestEventPermit.withPermits(1),
              ),
            ),
            Effect.exit(writeReleasedBackgroundWorkEvents(input.releasedBackgroundTasks)),
          ],
          { concurrency: 1 },
        ).pipe(Effect.flatMap(Exit.asVoidAll));

      // Retry after removal from the live map; later releases cannot clear stale ready sessions and approvals.
      const retryReleaseRecords = (
        input: Omit<Parameters<typeof writeReleaseRecords>[0], "replaced">,
      ) => {
        const providerSessionId = input.entry.runtime.providerSessionId;
        const attempt = Effect.gen(function* () {
          const exit = yield* Effect.exit(
            sessionOpen.withLock(
              providerSessionId,
              Effect.gen(function* () {
                const replaced = (yield* Ref.get(sessions)).has(sessionKey(providerSessionId));
                yield* writeReleaseRecords({ ...input, replaced });
              }),
            ),
          );
          if (Exit.isSuccess(exit) || Cause.hasInterruptsOnly(exit.cause)) return yield* exit;
          yield* Effect.logWarning("orchestration-v2.provider-session-release-records-failed", {
            providerSessionId,
            cause: exit.cause,
          });
          // SQL commit failures are defects; retry every cause except interruption.
          return yield* Effect.fail(exit.cause);
        });
        return attempt.pipe(
          Effect.retry({
            schedule: Schedule.exponential("1 second").pipe(
              Schedule.modifyDelay(({ duration }) =>
                Effect.succeed(Duration.min(duration, Duration.seconds(30))),
              ),
            ),
          }),
          Effect.delay("1 second"),
          FiberSet.run(releaseRecordRetries),
        );
      };

      const logReleaseFailure =
        (providerSessionId: ProviderSessionId) =>
        <E, R>(release: Effect.Effect<void, E, R>) =>
          release.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("orchestration-v2.provider-session-release-failed", {
                providerSessionId,
                cause,
              }),
            ),
          );
      // A request the event pump is persisting for this runtime lands before
      // the cutoff, and once the entry is gone the pump persists no more for
      // it.
      const removeLiveEntry = Effect.fn("ProviderSessionManager.removeLiveEntry")(
        function* (input: {
          readonly providerSessionId: ProviderSessionId;
          readonly onlyIfIdleGeneration?: number;
          readonly keepIfBusyOtherThan?: ReadonlyArray<ProviderThreadId>;
        }): Effect.fn.Return<readonly [Option.Option<LiveSessionEntry>, DateTime.Utc]> {
          const key = sessionKey(input.providerSessionId);
          const candidate = (yield* Ref.get(sessions)).get(key);
          if (candidate === undefined) {
            return [Option.none<LiveSessionEntry>(), yield* DateTime.now] as const;
          }
          const removed = yield* Effect.zip(
            Ref.modify(sessions, (current) => {
              const existing = current.get(key);
              if (existing !== candidate) {
                return [existing === undefined ? "gone" : "changed", current] as const;
              }
              if (
                input.onlyIfIdleGeneration !== undefined &&
                (existing.busyTurns.size > 0 ||
                  existing.idleGeneration !== input.onlyIfIdleGeneration)
              ) {
                return ["kept", current] as const;
              }
              const own = input.keepIfBusyOtherThan;
              if (
                own !== undefined &&
                [...existing.busyTurns].some(
                  (turnKey) => !own.some((id) => turnKey.startsWith(busyTurnPrefix(id))),
                )
              ) {
                return ["kept", current] as const;
              }
              const updated = new Map(current);
              updated.delete(key);
              return ["removed", updated] as const;
            }),
            DateTime.now,
          ).pipe(candidate.requestEventPermit.withPermits(1));
          const [outcome, releasedAt] = removed;
          if (outcome === "changed") return yield* removeLiveEntry(input);
          return [
            outcome === "removed" ? Option.some(candidate) : Option.none<LiveSessionEntry>(),
            releasedAt,
          ] as const;
        },
      );

      // Scope close can wedge on a misbehaving adapter finalizer (e.g. a
      // provider process that never yields its message stream).
      const closeScopeWithin = Effect.fn("ProviderSessionManager.closeScopeWithin")(function* (
        scope: Scope.Closeable,
        annotations: { readonly providerSessionId?: ProviderSessionId; readonly reason: string },
      ) {
        const closeFiber = yield* Scope.close(scope, Exit.void).pipe(
          Effect.exit,
          Effect.forkDetach({ startImmediately: true }),
        );
        const closeExit = yield* Fiber.join(closeFiber).pipe(
          Effect.timeoutOption(RELEASE_SCOPE_CLOSE_TIMEOUT_MS),
        );
        if (Option.isNone(closeExit)) {
          yield* Effect.logWarning("orchestration-v2.provider-session-scope-close-timeout", {
            ...annotations,
            timeoutMs: RELEASE_SCOPE_CLOSE_TIMEOUT_MS,
          });
          yield* Fiber.join(closeFiber).pipe(
            Effect.flatMap((exit) =>
              Exit.isFailure(exit)
                ? Effect.logWarning("orchestration-v2.provider-session-scope-close-failed", {
                    ...annotations,
                    cause: exit.cause,
                  })
                : Effect.logInfo(
                    "orchestration-v2.provider-session-scope-close-completed-late",
                    annotations,
                  ),
            ),
            Effect.forkDetach,
          );
        }
        return closeExit;
      });
      const releaseEntry = (input: {
        readonly providerSessionId: ProviderSessionId;
        readonly reason: ProviderSessionReleaseReason;
        readonly detail?: string;
        readonly detachedThreadId?: ThreadId;
        readonly cancelIdleFiber?: boolean;
        readonly onlyIfIdleGeneration?: number;
        readonly keepIfBusyOtherThan?: ReadonlyArray<ProviderThreadId>;
        readonly gracefulSubscribers?: boolean;
      }) =>
        Effect.acquireUseRelease(
          removeLiveEntry(input),
          ([entry, releasedAt]) =>
            Option.match(entry, {
              onNone: () => Effect.void,
              onSome: (entry) =>
                Effect.gen(function* () {
                  const releasedBackgroundTasks = yield* readReleasedBackgroundTasks({
                    entry,
                    reason: input.reason,
                    ...(input.detachedThreadId === undefined
                      ? {}
                      : { detachedThreadId: input.detachedThreadId }),
                  });
                  if (input.cancelIdleFiber !== false) {
                    yield* cancelIdleFiber(entry.idleFiber);
                  }
                  if (input.gracefulSubscribers === true) {
                    yield* endSubscribers(entry);
                  } else if (input.reason === "server_shutdown") {
                    yield* interruptSubscribers(entry);
                  } else {
                    yield* failSubscribers(
                      entry,
                      input.detail ?? `Provider session released: ${input.reason}.`,
                    );
                  }
                  const closeExit = yield* closeScopeWithin(entry.scope, {
                    providerSessionId: input.providerSessionId,
                    reason: input.reason,
                  });
                  const records = {
                    entry,
                    reason: input.reason,
                    ...(input.detail === undefined ? {} : { detail: input.detail }),
                    releasedBackgroundTasks,
                    releasedAt,
                  };
                  const recorded = yield* Effect.exit(
                    writeReleaseRecords({ ...records, replaced: false }),
                  );
                  if (Exit.isFailure(recorded)) {
                    yield* retryReleaseRecords(records);
                    return yield* recorded;
                  }
                  if (Option.isSome(closeExit) && Exit.isFailure(closeExit.value)) {
                    return yield* Effect.failCause(closeExit.value.cause);
                  }
                }).pipe(
                  withMetrics({
                    counter: providerSessionsTotal,
                    attributes: {
                      provider: entry.runtime.driver,
                      operation: "release",
                      reason: input.reason,
                    },
                  }),
                ),
            }),
          ([entry]) =>
            Option.match(entry, {
              onNone: () => Effect.void,
              onSome: (entry) =>
                // Revoke recorded credentials after process death, except those held by live replacements.
                Ref.get(sessions).pipe(
                  Effect.flatMap((current) =>
                    Effect.forEach(
                      entry.mcpCredentialIdByThread,
                      ([threadId, mcpCredentialId]) => {
                        // Only holders of this credential may prevent its revocation; stale credentials must not leak it.
                        const heldElsewhere =
                          isMcpCredentialReserved(threadId, mcpCredentialId) ||
                          Array.from(current.values()).some(
                            (other) =>
                              other !== entry &&
                              (other.attachedThreadIds.has(threadId) ||
                                other.mcpCredentialIdByThread.get(threadId) === mcpCredentialId),
                          );
                        return heldElsewhere
                          ? Effect.void
                          : clearMcpSession(threadId, mcpCredentialId);
                      },
                      { discard: true },
                    ),
                  ),
                ),
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

    return {
      writeReleaseRecords,
      retryReleaseRecords,
      logReleaseFailure,
      removeLiveEntry,
      closeScopeWithin,
      releaseEntry,
    } as const;
  });

export type ProviderSessionReleaseShape = Effect.Success<
  ReturnType<typeof makeProviderSessionReleaseShape>
>;

export type { ReleasedBackgroundTasks };
