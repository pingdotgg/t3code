// @effect-diagnostics anyUnknownInErrorContext:off
import { makeAssistantStreamingFilter } from "./assistantStreaming.ts";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import {
  isOrchestrationV2WorkActive,
  CommandId,
  type EventId,
  type ModelSelection,
  type NodeId,
  type OrchestrationV2AppThread,
  type OrchestrationV2CheckpointScope,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2Run,
  type OrchestrationV2RunAttempt,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  type ProviderSessionId,
  type ProviderThreadId,
  type ProviderTurnId,
  type RunAttemptId,
  type ThreadId,
  type TurnItemId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as McpAppModelContext from "../mcpApps/McpAppModelContext.ts";
import * as PreviewAgentActivity from "../preview/PreviewAgentActivity.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as CheckpointService from "./CheckpointService.ts";
import * as EventSink from "./EventSink.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as ProviderEventIngestor from "./ProviderEventIngestor.ts";
import * as ProviderUsageAnalytics from "../telemetry/ProviderUsageAnalytics.ts";
import type { ProjectionStoreV2Error } from "./ProjectionStore.ts";
import {
  knownProviderFailureMessage,
  makeProviderFailure,
  makeProviderFailureTurnItem,
} from "@t3tools/provider-core/server/failure";
import * as RunFinalizationService from "./RunFinalizationService.ts";
import * as TurnItemPositionStore from "./TurnItemPositionStore.ts";
import { userFacingDatabaseErrorMessage } from "./UserFacingErrors.ts";
import {
  makeInterruptResultTurnItem,
  makeWriteFinalRunEvents,
} from "./RunExecutionServiceFinalize.ts";
import {
  NATIVE_SUBAGENT_TURN_ORIGIN,
  RunExecutionIngestError,
  RunExecutionStartError,
  backgroundCapableTurnItemTypes,
  childTurnsContinue,
  emptyOpenRunOwnedSubagentProjection,
  isOpenExecutionNodeStatus,
  isRunOwnedSubagentTerminalStatus,
  isSettledSubagentStatus,
  isSettledTurnItemStatus,
  isTerminalProviderTurnStatus,
  makeProviderEventRoutingState,
  routeProviderEvent,
  withLinkedChildThreadId,
} from "./RunExecutionServiceRouting.ts";
import type {
  ProviderEventRouteIdentity,
  ProviderEventRoutingState,
  ProviderTerminalEvent,
} from "./RunExecutionServiceRouting.ts";
import { makeRunChildTurnTracking } from "./RunExecutionServiceChildTurns.ts";
import type { RunExecutionServiceV2StartRootRunInput } from "./RunExecutionService.ts";

export const makeStartRootRun = Effect.gen(function* () {
  const scope = yield* Effect.scope;
  const checkpointService = yield* CheckpointService.CheckpointServiceV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const idAllocator = yield* IdAllocator.IdAllocatorV2;
  const providerEventIngestor = yield* ProviderEventIngestor.ProviderEventIngestorV2;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const mcpAppModelContext = yield* McpAppModelContext.McpAppModelContext;
  const previewAgentActivity = yield* PreviewAgentActivity.PreviewAgentActivity;
  const turnItemPositions = yield* TurnItemPositionStore.TurnItemPositionStoreV2;
  const finalizationObserver = yield* RunFinalizationService.RunFinalizationObserver;
  const turnAnalytics = yield* ProviderUsageAnalytics.ProviderTurnAnalytics;
  const writeFinalRunEvents = makeWriteFinalRunEvents({ eventSink, idAllocator, turnAnalytics });

  return Effect.fn("RunExecutionService.startRootRun")(function* (
    input: RunExecutionServiceV2StartRootRunInput,
  ) {
        const rootTurnOrigin: ProviderUsageAnalytics.ProviderTurnOrigin = {
          createdBy: input.message.createdBy,
          creationSource: input.message.creationSource,
          scheduled: input.message.scheduledTaskId !== undefined,
          subagent: input.appThread.lineage.relationshipToParent === "subagent",
        };
        // Startup failure and stream shutdown can report the same attempt.
        const refreshAfterTurn = yield* Effect.cached(
          finalizationObserver.refreshAfterTurn(input.appThread.projectId).pipe(
            Effect.catchCause((cause) =>
              Effect.logWarning("failed to refresh pull requests after run termination", {
                threadId: input.run.threadId,
                runId: input.run.id,
                cause,
              }),
            ),
          ),
        );
        const makeFailedTerminalEvent = (
          failure: OrchestrationV2ProviderFailure,
          failureItemOrdinal: number,
        ): ProviderTerminalEvent => ({
          type: "turn.terminal",
          driver: input.providerThread.driver,
          providerThreadId: input.providerThread.id,
          providerTurnId:
            input.attempt.providerTurnId ??
            idAllocator.derive.providerTurn({
              driver: input.providerThread.driver,
              nativeTurnId: `failed:${input.attempt.id}`,
            }),
          runOrdinal: input.run.ordinal,
          failureItemOrdinal,
          status: "failed",
          failure,
          threadDisposition: "reusable",
        });
        const responseStreamingMode = yield* Effect.gen(function* () {
          const responseStreamingMode = yield* serverSettings.getSettings.pipe(
            Effect.map(
              (settings) =>
                resolveProjectSettings(settings, input.appThread.projectId).settings
                  .responseStreamingMode,
            ),
          );
          // Side chats share the parent's worktree; a snapshot would capture the parent's edits.
          yield* (
            input.appThread.lineage.sideChat === true
              ? Effect.void
              : checkpointService.captureBaseline({
                  scope: input.checkpointScope,
                  ordinalWithinScope: Math.max(0, input.run.ordinal - 1),
                })
          ).pipe(
            Effect.catchCauseIf(
              (cause) => !Cause.hasInterruptsOnly(cause),
              (_cause) =>
                Effect.logWarning(
                  "orchestration V2 checkpoint baseline capture failed; starting provider without a baseline",
                  { runId: input.run.id },
                ),
            ),
          );
          if (
            input.shouldStartProviderTurn !== undefined &&
            !(yield* input.shouldStartProviderTurn())
          ) {
            return null;
          }
          return responseStreamingMode;
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.gen(function* () {
              if (Cause.hasInterruptsOnly(cause)) {
                return yield* Effect.failCause(cause);
              }
              yield* Effect.logError("orchestration V2 run preparation failed", {
                runId: input.run.id,
                cause,
              });
              yield* writeFinalRunEvents({
                run: input.run,
                rootNode: input.rootNode,
                checkpointScope: input.checkpointScope,
                providerThread: input.providerThread,
                attempt: input.attempt,
                terminal: makeFailedTerminalEvent(
                  makeProviderFailure({
                    cause: Cause.squash(cause),
                    message: "Run preparation failed.",
                    class: "unknown",
                  }),
                  input.providerTurnOrdinal * 100 + 1,
                ),
                failureItemPersisted: false,
                refreshAfterTurn,
                writeIfRunCurrent: {
                  activeAttemptId: input.attemptId,
                  expectedStatus: "running",
                },
              });
              return null;
            }),
          ),
          Effect.mapError(
            (cause) =>
              new RunExecutionStartError({
                commandId: input.commandId,
                runId: input.run.id,
                cause,
              }),
          ),
        );
        if (responseStreamingMode === null) {
          return;
        }
        const terminalEvent = yield* Ref.make<ProviderTerminalEvent | null>(null);
        const latestTurnItemOrdinal = yield* Ref.make(input.providerTurnOrdinal * 100);
        const latestProviderThread = yield* Ref.make(input.providerThread);
        const latestRootProviderTurn = yield* Ref.make<OrchestrationV2ProviderTurn | null>(null);
        // Later root turns in one attempt are provider continuations, such as Codex goal turns.
        let firstRootProviderTurnId: ProviderTurnId | undefined;
        const analyticsContext = {
          runId: input.run.id,
          modelSelection: input.modelSelection,
          runtimeMode: input.runtimePolicy.runtimeMode,
          interactionMode: input.runtimePolicy.interactionMode,
          origin: rootTurnOrigin,
          ...(input.run.restartContinuationOfRunId === undefined
            ? {}
            : { restartContinuation: true }),
        } satisfies ProviderUsageAnalytics.ProviderTurnAnalyticsContext;
        if (input.attempt.reason === "initial") {
          yield* turnAnalytics.runStarted({
            runId: input.run.id,
            driver: input.providerThread.driver,
            context: { ...analyticsContext, segment: "initial" },
          });
        }
        const routeIdentity: ProviderEventRouteIdentity = {
          threadId: input.run.threadId,
          runId: input.run.id,
          attemptId: input.attempt.id,
          providerThreadId: input.providerThread.id,
        };
        const eventSubscription =
          input.session.subscribeEvents === undefined
            ? { events: input.session.events, close: Effect.void }
            : yield* input.session.subscribeEvents;
        const inheritedBackgroundTurnItems = yield* (
          input.loadInheritedBackgroundTurnItems?.() ?? Effect.succeed([])
        ).pipe(
          Effect.onError(() => eventSubscription.close),
          Effect.mapError(
            (cause) =>
              new RunExecutionStartError({
                commandId: input.commandId,
                runId: input.run.id,
                cause,
              }),
          ),
        );
        const inheritedBackgroundTurnItemsById = new Map(
          inheritedBackgroundTurnItems.map((item) => [item.id, item.runId]),
        );
        const eventRouting = yield* Ref.make<ProviderEventRoutingState>(
          makeProviderEventRoutingState({
            identity: routeIdentity,
            inheritedBackgroundTurnItems,
            providerTurnId: input.attempt.providerTurnId,
            ...(input.relatedThreadIds === undefined
              ? {}
              : { relatedThreadIds: input.relatedThreadIds }),
            ...(input.relatedProviderThreadIds === undefined
              ? {}
              : { relatedProviderThreadIds: input.relatedProviderThreadIds }),
          }),
        );
        const rootTerminalSeen = yield* Ref.make(false);
        const rootRunFinalized = yield* Ref.make(false);
        const providerThreadOwnerLost = yield* Ref.make(false);
        const pendingBackgroundProviderTurns = new Set<ProviderTurnId>();
        const activeChildProviderTurns = yield* Ref.make<ReadonlySet<ProviderTurnId>>(new Set());
        const activeChildSubagents = yield* Ref.make<ReadonlyMap<NodeId, ThreadId>>(new Map());
        const activeBackgroundTurnItems = yield* Ref.make<
          ReadonlySet<OrchestrationV2TurnItem["id"]>
        >(new Set(inheritedBackgroundTurnItemsById.keys()));
        const openRunOwnedSubagents = yield* Ref.make(emptyOpenRunOwnedSubagentProjection());
        const { finalizeRootRun, trackChildLifecycle, agentTurnsSettled, shouldStopProviderEventIngestion } =
          yield* makeRunChildTurnTracking({
            input,
            writeFinalRunEvents,
            refreshAfterTurn,
            terminalEvent,
            latestProviderThread,
            inheritedBackgroundTurnItemsById,
            eventRouting,
            rootTerminalSeen,
            rootRunFinalized,
            providerThreadOwnerLost,
            pendingBackgroundProviderTurns,
            activeChildProviderTurns,
            activeChildSubagents,
            activeBackgroundTurnItems,
            openRunOwnedSubagents,
          });
        const filterAssistantEvent = makeAssistantStreamingFilter(responseStreamingMode);
        // Held text writes nothing, so its item would take a position only
        // when finally written, behind every item that began after it.
        const reservedHeldTurnItemIds = new Set<TurnItemId>();
        // Ends once the root turn and the children it drives settle. Background commands such
        // as a dev server keep this consumer alive afterwards and must not pin preview focus.
        const endPreviewActivity = yield* previewAgentActivity.begin(input.run.threadId);
        const providerEventFiber = yield* eventSubscription.events.pipe(
          Stream.mapEffect((event) =>
            Effect.gen(function* () {
              const previous = yield* Ref.get(eventRouting);
              const [accepted, routing] = routeProviderEvent(event, routeIdentity, previous);
              yield* Ref.set(eventRouting, routing);
              if (
                event.type === "subagent.updated" &&
                event.subagent.childThreadId !== null &&
                previous.ownedThreadIds.has(event.subagent.childThreadId) &&
                !routing.ownedThreadIds.has(event.subagent.childThreadId)
              ) {
                const moved = event.subagent;
                const detached = yield* Ref.modify(openRunOwnedSubagents, (current) => {
                  const subagentIds = new Set([moved.id]);
                  for (const subagent of current.subagents.values()) {
                    if (subagent.threadId === moved.childThreadId) subagentIds.add(subagent.id);
                  }
                  const childTurnItems = new Map(
                    [...current.childTurnItems].filter(
                      ([, item]) => item.threadId !== moved.childThreadId,
                    ),
                  );
                  const turnItems = new Map(current.turnItems);
                  turnItems.delete(moved.id);
                  const detachedItems = new Set(
                    [...current.childTurnItems.values(), ...current.turnItems.values()]
                      .filter(
                        (item) => item.threadId === moved.childThreadId || item.nodeId === moved.id,
                      )
                      .map((item) => item.id),
                  );
                  return [
                    { itemIds: detachedItems, subagentIds },
                    {
                      subagents: new Map(
                        [...current.subagents].filter(([id]) => !subagentIds.has(id)),
                      ),
                      turnItems,
                      childTurnItems,
                      nodes: new Map(
                        [...current.nodes].filter(
                          ([id, node]) => id !== moved.id && node.threadId !== moved.childThreadId,
                        ),
                      ),
                      linkedChildThreadIds: new Set(
                        [...current.linkedChildThreadIds].filter(
                          (id) => id !== moved.childThreadId,
                        ),
                      ),
                    },
                  ];
                });
                yield* Ref.update(
                  activeChildSubagents,
                  (current) =>
                    new Map(
                      [...current].filter(
                        ([id, threadId]) =>
                          !detached.subagentIds.has(id) && threadId !== moved.childThreadId,
                      ),
                    ),
                );
                yield* Ref.update(
                  activeChildProviderTurns,
                  (current) =>
                    new Set([...current].filter((id) => routing.ownedProviderTurns.has(id))),
                );
                for (const id of pendingBackgroundProviderTurns) {
                  if (!routing.ownedProviderTurns.has(id)) {
                    pendingBackgroundProviderTurns.delete(id);
                  }
                }
                yield* Ref.update(
                  activeBackgroundTurnItems,
                  (current) => new Set([...current].filter((id) => !detached.itemIds.has(id))),
                );
              }
              return { event, accepted };
            }),
          ),
          Stream.tap(({ event, accepted }) =>
            Effect.gen(function* () {
              if (!accepted) return;
              if (
                event.type === "provider_turn.updated" &&
                event.providerTurn.runAttemptId === input.attempt.id &&
                event.providerTurn.providerThreadId === input.providerThread.id
              ) {
                yield* Ref.set(latestRootProviderTurn, event.providerTurn);
              }
              let storedEventCount = 0;
              const deliveredEvent = filterAssistantEvent(
                event,
                DateTime.toEpochMillis(yield* DateTime.now),
              );
              if (deliveredEvent) {
                const rootTerminalAlreadySeen = yield* Ref.get(rootTerminalSeen);
                const isRootProviderThreadUpdate =
                  event.type === "provider_thread.updated" &&
                  event.providerThread.id === input.providerThread.id;
                const nativeChildTurn =
                  event.type === "provider_turn.updated" &&
                  event.providerTurn.providerThreadId !== input.providerThread.id;
                if (event.type === "provider_turn.updated" && !nativeChildTurn) {
                  firstRootProviderTurnId ??= event.providerTurn.id;
                }
                const storedEvents = yield* providerEventIngestor.ingestNormalized({
                  analyticsContext: nativeChildTurn
                    ? {
                        ...analyticsContext,
                        origin: NATIVE_SUBAGENT_TURN_ORIGIN,
                        segment: "native_child",
                      }
                    : {
                        ...analyticsContext,
                        segment:
                          event.type === "provider_turn.updated" &&
                          event.providerTurn.id !== firstRootProviderTurnId
                            ? "continuation"
                            : input.attempt.reason,
                      },
                  providerSessionId: input.providerSessionId,
                  providerInstanceId: input.run.providerInstanceId,
                  threadId: input.run.threadId,
                  runId: input.run.id,
                  nodeId: input.rootNode.id,
                  event: deliveredEvent,
                  ...(isRootProviderThreadUpdate
                    ? rootTerminalAlreadySeen
                      ? {
                          writeIfProviderThreadOwner: {
                            providerThreadId: input.providerThread.id,
                            runId: input.run.id,
                            activeAttemptId: input.attempt.id,
                            expectedLastRunOrdinal: input.run.ordinal,
                          },
                        }
                      : {
                          writeIfRunCurrent: {
                            runId: input.run.id,
                            activeAttemptId: input.attempt.id,
                            expectedStatus: "running" as const,
                          },
                        }
                    : {}),
                });
                storedEventCount = storedEvents.length;
                if (
                  isRootProviderThreadUpdate &&
                  rootTerminalAlreadySeen &&
                  storedEventCount === 0
                ) {
                  yield* Ref.set(providerThreadOwnerLost, true);
                }
              } else if (
                event.type === "turn_item.updated" &&
                (event.turnItem.type === "assistant_message" ||
                  event.turnItem.type === "reasoning") &&
                event.turnItem.streaming &&
                !reservedHeldTurnItemIds.has(event.turnItem.id)
              ) {
                yield* turnItemPositions.allocate({
                  threadId: event.turnItem.threadId,
                  turnItemId: event.turnItem.id,
                  runId: event.turnItem.runId,
                });
                reservedHeldTurnItemIds.add(event.turnItem.id);
              }
              if (event.type === "provider_thread.updated") {
                if (event.providerThread.id === input.providerThread.id && storedEventCount > 0) {
                  yield* Ref.set(latestProviderThread, event.providerThread);
                }
              }
              if (
                event.type === "turn_item.updated" &&
                event.turnItem.providerTurnId === (yield* Ref.get(eventRouting)).rootProviderTurnId
              ) {
                yield* Ref.update(latestTurnItemOrdinal, (current) =>
                  Math.max(current, event.turnItem.ordinal),
                );
              }
              if (event.type === "turn.terminal") {
                yield* Ref.set(terminalEvent, event);
                yield* Ref.set(rootTerminalSeen, true);
                yield* finalizeRootRun(event);
              }
              if (event.type === "background_work.updated") {
                if (event.pending) {
                  pendingBackgroundProviderTurns.add(event.providerTurnId);
                } else {
                  pendingBackgroundProviderTurns.delete(event.providerTurnId);
                }
              }
              yield* trackChildLifecycle(event, deliveredEvent !== null);
            }),
          ),
          // Also after events this run does not accept, such as a child handed to another run.
          Stream.tap(() =>
            Effect.gen(function* () {
              if (yield* agentTurnsSettled) yield* endPreviewActivity;
            }),
          ),
          Stream.takeUntilEffect(() => shouldStopProviderEventIngestion),
          Stream.runDrain,
          Effect.mapError((cause) => new RunExecutionIngestError({ runId: input.run.id, cause })),
          Effect.flatMap(() =>
            Effect.gen(function* () {
              const terminal = yield* Ref.get(terminalEvent);
              if (terminal === null) {
                // A session release interrupts or fails the stream; a clean
                // end without a terminal means the run would never settle.
                return yield* new RunExecutionIngestError({
                  runId: input.run.id,
                  cause: new ProviderAdapter.ProviderAdapterEventStreamError({
                    driver: input.providerThread.driver,
                    providerSessionId: input.providerSessionId,
                    cause: "Provider event stream ended without a root terminal.",
                  }),
                });
              }
              yield* finalizeRootRun(terminal);
            }),
          ),
          // Server shutdown interrupts the subscription and leaves the run to
          // restart recovery; every other failure fails the run.
          Effect.catchCauseIf(
            (cause) => !Cause.hasInterruptsOnly(cause),
            (cause) =>
              Effect.gen(function* () {
                const completedAt = yield* DateTime.now;
                yield* Effect.logWarning("orchestration V2 provider event ingestion failed", {
                  runId: input.run.id,
                  cause,
                });
                if (yield* Ref.get(rootRunFinalized)) return;
                const providerThread = yield* Ref.get(latestProviderThread);
                const routing = yield* Ref.get(eventRouting);
                const rootProviderTurn = yield* Ref.get(latestRootProviderTurn);
                // Stop background work too; the failed consumer cannot persist terminal events.
                const abandonedProviderTurn =
                  routing.rootProviderTurnId !== null && !routing.rootTurnEnded
                    ? yield* input.session
                        .interruptTurn({
                          providerThread,
                          providerTurnId: routing.rootProviderTurnId,
                          requestRuntimeRestart: true,
                        })
                        .pipe(
                          Effect.as(true),
                          Effect.catchCauseIf(
                            (interruptCause) => !Cause.hasInterruptsOnly(interruptCause),
                            (interruptCause) =>
                              Effect.logWarning(
                                "orchestration V2 failed to interrupt turn after ingestion failure",
                                { runId: input.run.id, cause: interruptCause },
                              ).pipe(Effect.as(false)),
                          ),
                          // A failed interrupt leaves the stored turn running so the next start
                          // retries it. The snapshot is cached before it is published, so it may
                          // not be stored: replay a terminal one as-is.
                          Effect.map((interrupted) =>
                            !interrupted || rootProviderTurn === null
                              ? null
                              : isTerminalProviderTurnStatus(rootProviderTurn.status)
                                ? rootProviderTurn
                                : {
                                    ...rootProviderTurn,
                                    status: "interrupted" as const,
                                    completedAt,
                                  },
                          ),
                        )
                    : null;
                const latestItemOrdinal = yield* Ref.get(latestTurnItemOrdinal);
                const openSubagents = yield* Ref.get(openRunOwnedSubagents);
                const squashed = Cause.squash(cause);
                let nextRetryWarningAt = completedAt;
                yield* writeFinalRunEvents({
                  run: input.run,
                  rootNode: input.rootNode,
                  checkpointScope: input.checkpointScope,
                  providerThread,
                  attempt: input.attempt,
                  writeIfRunCurrent: {
                    activeAttemptId: input.attempt.id,
                    expectedStatus: "running",
                  },
                  openRunOwnedSubagents: openSubagents,
                  ...(abandonedProviderTurn === null ? {} : { abandonedProviderTurn }),
                  completedAt,
                  terminal: makeFailedTerminalEvent(
                    makeProviderFailure({
                      cause: squashed,
                      message:
                        knownProviderFailureMessage(squashed) ??
                        userFacingDatabaseErrorMessage(squashed),
                      class: "unknown",
                    }),
                    latestItemOrdinal + 1,
                  ),
                  failureItemPersisted: false,
                  refreshAfterTurn,
                }).pipe(
                  // Storage failures can be defects; retry both failure channels.
                  Effect.catchCause((writeCause) =>
                    Effect.gen(function* () {
                      if (Cause.hasInterruptsOnly(writeCause)) {
                        return yield* Effect.failCause(writeCause);
                      }
                      const now = yield* DateTime.now;
                      if (DateTime.isGreaterThanOrEqualTo(now, nextRetryWarningAt)) {
                        yield* Effect.logWarning(
                          "orchestration V2 run failure finalization retry",
                          {
                            runId: input.run.id,
                            attemptId: input.attempt.id,
                            cause: writeCause,
                          },
                        );
                        // Persistent storage failures must not flood the same disk.
                        nextRetryWarningAt = DateTime.add(now, { minutes: 10 });
                      }
                      return yield* Effect.fail(writeCause);
                    }),
                  ),
                  Effect.retry({
                    schedule: Schedule.exponential("1 second").pipe(
                      Schedule.modifyDelay(({ duration }) =>
                        Effect.succeed(Duration.min(duration, Duration.seconds(30))),
                      ),
                    ),
                  }),
                  // Startup may cancel the consumer and fail its own terminal
                  // write. Only service shutdown or the atomic gate ends recovery.
                  Effect.forkIn(scope),
                  Effect.flatMap(Fiber.join),
                );
              }),
          ),
          Effect.ensuring(endPreviewActivity),
          Effect.ensuring(eventSubscription.close),
          Effect.forkDetach,
        );

        // A provider turn is a sign that the session is still alive. Keep
        // its already-issued MCP credential valid even when the agent goes
        // a long time between browser-tool calls.
        const touchMcpCredential = McpSessionRegistry.touchActiveMcpThread(input.run.threadId).pipe(
          Effect.ignoreCause({
            log: true,
            message: "Failed to refresh MCP credential liveness.",
          }),
        );
        yield* touchMcpCredential;
        const appContext = (yield* mcpAppModelContext
          .forThread(input.run.threadId)
          .pipe(
            Effect.catch((cause) =>
              Effect.logWarning("Failed to read MCP app model context.", { cause }).pipe(
                Effect.as([]),
              ),
            ),
          )).map((entry) => ({
          // The item id alone is unique and needs no escaping; server and
          // tool names are free text that would break the tag Codex wraps
          // the context in.
          key: `mcp_app_${entry.itemId.replace(/[^\w.-]/g, "_")}`,
          text: entry.text,
        }));
        const turnInput = {
          appThread: input.appThread,
          threadId: input.run.threadId,
          runId: input.run.id,
          runOrdinal: input.run.ordinal,
          providerTurnOrdinal: input.providerTurnOrdinal,
          ...(input.nativeThreadHasTurns === undefined
            ? {}
            : { nativeThreadHasTurns: input.nativeThreadHasTurns }),
          ...(input.run.restartContinuationOfRunId === undefined
            ? {}
            : {
                restartContinuationOfRunId: input.run.restartContinuationOfRunId,
              }),
          attemptId: input.attemptId,
          rootNodeId: input.rootNode.id,
          providerThread: input.providerThread,
          message: input.message,
          modelSelection: input.modelSelection,
          runtimePolicy: input.runtimePolicy,
          ...(appContext.length === 0 ? {} : { appContext }),
        };
        // Check after the context read: ingestion can settle the run while
        // it awaits. A failed ownership read fails the start below.
        const shouldStart =
          input.shouldStartProviderTurn === undefined
            ? Exit.succeed(true)
            : yield* Effect.exit(input.shouldStartProviderTurn());
        if (Exit.isSuccess(shouldStart) && !shouldStart.value) {
          yield* Fiber.interrupt(providerEventFiber);
          return;
        }

        const compact =
          input.message.attachments.length === 0 &&
          input.message.text.trim().toLowerCase() === "/compact";
        const startTurn = compact
          ? (input.session.compactThread?.(turnInput) ??
            Effect.fail(
              new ProviderAdapter.ProviderAdapterTurnStartError({
                driver: input.session.driver,
                threadId: input.run.threadId,
                providerThreadId: input.providerThread.id,
                runId: input.run.id,
                cause: "This provider does not support context compaction.",
              }),
            ))
          : input.session.startTurn(turnInput);
        yield* Effect.andThen(shouldStart, startTurn).pipe(
          // Wait for acceptance so abandoned startup cannot leave a refresher
          // on the already-detached ingestion fiber.
          Effect.tap(() =>
            Fiber.await(providerEventFiber).pipe(
              Effect.raceFirst(touchMcpCredential.pipe(Effect.delay("1 hour"), Effect.forever)),
              Effect.forkDetach,
            ),
          ),
          Effect.catchCause((cause) =>
            Effect.logError("orchestration V2 provider turn start failed", {
              runId: input.run.id,
              cause,
            }).pipe(
              Effect.andThen(Fiber.interrupt(providerEventFiber)),
              Effect.andThen(Ref.get(latestProviderThread)),
              Effect.flatMap((providerThread) =>
                Ref.get(latestTurnItemOrdinal).pipe(
                  Effect.flatMap((latestItemOrdinal) =>
                    Ref.get(openRunOwnedSubagents).pipe(
                      Effect.flatMap((openSubagents) =>
                        writeFinalRunEvents({
                          run: input.run,
                          rootNode: input.rootNode,
                          checkpointScope: input.checkpointScope,
                          providerThread,
                          attempt: input.attempt,
                          writeIfRunCurrent: {
                            activeAttemptId: input.attempt.id,
                            expectedStatus: "running",
                          },
                          openRunOwnedSubagents: openSubagents,
                          terminal: makeFailedTerminalEvent(
                            makeProviderFailure({
                              cause: Cause.squash(cause),
                              class: Exit.isFailure(shouldStart) ? "unknown" : "provider_error",
                            }),
                            latestItemOrdinal + 1,
                          ),
                          failureItemPersisted: false,
                          refreshAfterTurn,
                        }),
                      ),
                    ),
                  ),
                ),
              ),
              Effect.mapError(
                (writeCause) =>
                  new RunExecutionStartError({
                    commandId: input.commandId,
                    runId: input.run.id,
                    cause: { start: cause, write: writeCause },
                  }),
              ),
            ),
          ),
        );
  });
});
