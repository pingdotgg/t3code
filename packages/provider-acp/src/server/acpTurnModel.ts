// Extracted from server/adapter.ts.

import {
  acpContentBlockDisplayText,
  parseSessionUpdateEvent,
  toolCallVisibleOutputChanged,
  type AcpToolCallState,
} from "./runtimeModel.ts";
import {
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderRetry,
  type ThreadTokenUsageSnapshot,
  type OrchestrationV2ProviderThreadNativeMetadata,
  type OrchestrationV2PlanArtifact,
  type OrchestrationV2Subagent,
  type ThreadId,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2TurnItem,
  type ProviderThreadId,
  type RuntimeRequestId,
  type OrchestrationV2RuntimeRequest,
  type ProviderApprovalDecision,
  type ProviderUserInputAnswers,
  type OrchestrationV2ConversationMessage,
} from "@t3tools/contracts";
import { toolStatus } from "./acpToolCallProjection.ts";
import { type AcpAdapterV2Flavor } from "./acpAdapterConfig.ts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as EffectAcpErrors from "effect-acp/errors";
import * as EffectAcpSchema from "effect-acp/compat";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

export interface ActiveTextSegment {
  readonly nativeItemId: string;
  readonly startedAt: DateTime.Utc;
  sourceMessageId: string | null;
  text: string;
  // The running node and first text have been emitted.
  emitted: boolean;
  // Text changed since the last emission; a delayed flush is scheduled.
  dirty: boolean;
}

export interface ActiveTextStream {
  current: ActiveTextSegment | null;
  nextSegment: number;
}

export interface AcpNativeBuildConfiguration {
  readonly modeId?: string;
  readonly configOptions: ReadonlyArray<{ readonly id: string; readonly value: string }>;
}

export interface ActiveAcpTurn {
  readonly input: ProviderAdapter.ProviderAdapterV2TurnInput;
  readonly providerTurnId: OrchestrationV2ProviderTurn["id"];
  readonly nativeThreadId: string;
  readonly nativeTurnId: string;
  readonly startedAt: DateTime.Utc;
  readonly completed: Deferred.Deferred<void, never>;
  readonly itemOrdinals: Map<string, number>;
  readonly outgoingPrompt?: ReadonlyArray<EffectAcpSchema.ContentBlock> | undefined;
  consumedPromptMessageId?: string;
  readonly user: ActiveTextStream;
  readonly assistant: ActiveTextStream;
  readonly reasoning: ActiveTextStream;
  providerRetry?:
    | {
        readonly failure: OrchestrationV2ProviderFailure;
        readonly retry: OrchestrationV2ProviderRetry;
        readonly startedAt: DateTime.Utc;
        readonly itemOrdinal: number;
      }
    | undefined;
  contextUsage: ThreadTokenUsageSnapshot | null;
  nativeMetadata: OrchestrationV2ProviderThreadNativeMetadata | null;
  readonly tools: Map<string, AcpToolCallState & { readonly backgroundCommandTaskId?: string }>;
  readonly toolUpdatesSkipped: Map<string, number>;
  readonly toolStartedAt: Map<string, DateTime.Utc>;
  readonly subagents: Map<string, ActiveAcpSubagent>;
  readonly subagentsBySessionId: Map<string, ActiveAcpSubagent>;
  readonly pendingSubagentNotifications: Map<string, Array<EffectAcpSchema.SessionNotification>>;
  readonly toolCallIdsByBackgroundTaskId: Map<string, string>;
  /** Command ACKs register null; terminal results wait here for prompt settlement. */
  readonly backgroundCommands: Map<
    string,
    { readonly status: "completed" | "failed"; readonly output?: string } | null
  >;
  readonly persistentBackgroundTaskIds: Set<string>;
  /** Monitor end notices lack output; wait for hydration or the safety timeout. */
  readonly awaitingBackgroundHydration: Set<string>;
  readonly pendingInjectedReport: Set<string>;
  /** Reports can precede monitor end notices; consume their completion marker without re-arming. */
  earlyInjectedReportObserved: boolean;
  readonly plans: Map<
    string,
    {
      readonly id: OrchestrationV2PlanArtifact["id"];
      readonly startedAt: DateTime.Utc;
      latest: OrchestrationV2PlanArtifact | null;
    }
  >;
  interrupted: boolean;
  finalized: boolean;
  finalizedStatus: "completed" | "interrupted" | "failed" | "cancelled" | null;
  promptSettled: boolean;
  promptSettledStatus: "completed" | "interrupted" | "failed" | "cancelled" | null;
  workAccepted: boolean;
  readonly promptWireSettled: Deferred.Deferred<void, never>;
  /** Completed once `session/prompt` is the runtime's active prompt. */
  readonly promptDispatched: Deferred.Deferred<void, never>;
  /** Clock millis just before `session/prompt` was handed to the runtime. */
  promptSentAt: number | null;
  /** Completed when an update after dispatch matches `cancelAfterPromptStarts.isStart`. */
  readonly promptStarted: Deferred.Deferred<void, never>;
  promptUsage: EffectAcpSchema.Usage | undefined;
  backgroundFinalizeGeneration: number;
  /** The agent's own id for this turn's prompt, from `forkFromTurn.nativeTurnId`. */
  nativePromptId: string | undefined;
}

export type AcpRuntimeTeardownState =
  | { readonly _tag: "Idle" }
  | {
      readonly _tag: "InProgress";
      readonly completed: Deferred.Deferred<void, ProviderAdapter.ProviderAdapterProtocolError>;
    }
  | { readonly _tag: "Failed"; readonly error: ProviderAdapter.ProviderAdapterProtocolError };

export function acpRootSessionUpdateIngestsOutput(
  notification: EffectAcpSchema.SessionNotification,
): boolean {
  const update = notification.update;
  switch (update.sessionUpdate) {
    case "agent_message_chunk":
    case "agent_thought_chunk":
      return (acpContentBlockDisplayText(update.content)?.length ?? 0) > 0;
    case "agent_message":
    case "agent_thought":
      return (update.content ?? []).some(
        (content) => (acpContentBlockDisplayText(content)?.length ?? 0) > 0,
      );
    case "tool_call":
    case "tool_call_update":
    case "plan":
    case "plan_update":
    case "plan_removed":
    case "compaction_update":
    case "compaction_summary_chunk":
      return parseSessionUpdateEvent(notification).events.some(
        (event) => event._tag === "ToolCallUpdated" || event._tag === "PlanUpdated",
      );
    default:
      return false;
  }
}

export function acpPostSettleWakeEvidence(
  notification: EffectAcpSchema.SessionNotification,
  flavor: Pick<AcpAdapterV2Flavor, "extractBackgroundToolMutation"> = {},
): boolean {
  if (!acpRootSessionUpdateIngestsOutput(notification)) return false;
  const update = notification.update;
  if (
    (update.sessionUpdate === "user_message_chunk" ||
      update.sessionUpdate === "agent_message_chunk") &&
    update.content.type === "text"
  ) {
    const text = update.content.text;
    if ((flavor.extractBackgroundToolMutation?.(text) ?? []).length > 0) return false;
    if (update.sessionUpdate === "agent_message_chunk" && text.trim().length === 0) return false;
    if (/<monitor-event\b/i.test(text) || /Monitor\s+["']?[0-9a-f-]{8,}["']?\s+ended/i.test(text)) {
      return false;
    }
  }
  return true;
}

export function acpPostSettleContinuationOfferEvidence(
  notification: EffectAcpSchema.SessionNotification,
  flavor: Pick<AcpAdapterV2Flavor, "extractBackgroundToolMutation" | "normalizeToolCall"> = {},
): boolean {
  if (!acpPostSettleWakeEvidence(notification, flavor)) {
    return false;
  }
  const update = notification.update;
  if (update.sessionUpdate === "agent_message_chunk") {
    return (acpContentBlockDisplayText(update.content)?.trim().length ?? 0) > 0;
  }
  if (update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update") {
    return parseSessionUpdateEvent(notification).events.some((event) => {
      if (event._tag !== "ToolCallUpdated") return false;
      // Grok monitor start ACKs say completed while the task is still running.
      const toolCall = flavor.normalizeToolCall?.(event.toolCall) ?? event.toolCall;
      return toolCall.status === "completed" || toolCall.status === "failed";
    });
  }
  return false;
}

export function acpPostSettleWakeShouldBuffer(
  notification: EffectAcpSchema.SessionNotification,
  backgroundWorkRunning: boolean,
): boolean {
  if (!backgroundWorkRunning) return true;
  const update = notification.update;
  return (
    update.sessionUpdate !== "agent_message_chunk" && update.sessionUpdate !== "agent_thought_chunk"
  );
}

export function acpIsAppOwnedWakeTurn(message: {
  readonly createdBy: string;
  readonly creationSource: string;
}): boolean {
  return message.createdBy === "agent" && message.creationSource === "server";
}

export function acpIsProviderContinuationMessage(message: {
  readonly createdBy: string;
  readonly creationSource: string;
}): boolean {
  return message.createdBy === "agent" && message.creationSource === "provider";
}

export function acpCarryoverTerminalShouldClearContinuation(input: {
  readonly continuationOffered: boolean;
  readonly wakeBufferLength: number;
}): boolean {
  return !input.continuationOffered && input.wakeBufferLength === 0;
}

export function acpTurnStartShouldPreserveContinuation(input: {
  readonly continuationRequested: boolean;
  readonly isContinuationTurn: boolean;
  readonly wakeBufferLength: number;
}): boolean {
  return !input.isContinuationTurn && input.continuationRequested && input.wakeBufferLength > 0;
}

export function acpPostSettleMonitorPromptShouldSuppress(
  mutation:
    | {
        readonly taskId: string;
        readonly status: "running" | "completed" | "failed";
      }
    | undefined,
): boolean {
  return mutation?.status === "running";
}

export function acpCompletedTurnShouldTerminalizeTool(
  tool: AcpToolCallState,
  flavor: Pick<AcpAdapterV2Flavor, "extractBackgroundTaskId" | "extractSubagentUpdate">,
): boolean {
  const status = toolStatus(tool.status);
  if (status !== "pending" && status !== "running") return false;
  if (flavor.extractBackgroundTaskId?.(tool) !== undefined) return false;
  return flavor.extractSubagentUpdate?.(tool) === undefined;
}

export interface ActiveAcpSubagent {
  task: OrchestrationV2Subagent;
  readonly childThreadId: ThreadId;
  readonly childRootNodeId: OrchestrationV2ExecutionNode["id"];
  readonly turnItemId: OrchestrationV2TurnItem["id"];
  turnItemOrdinal: number;
  providerTurnId: OrchestrationV2ProviderTurn["id"];
  readonly parentProviderThreadId: ProviderThreadId;
  childSessionId: string | null;
  assistantText: string;
  readonly assistantMessages: Map<string, string>;
  readonly childItemOrdinals: Map<string, number>;
  nextChildOrdinal: number;
  terminalStatusProjected: boolean;
  readonly toolState: Pick<ActiveAcpTurn, "tools" | "toolUpdatesSkipped" | "toolStartedAt">;
  readonly toolSessionIds: Map<string, string>;
}

export interface AcpNativeChildSession {
  parentSessionId: string | null;
  status: "running" | "completed" | "failed" | "cancelled";
  result: string | null;
  delegationId: string | null;
  prompt: string;
  subagent: ActiveAcpSubagent | undefined;
  owner: ActiveAcpTurn | undefined;
  readonly pending: Array<EffectAcpSchema.SessionNotification>;
}

export function acpSubagentStatusIsTerminal(status: OrchestrationV2Subagent["status"]): boolean {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "interrupted" ||
    status === "cancelled" ||
    status === "idle"
  );
}

export function acpSubagentStatusBlocksTurnSettlement(status: OrchestrationV2Subagent["status"]): boolean {
  return status === "running" || status === "pending";
}

export function acpSubagentHasPendingBackgroundWork(subagent: ActiveAcpSubagent): boolean {
  return (
    acpSubagentStatusBlocksTurnSettlement(subagent.task.status) || !subagent.terminalStatusProjected
  );
}

export type AcpCarryoverSubagents = {
  readonly sessionId: string;
  /** The root's subscriber keeps ingesting, so late child terminals can still project. */
  readonly projectsLateTerminals: boolean;
  readonly subagents: ReadonlyArray<ActiveAcpSubagent>;
};

export type PendingRuntimeRequest = {
  readonly generation: number;
  readonly nativeResponseAcknowledgement: Deferred.Deferred<void, EffectAcpErrors.AcpError>;
  readonly transportRequestId: string;
  readonly requestId: RuntimeRequestId;
  readonly runtimeRequest: OrchestrationV2RuntimeRequest;
  readonly node: OrchestrationV2ExecutionNode;
  readonly turnItem: OrchestrationV2TurnItem;
} & (
  | {
      readonly type: "approval";
      readonly decision: Deferred.Deferred<ProviderApprovalDecision>;
    }
  | {
      readonly type: "user_input";
      readonly answers: Deferred.Deferred<ProviderUserInputAnswers | null>;
    }
);

export interface SnapshotMessageState {
  readonly order: Array<string>;
  readonly messages: Map<string, OrchestrationV2ConversationMessage>;
  loadingRole: "user" | "assistant" | "thought" | null;
  loadingMessageId: string | null;
  loadingIndex: number;
}

export const ACP_STOP_CONFIRM_TIMEOUT_MS = 10_000;

export const TOOL_UPDATE_PERSIST_EVERY = 10;

export const MAX_AGENT_TERMINAL_OUTPUT_CHARS = 320 * 1024;

export function shouldPersistToolUpdate(
  context: Pick<ActiveAcpTurn, "toolUpdatesSkipped">,
  key: string,
  previous: AcpToolCallState | undefined,
  next: AcpToolCallState,
  reportedStatus: AcpToolCallState["status"],
): boolean {
  const skipped = context.toolUpdatesSkipped.get(key) ?? 0;
  const persist =
    reportedStatus === "completed" ||
    reportedStatus === "failed" ||
    previous === undefined ||
    previous.status !== next.status ||
    previous.title !== next.title ||
    toolCallVisibleOutputChanged(previous, next) ||
    skipped + 1 >= TOOL_UPDATE_PERSIST_EVERY;
  context.toolUpdatesSkipped.set(key, persist ? 0 : skipped + 1);
  return persist;
}
