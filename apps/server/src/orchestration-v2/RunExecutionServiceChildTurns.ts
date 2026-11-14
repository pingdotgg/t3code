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
  RunExecutionIngestError,
  backgroundCapableTurnItemTypes,
  childTurnsContinue,
  emptyOpenRunOwnedSubagentProjection,
  isOpenExecutionNodeStatus,
  isRunOwnedSubagentTerminalStatus,
  isSettledSubagentStatus,
  isSettledTurnItemStatus,
  isTerminalProviderTurnStatus,
  withLinkedChildThreadId,
} from "./RunExecutionServiceRouting.ts";
import type {
  OpenRunOwnedSubagentProjection,
  ProviderEventRoutingState,
  ProviderTerminalEvent,
} from "./RunExecutionServiceRouting.ts";
import type { RunExecutionServiceV2StartRootRunInput } from "./RunExecutionService.ts";
import { makeWriteFinalRunEvents } from "./RunExecutionServiceFinalize.ts";

export interface RunChildTurnTrackingState {
  readonly input: RunExecutionServiceV2StartRootRunInput;
  readonly writeFinalRunEvents: ReturnType<typeof makeWriteFinalRunEvents>;
  readonly refreshAfterTurn: Effect.Effect<void>;
  readonly terminalEvent: Ref.Ref<ProviderTerminalEvent | null>;
  readonly latestProviderThread: Ref.Ref<OrchestrationV2ProviderThread>;
  readonly inheritedBackgroundTurnItemsById: Map<TurnItemId, string>;
  readonly eventRouting: Ref.Ref<ProviderEventRoutingState>;
  readonly rootTerminalSeen: Ref.Ref<boolean>;
  readonly rootRunFinalized: Ref.Ref<boolean>;
  readonly providerThreadOwnerLost: Ref.Ref<boolean>;
  readonly pendingBackgroundProviderTurns: Set<ProviderTurnId>;
  readonly activeChildProviderTurns: Ref.Ref<ReadonlySet<ProviderTurnId>>;
  readonly activeChildSubagents: Ref.Ref<ReadonlyMap<NodeId, ThreadId>>;
  readonly activeBackgroundTurnItems: Ref.Ref<ReadonlySet<OrchestrationV2TurnItem["id"]>>;
  readonly openRunOwnedSubagents: Ref.Ref<OpenRunOwnedSubagentProjection>;
}

export const makeRunChildTurnTracking = Effect.fn("makeRunChildTurnTracking")(function* (
  state: RunChildTurnTrackingState,
) {
    const {
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
    } = state;

        const finalizeRootRun = Effect.fn("RunExecutionService.finalizeRootRun")(function* (
          terminal: ProviderTerminalEvent,
        ) {
          if (yield* Ref.get(rootRunFinalized)) {
            return;
          }
          const providerThread = yield* Ref.get(latestProviderThread);
          const openSubagents = yield* Ref.get(openRunOwnedSubagents);
          yield* writeFinalRunEvents({
            run: input.run,
            rootNode: input.rootNode,
            checkpointScope: input.checkpointScope,
            providerThread,
            attempt: input.attempt,
            ...(input.shouldFinalizeRun === undefined
              ? {}
              : {
                  shouldFinalizeRun: input.shouldFinalizeRun,
                  // Stop may commit between the ownership read and this
                  // terminal write. Gate the events and checkpoint together.
                  writeIfRunCurrent: {
                    activeAttemptId: input.attempt.id,
                    expectedStatus: "running" as const,
                  },
                }),
            ...(input.hasUnpairedRunInterruptRequest === undefined
              ? {}
              : {
                  hasUnpairedRunInterruptRequest: input.hasUnpairedRunInterruptRequest,
                }),
            ...(input.loadRunInterruptReason === undefined
              ? {}
              : { loadRunInterruptReason: input.loadRunInterruptReason }),
            openRunOwnedSubagents: openSubagents,
            terminal,
            failureItemPersisted: terminal.status === "failed",
            refreshAfterTurn,
          }).pipe(
            Effect.mapError((cause) => new RunExecutionIngestError({ runId: input.run.id, cause })),
          );
          if (isRunOwnedSubagentTerminalStatus(terminal.status) && !childTurnsContinue(terminal)) {
            yield* Ref.set(openRunOwnedSubagents, emptyOpenRunOwnedSubagentProjection());
          }
          yield* Ref.set(rootRunFinalized, true);
        });
        // Runs for every provider event, including streamed text updates; avoid a per-event span.
        const trackChildLifecycle = Effect.fnUntraced(function* (
          event: ProviderAdapter.ProviderAdapterV2Event,
          deliverable: boolean,
        ) {
          const routing = yield* Ref.get(eventRouting);
          if (event.type === "provider_turn.updated") {
            const isRoot =
              event.providerTurn.runAttemptId === input.attempt.id ||
              event.providerTurn.id === routing.rootProviderTurnId;
            if (!isRoot) {
              yield* Ref.update(activeChildProviderTurns, (current) => {
                const next = new Set(current);
                if (isTerminalProviderTurnStatus(event.providerTurn.status)) {
                  next.delete(event.providerTurn.id);
                } else {
                  next.add(event.providerTurn.id);
                }
                return next;
              });
            }
          }
          if (event.type === "subagent.updated") {
            const belongsToRootRun = event.subagent.runId === input.run.id;
            const belongsToOwnedChildThread =
              event.subagent.threadId !== input.run.threadId &&
              routing.ownedThreadIds.has(event.subagent.threadId);
            if (belongsToRootRun || belongsToOwnedChildThread) {
              yield* Ref.update(activeChildSubagents, (current) => {
                const next = new Map(current);
                if (isSettledSubagentStatus(event.subagent.status)) {
                  next.delete(event.subagent.id);
                } else {
                  next.set(event.subagent.id, event.subagent.threadId);
                }
                return next;
              });
            }
            // Preserve childThreadId linkage for the root-run lifetime even after the subagent
            // row terminalizes, so open child-thread nodes can still be proven linked on a
            // later root interrupt. A provider records nested native subagents on the child
            // thread, runless; they die with this run too.
            if (
              belongsToRootRun ||
              (belongsToOwnedChildThread &&
                event.subagent.runId === null &&
                event.subagent.origin === "provider_native")
            ) {
              yield* Ref.update(openRunOwnedSubagents, (current) => {
                const withLink = withLinkedChildThreadId(current, event.subagent.childThreadId);
                const subagents = new Map(withLink.subagents);
                if (isSettledSubagentStatus(event.subagent.status)) {
                  subagents.delete(event.subagent.id);
                } else {
                  subagents.set(event.subagent.id, event.subagent);
                }
                return { ...withLink, subagents };
              });
            }
          }
          if (event.type === "node.updated") {
            const belongsToRootSubagent =
              event.node.kind === "subagent" && event.node.runId === input.run.id;
            const belongsToOwnedChildThread =
              event.node.threadId !== input.run.threadId &&
              routing.ownedThreadIds.has(event.node.threadId);
            if (
              !belongsToRootSubagent &&
              !(
                belongsToOwnedChildThread &&
                (event.node.runId === null || event.node.runId === input.run.id)
              )
            ) {
              return;
            }
            yield* Ref.update(openRunOwnedSubagents, (current) => {
              const nodes = new Map(current.nodes);
              if (isOpenExecutionNodeStatus(event.node.status)) {
                nodes.set(event.node.id, event.node);
              } else {
                nodes.delete(event.node.id);
              }
              return { ...current, nodes };
            });
          }
          if (event.type === "turn_item.updated") {
            const belongsToRootRun = event.turnItem.runId === input.run.id;
            const belongsToOwnedChildThread =
              event.turnItem.threadId !== input.run.threadId &&
              routing.ownedThreadIds.has(event.turnItem.threadId);
            const belongsToInheritedBackgroundItem =
              event.turnItem.threadId === input.run.threadId &&
              event.turnItem.runId !== null &&
              inheritedBackgroundTurnItemsById.get(event.turnItem.id) === event.turnItem.runId;
            if (
              backgroundCapableTurnItemTypes.has(event.turnItem.type) &&
              (belongsToRootRun || belongsToOwnedChildThread || belongsToInheritedBackgroundItem)
            ) {
              yield* Ref.update(activeBackgroundTurnItems, (current) => {
                const next = new Set(current);
                if (isSettledTurnItemStatus(event.turnItem.status)) {
                  next.delete(event.turnItem.id);
                } else {
                  next.add(event.turnItem.id);
                }
                return next;
              });
            }
            if (
              belongsToOwnedChildThread &&
              (event.turnItem.runId === null || belongsToRootRun) &&
              deliverable
            ) {
              yield* Ref.update(openRunOwnedSubagents, (current) => {
                const childTurnItems = new Map(current.childTurnItems);
                if (isSettledTurnItemStatus(event.turnItem.status)) {
                  childTurnItems.delete(event.turnItem.id);
                } else {
                  childTurnItems.set(event.turnItem.id, event.turnItem);
                }
                return { ...current, childTurnItems };
              });
            }
            if (belongsToRootRun && event.turnItem.type === "subagent") {
              const subagentItem = event.turnItem;
              yield* Ref.update(openRunOwnedSubagents, (current) => {
                const withLink = withLinkedChildThreadId(current, subagentItem.childThreadId);
                const turnItems = new Map(withLink.turnItems);
                if (isSettledTurnItemStatus(subagentItem.status)) {
                  turnItems.delete(subagentItem.subagentId);
                } else {
                  turnItems.set(subagentItem.subagentId, subagentItem);
                }
                return { ...withLink, turnItems };
              });
            }
          }
        });
        const agentTurnsSettled = Effect.gen(function* () {
          if (!(yield* Ref.get(rootTerminalSeen))) {
            return false;
          }
          const terminal = yield* Ref.get(terminalEvent);
          if (
            terminal !== null &&
            terminal.status !== "completed" &&
            !childTurnsContinue(terminal)
          ) {
            return true;
          }
          if (pendingBackgroundProviderTurns.size > 0) {
            return false;
          }
          const childProviderTurns = yield* Ref.get(activeChildProviderTurns);
          if (childProviderTurns.size > 0) {
            return false;
          }
          const childSubagents = yield* Ref.get(activeChildSubagents);
          return childSubagents.size === 0;
        });
        const shouldStopProviderEventIngestion = Effect.gen(function* () {
          if (!(yield* agentTurnsSettled)) {
            return false;
          }
          const terminal = yield* Ref.get(terminalEvent);
          if (
            terminal !== null &&
            terminal.status !== "completed" &&
            !childTurnsContinue(terminal)
          ) {
            return true;
          }
          // Newly owned items depend on adapters emitting a non-terminal event before the root
          // terminal. Owner loss (a newer run claimed lastRunOrdinal) must not close this stream
          // while these sets are non-empty: turn_item.updated writes are not ownership-gated, so
          // late completions still land.
          const backgroundItems = yield* Ref.get(activeBackgroundTurnItems);
          if (backgroundItems.size > 0) {
            return false;
          }
          if (yield* Ref.get(providerThreadOwnerLost)) {
            return true;
          }
        // Claude background Bash has no turn-item projection. Use only the
        // thread-scoped probe: session-wide pending work (siblings, wake
        // buffers, session subagents) must not pin this root subscription.
        const latestProviderThreadSnapshot = yield* Ref.get(latestProviderThread);
        if (input.session.hasPendingBackgroundWorkForThread !== undefined) {
          const hasPendingWork = yield* input.session
            .hasPendingBackgroundWorkForThread(latestProviderThreadSnapshot)
            .pipe(Effect.catchCause(() => Effect.succeed(false)));
          if (hasPendingWork) {
            return false;
          }
        }
        return true;
        });

    return { finalizeRootRun, trackChildLifecycle, agentTurnsSettled, shouldStopProviderEventIngestion };
  });
