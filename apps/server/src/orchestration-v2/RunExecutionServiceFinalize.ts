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
  cascadeTerminalizeRunOwnedSubagents,
  childTurnsContinue,
  emptyOpenRunOwnedSubagentProjection,
  finalProviderThreadStatus,
  isRunOwnedSubagentTerminalStatus,
} from "./RunExecutionServiceRouting.ts";
import type {
  OpenRunOwnedSubagentProjection,
  ProviderTerminalEvent,
} from "./RunExecutionServiceRouting.ts";

export interface RunExecutionFinalizeDeps {
  readonly eventSink: EventSink.EventSinkV2["Service"];
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly turnAnalytics: {
    readonly runSettled: (
      report: ProviderUsageAnalytics.RunSettledReport,
    ) => Effect.Effect<void>;
  };
}

export const makeWriteFinalRunEvents = (deps: RunExecutionFinalizeDeps) => {
  const { eventSink, idAllocator, turnAnalytics } = deps;

    const writeFinalRunEvents = Effect.fn("RunExecutionService.writeFinalRunEvents")(
      function* (input: {
        readonly run: OrchestrationV2Run;
        readonly rootNode: OrchestrationV2ExecutionNode;
        readonly checkpointScope: OrchestrationV2CheckpointScope;
        readonly providerThread: OrchestrationV2ProviderThread;
        readonly attempt: OrchestrationV2RunAttempt;
        readonly shouldFinalizeRun?: () => Effect.Effect<boolean, ProjectionStoreV2Error>;
        readonly hasUnpairedRunInterruptRequest?: () => Effect.Effect<boolean, never>;
        readonly loadRunInterruptReason?: () => Effect.Effect<string | undefined, never>;
        readonly openRunOwnedSubagents?: OpenRunOwnedSubagentProjection;
        // Root turn snapshot written with the run when T3 ends the run itself.
        readonly abandonedProviderTurn?: OrchestrationV2ProviderTurn;
        readonly terminal: ProviderTerminalEvent;
        readonly completedAt?: DateTime.Utc;
        readonly failureItemPersisted: boolean;
        readonly refreshAfterTurn: Effect.Effect<void>;
        readonly writeIfRunCurrent?: {
          readonly activeAttemptId: RunAttemptId;
          readonly expectedStatus: OrchestrationV2Run["status"];
        };
      }) {
        const completedAt = input.completedAt ?? (yield* DateTime.now);
        const finalizedAttempt: OrchestrationV2RunAttempt = {
          ...input.attempt,
          status: input.terminal.status,
          completedAt,
        };
        const shouldFinalizeRun =
          input.shouldFinalizeRun === undefined ? true : yield* input.shouldFinalizeRun();
        if (!shouldFinalizeRun) {
          if (input.terminal.status === "interrupted") {
            const hasUnpairedRequest =
              input.hasUnpairedRunInterruptRequest === undefined
                ? false
                : yield* input.hasUnpairedRunInterruptRequest();
            if (hasUnpairedRequest) {
              const reason =
                input.loadRunInterruptReason === undefined
                  ? undefined
                  : yield* input.loadRunInterruptReason();
              yield* eventSink.writeWithEffects({
                effects: [],
                events: [
                  {
                    id: yield* idAllocator.allocate.event({ threadId: input.run.threadId }),
                    type: "turn-item.updated" as const,
                    threadId: input.run.threadId,
                    runId: input.run.id,
                    nodeId: input.rootNode.id,
                    providerInstanceId: input.run.providerInstanceId,
                    occurredAt: completedAt,
                    payload: makeInterruptResultTurnItem({
                      idAllocator,
                      run: input.run,
                      rootNode: input.rootNode,
                      providerThread: input.providerThread,
                      reason,
                      completedAt,
                    }),
                  },
                ],
              });
              yield* input.refreshAfterTurn;
            }
          }
          return;
        }
        const allocateEventId = () => idAllocator.allocate.event({ threadId: input.run.threadId });
        const reason =
          input.terminal.status === "interrupted"
            ? ((input.loadRunInterruptReason === undefined
                ? undefined
                : yield* input.loadRunInterruptReason()) ?? input.terminal.reason)
            : undefined;
        const open = input.openRunOwnedSubagents ?? emptyOpenRunOwnedSubagentProjection();
        const hasOpenSubagentProjection =
          open.subagents.size > 0 ||
          open.turnItems.size > 0 ||
          open.childTurnItems.size > 0 ||
          open.nodes.size > 0;
        const cascadedSubagentEvents =
          isRunOwnedSubagentTerminalStatus(input.terminal.status) &&
          !childTurnsContinue(input.terminal) &&
          hasOpenSubagentProjection
            ? yield* cascadeTerminalizeRunOwnedSubagents({
                run: input.run,
                open,
                status: input.terminal.status,
                completedAt,
                allocateEventId,
              })
            : [];
        const persistedStatus =
          input.terminal.status === "completed" ? "waiting" : input.terminal.status;
        // Omit delegatedCompletion; the startup snapshot must not overwrite newer acknowledgements, successors, or Stop barriers.
        const { delegatedCompletion: _delegatedCompletion, ...runWithoutDelegatedCompletion } =
          input.run;
        const finalizedRun: OrchestrationV2Run = {
          ...runWithoutDelegatedCompletion,
          status: persistedStatus,
          completedAt: input.terminal.status === "completed" ? null : completedAt,
        };
        const finalizedRootNode: OrchestrationV2ExecutionNode = {
          ...input.rootNode,
          status: persistedStatus,
          completedAt: input.terminal.status === "completed" ? null : completedAt,
          checkpointScopeId: input.checkpointScope.id,
        };
        const finalizedProviderThread: OrchestrationV2ProviderThread = {
          ...input.providerThread,
          status: finalProviderThreadStatus(input.terminal.threadDisposition),
          updatedAt: completedAt,
        };
        const runEventId = yield* allocateEventId();
        const nodeEventId = yield* allocateEventId();
        const providerThreadEventId = yield* allocateEventId();
        const checkpointCaptureCommandId = CommandId.make(
          `command:effect:checkpoint.capture:${input.run.id}`,
        );
        // Stopped runs capture rollback points for the next message; enqueue before later starts on this effect lane.
        const finalization = {
          effects:
            input.terminal.status === "completed" ||
            input.terminal.status === "interrupted" ||
            input.terminal.status === "cancelled"
              ? [
                  {
                    id: `effect:checkpoint.capture:${input.run.id}`,
                    commandId: checkpointCaptureCommandId,
                    threadId: input.run.threadId,
                    request: {
                      type: "checkpoint.capture" as const,
                      runId: input.run.id,
                      scopeId: input.checkpointScope.id,
                    },
                  },
                ]
              : [],
          events: [
            ...cascadedSubagentEvents,
            ...(input.abandonedProviderTurn === undefined
              ? []
              : [
                  {
                    id: yield* allocateEventId(),
                    type: "provider-turn.updated" as const,
                    threadId: input.run.threadId,
                    runId: input.run.id,
                    nodeId: input.rootNode.id,
                    providerInstanceId: input.run.providerInstanceId,
                    occurredAt: completedAt,
                    payload: input.abandonedProviderTurn,
                  },
                ]),
            {
              id: yield* allocateEventId(),
              type: "run-attempt.updated" as const,
              threadId: input.run.threadId,
              runId: input.run.id,
              nodeId: input.rootNode.id,
              providerInstanceId: input.run.providerInstanceId,
              occurredAt: completedAt,
              payload: finalizedAttempt,
            },
            ...(input.terminal.status === "interrupted"
              ? [
                  {
                    id: yield* allocateEventId(),
                    type: "turn-item.updated" as const,
                    threadId: input.run.threadId,
                    runId: input.run.id,
                    nodeId: input.rootNode.id,
                    providerInstanceId: input.run.providerInstanceId,
                    occurredAt: completedAt,
                    payload: makeInterruptResultTurnItem({
                      idAllocator,
                      run: input.run,
                      rootNode: input.rootNode,
                      providerThread: input.providerThread,
                      reason,
                      completedAt,
                    }),
                  },
                ]
              : []),
            ...(input.terminal.status === "failed" && !input.failureItemPersisted
              ? [
                  {
                    id: yield* allocateEventId(),
                    type: "turn-item.updated" as const,
                    threadId: input.run.threadId,
                    runId: input.run.id,
                    nodeId: input.rootNode.id,
                    providerInstanceId: input.run.providerInstanceId,
                    occurredAt: completedAt,
                    payload: makeProviderFailureTurnItem({
                      driver: input.terminal.driver,
                      threadId: input.run.threadId,
                      runId: input.run.id,
                      nodeId: input.rootNode.id,
                      providerThreadId: input.terminal.providerThreadId,
                      providerTurnId: input.terminal.providerTurnId,
                      itemOrdinal: input.terminal.failureItemOrdinal,
                      failure: input.terminal.failure,
                      occurredAt: completedAt,
                    }),
                  },
                ]
              : []),
            {
              id: runEventId,
              type: "run.updated",
              threadId: input.run.threadId,
              runId: input.run.id,
              nodeId: input.rootNode.id,
              providerInstanceId: input.run.providerInstanceId,
              occurredAt: completedAt,
              payload: finalizedRun,
            },
            {
              id: nodeEventId,
              type: "node.updated",
              threadId: input.run.threadId,
              runId: input.run.id,
              nodeId: input.rootNode.id,
              providerInstanceId: input.run.providerInstanceId,
              occurredAt: completedAt,
              payload: finalizedRootNode,
            },
            {
              id: providerThreadEventId,
              type: "provider-thread.updated",
              threadId: input.run.threadId,
              providerInstanceId: input.run.providerInstanceId,
              occurredAt: completedAt,
              payload: finalizedProviderThread,
            },
          ],
        } satisfies Parameters<typeof eventSink.writeWithEffects>[0];
        if (input.writeIfRunCurrent !== undefined) {
          const result = yield* eventSink.writeIfRunCurrent({
            threadId: input.run.threadId,
            runId: input.run.id,
            activeAttemptId: input.writeIfRunCurrent.activeAttemptId,
            expectedStatus: input.writeIfRunCurrent.expectedStatus,
            events: finalization.events,
            effects: finalization.effects,
          });
          if (!result.committed) {
            return;
          }
        } else {
          yield* eventSink.writeWithEffects(finalization);
        }
        yield* turnAnalytics.runSettled({
          runId: input.run.id,
          status: input.terminal.status,
          completedAt,
          childrenRunning: hasOpenSubagentProjection && cascadedSubagentEvents.length === 0,
        });
        yield* input.refreshAfterTurn;
      },
    );

  return writeFinalRunEvents;
};

/**
 * Clients send Stop without a reason; server callers acting for an agent
 * always set one, so a missing reason means a person stopped the run.
 */
export const USER_STOP_REASON = "Stopped by user";

export function makeInterruptResultTurnItem(input: {
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly run: OrchestrationV2Run;
  readonly rootNode: OrchestrationV2ExecutionNode;
  readonly providerThread: OrchestrationV2ProviderThread;
  readonly reason: string | undefined;
  readonly completedAt: DateTime.Utc;
}): OrchestrationV2TurnItem {
  return {
    id: input.idAllocator.derive.runSignalTurnItem({
      runId: input.run.id,
      signal: "interrupt-result",
    }),
    threadId: input.run.threadId,
    runId: input.run.id,
    nodeId: input.rootNode.id,
    providerThreadId: input.providerThread.id,
    providerTurnId: input.rootNode.providerTurnId,
    nativeItemRef: null,
    parentItemId: input.idAllocator.derive.runSignalTurnItem({
      runId: input.run.id,
      signal: "interrupt-request",
    }),
    ordinal: input.run.ordinal * 100 + 98,
    status: "interrupted",
    title: "Interrupted",
    startedAt: input.completedAt,
    completedAt: input.completedAt,
    updatedAt: input.completedAt,
    type: "run_interrupt_result",
    message: input.reason ?? "Stopped by the provider",
  };
}
