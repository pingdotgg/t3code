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

/** ACP and OpenCode consume credentials during openSession; reserved until publication. */
export interface PreparedMcpCredential {
  readonly mcpCredentialId: string | undefined;
  readonly issued: boolean;
}

/** Entry returned by the session store factory; inferred so no deps object is hand-typed. */
export const makeProviderSessionStoreShape = Effect.fn(
  "ProviderSessionManager.makeStoreShape",
)(function* (options: ProviderSessionManagerV2LayerOptions = {}) {
    const mcpSessionRegistry = yield* McpSessionRegistry.McpSessionRegistry;
    const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
    const serverSettings = yield* Effect.serviceOption(ServerSettings.ServerSettingsService);
    const projectService = yield* Effect.serviceOption(ProjectService.ProjectService);
    const eventSink = yield* EventSink.EventSinkV2;
    const idAllocator = yield* IdAllocator.IdAllocatorV2;
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;

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
      // Group signals stop providers before restart capture; drop post-signal events so recovery owns that state.
      const shutdownSignal = { received: false };
      const onShutdownSignal = () => {
        shutdownSignal.received = true;
      };
      yield* Effect.acquireRelease(
        Effect.sync(() => {
          process.on("SIGINT", onShutdownSignal);
          process.on("SIGTERM", onShutdownSignal);
        }),
        () =>
          Effect.sync(() => {
            process.off("SIGINT", onShutdownSignal);
            process.off("SIGTERM", onShutdownSignal);
          }),
      );
      const sessions = yield* Ref.make(new Map<string, LiveSessionEntry>());
      // Retry per released entry; reusing ids must not lose cleanup for earlier threads.
      const releaseRecordRetries = yield* FiberSet.make();
      const nextSubscriberId = yield* Ref.make(0);
      const sessionOpen = yield* KeyedLock.make<ProviderSessionId>();
      const threadAttachment = yield* KeyedLock.make<string>();
      const threadAttachmentKey = (input: {
        readonly providerSessionId: ProviderSessionId;
        readonly threadId: ThreadId;
      }) => `${input.providerSessionId}\u0000${input.threadId}`;
      const idleTimeoutMs = Math.max(1, options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS);
      const maxIdlePinMs = Math.max(0, options.maxIdlePinMs ?? DEFAULT_MAX_IDLE_PIN_MS);
      /** ACP and OpenCode consume credentials during openSession; reserve them against revocation until publication. */
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
      const mcpPrepareLock = yield* KeyedLock.make<ThreadId>();
      const prepareMcpSession = (
        threadId: ThreadId,
        providerInstanceId: ProviderInstanceId,
      ): Effect.Effect<PreparedMcpCredential> =>
        options.configureMcp === false
          ? mcpSessions
              .clear(threadId)
              .pipe(Effect.as<PreparedMcpCredential>({ mcpCredentialId: undefined, issued: false }))
          : mcpPrepareLock.withLock(
              threadId,
              Effect.gen(function* () {
                // Live providers build MCP clients once; reuse credentials across workspace handoffs.
                const { browser: browserToolsAvailable, device: deviceToolsAvailable } =
                  yield* agentAccessSettings(threadId);
                const capabilities = new Set<
                  import("../mcp/McpInvocationContext.ts").McpCapability
                >(["orchestration", "worktree", "pull-requests"]);
                if (browserToolsAvailable) capabilities.add("preview");
                if (deviceToolsAvailable) capabilities.add("device");
                const subagent = yield* projectionStore.getThread(threadId).pipe(
                  Effect.map((thread) => thread.lineage.relationshipToParent === "subagent"),
                  Effect.orElseSucceed(() => false),
                );
                const existing = yield* mcpSessions.read(threadId);
                if (existing !== undefined) {
                  // Reserve before async validation so release cannot revoke between validation and reservation.
                  reserveMcpCredential(threadId, existing.providerSessionId);
                  const rawToken = existing.authorizationHeader.replace(/^Bearer\s+/, "");
                  // Interrupted resolution must release the reservation before the caller learns of it.
                  const resolved = yield* mcpSessionRegistry
                    .resolve(rawToken)
                    .pipe(
                      Effect.onInterrupt(() =>
                        Effect.sync(() =>
                          dropMcpCredentialReservation(threadId, existing.providerSessionId),
                        ),
                      ),
                    );
                  if (
                    resolved !== undefined &&
                    resolved.thread.threadId === threadId &&
                    resolved.thread.providerInstanceId === providerInstanceId &&
                    resolved.capabilities.has("preview") === browserToolsAvailable &&
                    resolved.capabilities.has("device") === deviceToolsAvailable &&
                    // A credential issued while the lineage read failed is replaced once it works.
                    (resolved.thread.subagent === true) === subagent
                  ) {
                    return { mcpCredentialId: existing.providerSessionId, issued: false };
                  }
                  dropMcpCredentialReservation(threadId, existing.providerSessionId);
                }
                yield* mcpSessionRegistry.revokeThread(threadId);
                const credential = yield* mcpSessionRegistry.issue({
                  threadId,
                  providerInstanceId,
                  browserToolsAvailable,
                  capabilities,
                  subagent,
                });
                yield* mcpSessions.set(credential.config);
                reserveMcpCredential(threadId, credential.config.providerSessionId);
                return { mcpCredentialId: credential.config.providerSessionId, issued: true };
              }),
            );
      const clearMcpSession = (threadId: ThreadId, mcpCredentialId?: string) =>
        mcpCredentialId === undefined
          ? mcpSessionRegistry
              .revokeThread(threadId)
              .pipe(Effect.tap(() => mcpSessions.clear(threadId)))
          : mcpSessionRegistry.revokeProviderSession(mcpCredentialId).pipe(
              Effect.tap(() =>
                Effect.gen(function* () {
                  if ((yield* mcpSessions.read(threadId))?.providerSessionId === mcpCredentialId) {
                    yield* mcpSessions.clear(threadId);
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

      const failSubscribers = Effect.fn("ProviderSessionManager.failSubscribers")(function* (
        entry: LiveSessionEntry,
        detail: string,
      ) {
        const error = new ProviderAdapter.ProviderAdapterEventStreamError({
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

      // Server shutdown interrupts subscribers rather than ending them: a
      // cleanly ended stream without a terminal fails its run, while an
      // interrupted one leaves run settlement to restart recovery.
      const interruptSubscribers = Effect.fn("ProviderSessionManager.interruptSubscribers")(
        function* (entry: LiveSessionEntry) {
          const subscribers = yield* Ref.getAndSet(entry.eventSubscribers, new Map());
          yield* Effect.forEach(
            subscribers.values(),
            (queue) => Queue.clear(queue).pipe(Effect.andThen(Queue.interrupt(queue))),
            { discard: true },
          );
        },
      );

      // Server shutdown intentionally clears them; a provider-announced Stop
      // must let consumers drain them before the stream completes.
      const endSubscribers = Effect.fn("ProviderSessionManager.endSubscribers")(function* (
        entry: LiveSessionEntry,
      ) {
        const subscribers = yield* Ref.getAndSet(entry.eventSubscribers, new Map());
        yield* Effect.forEach(subscribers.values(), (queue) => Queue.end(queue), {
          discard: true,
        });
      });

      const cancelIdleFiber = (fiber: Fiber.Fiber<void, never> | null) =>
        fiber === null ? Effect.void : Fiber.interrupt(fiber).pipe(Effect.ignore);
      const writeProviderSessionEvents = Effect.fn(
        "ProviderSessionManager.writeProviderSessionEvents",
      )(function* (input: {
        readonly runtime: ProviderAdapter.ProviderAdapterV2SessionRuntime;
        readonly threadIds: Iterable<ThreadId>;
        readonly type: "provider-session.attached" | "provider-session.updated";
        readonly payload: OrchestrationV2ProviderSession;
      }) {
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

      const writeReleasedSessionEvents = Effect.fn(
        "ProviderSessionManager.writeReleasedSessionEvents",
      )(function* (input: {
        readonly entry: LiveSessionEntry;
        readonly reason: ProviderSessionReleaseReason;
        readonly detail?: string;
      }) {
        const now = yield* DateTime.now;
        const payload: OrchestrationV2ProviderSession = {
          ...input.entry.runtime.providerSession,
          status: releaseStatusFor(input.reason),
          updatedAt: now,
          lastError:
            input.reason === "runtime_error" ? (input.detail ?? "Provider runtime failed.") : null,
        };
        yield* writeProviderSessionEvents({
          runtime: input.entry.runtime,
          threadIds: input.entry.attachedThreadIds,
          type: "provider-session.updated",
          payload,
        });
      });

      const writeReleasedRuntimeRequestEvents = Effect.fn(
        "ProviderSessionManager.writeReleasedRuntimeRequestEvents",
      )(function* (input: {
        readonly entry: LiveSessionEntry;
        readonly reason: ProviderSessionReleaseReason;
        readonly releasedAt: DateTime.Utc;
      }) {
        const providerSessionId = input.entry.runtime.providerSessionId;
        const now = yield* DateTime.now;
        const status = releasedRuntimeRequestStatusFor(input.reason);
        const reason =
          input.reason === "runtime_error"
            ? "Provider session failed before this runtime request was resolved."
            : "Provider session was closed before this runtime request was resolved.";

        const events: Array<OrchestrationV2DomainEvent> = [];
        for (const threadId of input.entry.attachedThreadIds) {
          const projection = yield* projectionStore.getThreadRecords(
            threadId,
            ["runtimeRequests", "nodes", "turnItems"],
            { turnItemTypes: ["approval_request", "user_input_request"] },
          );
          const releasedRequests = projection.runtimeRequests.filter(
            (request) =>
              request.status === "pending" &&
              request.responseCapability.type === "live" &&
              request.responseCapability.providerSessionId === providerSessionId &&
              DateTime.isLessThanOrEqualTo(request.createdAt, input.releasedAt) &&
              // Shutdown reconciliation decides which questions can survive the lost callback.
              !(input.reason === "server_shutdown" && request.kind === "user_input"),
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

      // Read tasks as soon as the session leaves the live map, before a replacement reports its own.
      // Keep OpenCode's roster: its background subagents share a server and can outlive the session.
      const readReleasedBackgroundTasks = Effect.fn(
        "ProviderSessionManager.readReleasedBackgroundTasks",
      )(
        function* (input: {
          readonly entry: LiveSessionEntry;
          readonly reason: ProviderSessionReleaseReason;
          readonly detachedThreadId?: ThreadId;
        }) {
          if (
            input.reason === "server_shutdown" ||
            input.entry.runtime.backgroundTasksEndWithProcess !== true
          ) {
            return [];
          }
          const providerSessionId = input.entry.runtime.providerSessionId;
          const threadIds = new Set(input.entry.attachedThreadIds);
          if (input.detachedThreadId !== undefined) threadIds.add(input.detachedThreadId);
          const released = [];
          for (const threadId of threadIds) {
            const projection = yield* projectionStore.getThreadRecords(threadId, [
              "providerThreads",
            ]);
            for (const providerThread of projection.providerThreads) {
              const tasks = providerThread.pendingBackgroundTasks ?? [];
              if (providerThread.providerSessionId !== providerSessionId || tasks.length === 0) {
                continue;
              }
              released.push({
                threadId,
                providerSessionId,
                providerThreadId: providerThread.id,
                taskIds: new Set(tasks.map((task) => task.taskId)),
              });
            }
          }
          return released;
        },
        (effect, input) =>
          effect.pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("orchestration-v2.provider-session-release-roster-read-failed", {
                providerSessionId: input.entry.runtime.providerSessionId,
                cause,
              }).pipe(Effect.as([])),
            ),
          ),
      );
      type ReleasedBackgroundTasks = Effect.Success<
        ReturnType<typeof readReleasedBackgroundTasks>
      >[number];

      // Dead processes cannot report task endings; stale rosters keep threads Waiting.
      const writeReleasedBackgroundWorkEvents = (
        released: ReadonlyArray<ReleasedBackgroundTasks>,
      ) =>
        Effect.forEach(
          released,
          ({ threadId, providerSessionId, providerThreadId, taskIds }) =>
            Effect.gen(function* () {
              for (let attempt = 0; attempt < 3; attempt++) {
                const projection = yield* projectionStore.getThreadRecords(threadId, [
                  "providerThreads",
                ]);
                const providerThread = projection.providerThreads.find(
                  (candidate) => candidate.id === providerThreadId,
                );
                const tasks = providerThread?.pendingBackgroundTasks ?? [];
                const remaining = tasks.filter((task) => !taskIds.has(task.taskId));
                if (providerThread === undefined || remaining.length === tasks.length) return;
                const now = yield* DateTime.now;
                const { committed } = yield* eventSink.writeIfProviderThreadUnchanged({
                  expected: providerThread,
                  events: [
                    {
                      id: yield* idAllocator.allocate.event({ threadId, providerSessionId }),
                      type: "provider-thread.updated",
                      threadId,
                      driver: providerThread.driver,
                      providerInstanceId: providerThread.providerInstanceId,
                      occurredAt: now,
                      payload: {
                        ...providerThread,
                        pendingBackgroundTasks: remaining,
                        updatedAt: now,
                      },
                    },
                  ],
                });
                if (committed) return;
              }
              yield* Effect.logWarning(
                "orchestration-v2.provider-session-release-roster-conflict",
                {
                  providerSessionId,
                  providerThreadId,
                },
              );
            }),
          { discard: true },
        );

    return {
      agentAccessSettings,
      shutdownSignal,
      sessions,
      releaseRecordRetries,
      nextSubscriberId,
      sessionOpen,
      threadAttachment,
      threadAttachmentKey,
      idleTimeoutMs,
      maxIdlePinMs,
      mcpCredentialReservations,
      reserveMcpCredential,
      dropMcpCredentialReservation,
      isMcpCredentialReserved,
      mcpPrepareLock,
      prepareMcpSession,
      clearMcpSession,
      publishToSubscribers,
      failSubscribers,
      interruptSubscribers,
      endSubscribers,
      cancelIdleFiber,
      writeProviderSessionEvents,
      writeReleasedSessionEvents,
      writeReleasedRuntimeRequestEvents,
      readReleasedBackgroundTasks,
      writeReleasedBackgroundWorkEvents,
    } as const;
  });

export type ProviderSessionStoreShape = Effect.Success<
  ReturnType<typeof makeProviderSessionStoreShape>
>;


export type ReleasedBackgroundTasks = Effect.Success<
  ReturnType<ProviderSessionStoreShape["readReleasedBackgroundTasks"]>
>[number];
