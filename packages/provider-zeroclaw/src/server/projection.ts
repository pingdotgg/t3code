// Pure mapping from a ZeroClaw session/update to T3 events.
// Text coalescing lives in the adapter; this function accumulates the text
// deltas it receives and emits the cumulative text a client renders.
import {
  MessageId,
  NodeId,
  PlanId,
  ProviderSessionId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  RuntimeRequestId,
  ThreadId,
  TurnItemId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2TurnItem,
  type OrchestrationV2Subagent,
  type ProviderApprovalDecision,
} from "@t3tools/contracts";
import type { ProviderAdapterV2Event } from "@t3tools/provider-core/server/ProviderAdapter";
import { makeProviderFailureTurnItem } from "@t3tools/provider-core/server/failure";
import {
  makeSubagentChildThread,
  makeSubagentConversationArtifacts,
  subagentThreadTitle,
} from "@t3tools/provider-core/server/subagentProjection";
import * as DateTime from "effect/DateTime";

import type { SessionUpdate } from "./protocol.ts";
import { subagentCallFromToolCall, subagentOutcomeFromToolResult } from "./subagents.ts";

export const ZEROCLAW_PROVIDER = ProviderDriverKind.make("zeroclaw");

export const ZEROCLAW_CAPABILITIES: OrchestrationV2ProviderCapabilities = {
  sessions: {
    supportsMultipleProviderThreadsPerSession: true,
    supportsModelSwitchInSession: true,
    supportsProviderSwitchingViaHandoff: true,
    supportsRuntimeModeSwitchInSession: false,
    pendingRequestsSurviveRestart: false,
  },
  threads: {
    canCreateEmptyThread: true,
    canReadThreadSnapshot: true,
    canRollbackThread: false,
    canForkThread: false,
    canForkFromTurn: false,
    canForkFromSubagentThread: false,
    exposesNativeThreadId: true,
  },
  turns: {
    exposesNativeTurnId: false,
    emitsTurnStarted: true,
    emitsTurnCompleted: true,
    supportsInterrupt: true,
    supportsActiveSteering: true,
    supportsSteeringByInterruptRestart: false,
    supportsQueuedMessages: true,
    terminalStatusQuality: "strong",
  },
  streaming: {
    streamsAssistantText: true,
    streamsReasoning: true,
    streamsToolOutput: true,
    streamsPlanText: false,
    emitsMessageCompleted: true,
  },
  tools: {
    exposesToolItemIds: true,
    emitsToolStarted: true,
    emitsToolCompleted: true,
    emitsToolOutput: true,
    supportsMcpTools: false,
    supportsDynamicToolCallbacks: false,
  },
  approvals: {
    supportsCommandApproval: true,
    supportsFileReadApproval: true,
    supportsFileChangeApproval: true,
    supportsApplyPatchApproval: false,
    approvalsHaveNativeRequestIds: true,
    approvalCallbacksAreLiveOnly: true,
    approvalsCanOriginateFromSubagents: false,
  },
  planning: {
    emitsPlanUpdated: false,
    emitsTodoList: true,
    emitsProposedPlan: false,
    supportsStructuredQuestions: false,
    planDeltasHaveItemIds: false,
  },
  subagents: {
    supportsSubagents: true,
    exposesSubagentThreadIds: true,
    emitsSubagentLifecycle: true,
    canWaitForSubagents: false,
    canCloseSubagents: false,
    canForkSubagentThread: false,
  },
  context: {
    acceptsSystemContext: false,
    acceptsDeveloperContext: false,
    acceptsSyntheticUserContext: true,
    canGenerateSummaries: false,
    canConsumeHandoffSummaries: true,
    supportsDeltaHandoff: true,
    supportsFullThreadHandoff: true,
    maxRecommendedHandoffChars: null,
  },
  checkpointing: {
    appCanCheckpointFilesystem: true,
    supportsNestedCheckpointScopes: true,
    providerCanRollbackConversation: false,
    providerRollbackReturnsSnapshot: false,
    providerCanReadConversationSnapshot: true,
  },
  identity: {
    nativeThreadIds: "strong",
    nativeTurnIds: "weak",
    nativeItemIds: "strong",
    nativeRequestIds: "strong",
  },
  runtimePolicy: { enforcement: "client-boundary" },
};

export interface ProjectionIdentity {
  readonly threadId: ThreadId;
  readonly runId: NonNullable<OrchestrationV2TurnItem["runId"]>;
  readonly nodeId: NodeId;
  readonly providerThreadId: ProviderThreadId;
  readonly providerTurnId: ProviderTurnId;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerSessionId: ProviderSessionId;
  readonly ordinal: number;
  /** The app thread this turn runs on, so a subagent can open a child thread. */
  readonly appThread?: OrchestrationV2AppThread;
  readonly modelSelection?: ModelSelection;
}

export interface ProjectionState {
  readonly identity: ProjectionIdentity;
  /** Advances with the update being projected; timestamps on emitted rows read it. */
  now: DateTime.Utc;
  readonly items: Map<
    string,
    { readonly id: TurnItemId; readonly ordinal: number; readonly startedAt: DateTime.Utc }
  >;
  /** Tool call id → the call that opened the card, so a result patches it in place. */
  readonly tools: Map<
    string,
    {
      readonly itemId: TurnItemId;
      readonly nativeId: string;
      readonly name: string;
      readonly command: boolean;
      readonly input: unknown;
      readonly ordinal: number;
      readonly startedAt: DateTime.Utc;
    }
  >;
  readonly subagents: Map<
    string,
    { readonly record: OrchestrationV2Subagent; readonly hasChildThread: boolean }
  >;
  /** Cumulative text per streamed row; `settled` is assistant text closed by earlier tool calls. */
  readonly text: { assistant: string; reasoning: string; settled: string };
  /** Text rows close at each tool call, so later text opens a new row below the card. */
  segment: number;
  nextOrdinal: number;
}

export interface ProjectedUpdate {
  readonly events: ReadonlyArray<ProviderAdapterV2Event>;
  readonly tokenUsage?: { readonly usedTokens: number; readonly maxTokens?: number };
}

const SHELL_TOOLS = new Set(["shell", "bash"]);

const SUBAGENT_PROMPT_ORDINAL = 100;

function textOf(value: unknown): string {
  if (typeof value === "string") return value;
  if (value === undefined || value === null) return "";
  return JSON.stringify(value) ?? "";
}

function baseItem(state: ProjectionState, id: TurnItemId, nativeId: string) {
  const stored = state.items.get(nativeId);
  return {
    id,
    threadId: state.identity.threadId,
    runId: state.identity.runId,
    nodeId: state.identity.nodeId,
    providerThreadId: state.identity.providerThreadId,
    providerTurnId: state.identity.providerTurnId,
    nativeItemRef: { driver: ZEROCLAW_PROVIDER, nativeId, strength: "strong" as const },
    parentItemId: null,
    ordinal: stored?.ordinal ?? state.nextOrdinal,
    status: "running" as const,
    title: null,
    startedAt: stored?.startedAt ?? state.now,
    completedAt: null,
    updatedAt: state.now,
  };
}

function itemId(state: ProjectionState, nativeId: string): TurnItemId {
  const existing = state.items.get(nativeId);
  if (existing !== undefined) return existing.id;
  const id = TurnItemId.make(`zc-item-${state.identity.providerTurnId}-${nativeId}`);
  state.items.set(nativeId, { id, ordinal: ++state.nextOrdinal, startedAt: state.now });
  return id;
}

function segmentSuffix(state: ProjectionState) {
  return state.segment === 0 ? "" : `-${state.segment}`;
}

function assistantMessageId(state: ProjectionState) {
  return MessageId.make(`zc-msg-${state.identity.providerTurnId}${segmentSuffix(state)}`);
}

function settleTextSegment(state: ProjectionState): ReadonlyArray<ProviderAdapterV2Event> {
  if (state.text.assistant.length === 0 && state.text.reasoning.length === 0) return [];
  const events = [
    ...reasoningEvents(state, false, "completed"),
    ...assistantEvents(state, false, "completed"),
  ];
  state.text.settled += state.text.assistant;
  state.text.assistant = "";
  state.text.reasoning = "";
  state.segment += 1;
  return events;
}

/** Completion content may repeat text already settled into earlier rows. */
function finalAssistantText(state: ProjectionState, content: string | undefined): string {
  if (content === undefined || content.length === 0) return state.text.assistant;
  const settled = state.text.settled;
  if (settled.length > 0 && content.startsWith(settled)) {
    return content.slice(settled.length).trimStart();
  }
  return content;
}

function textStatus(
  state: ProjectionState,
  streaming: boolean,
  status: OrchestrationV2TurnItem["status"],
) {
  return {
    status,
    completedAt: streaming ? null : state.now,
    updatedAt: state.now,
  };
}

/**
 * The pair every provider emits for streamed text: the turn row a client
 * renders, and the message row it links to. A client only lists conversation
 * messages, so an assistant row without its `message.updated` is invisible.
 */
function assistantEvents(
  state: ProjectionState,
  streaming: boolean,
  status: OrchestrationV2TurnItem["status"],
): ReadonlyArray<ProviderAdapterV2Event> {
  const text = state.text.assistant;
  if (text.length === 0) return [];
  const nativeId = `assistant${segmentSuffix(state)}`;
  const id = itemId(state, nativeId);
  const messageId = assistantMessageId(state);
  const base = baseItem(state, id, nativeId);
  const message: OrchestrationV2ConversationMessage = {
    createdBy: "agent",
    creationSource: "provider",
    id: messageId,
    threadId: state.identity.threadId,
    runId: state.identity.runId,
    nodeId: state.identity.nodeId,
    role: "assistant",
    text,
    attachments: [],
    streaming,
    createdAt: base.startedAt,
    updatedAt: state.now,
  };
  return [
    {
      type: "turn_item.updated",
      driver: ZEROCLAW_PROVIDER,
      turnItem: {
        ...base,
        ...textStatus(state, streaming, status),
        type: "assistant_message",
        messageId,
        text,
        streaming,
      },
    },
    { type: "message.updated", driver: ZEROCLAW_PROVIDER, message },
  ];
}

function reasoningEvents(
  state: ProjectionState,
  streaming: boolean,
  status: OrchestrationV2TurnItem["status"],
): ReadonlyArray<ProviderAdapterV2Event> {
  const text = state.text.reasoning;
  if (text.length === 0) return [];
  const nativeId = `reasoning${segmentSuffix(state)}`;
  const id = itemId(state, nativeId);
  return [
    {
      type: "turn_item.updated",
      driver: ZEROCLAW_PROVIDER,
      turnItem: {
        ...baseItem(state, id, nativeId),
        ...textStatus(state, streaming, status),
        type: "reasoning",
        text,
        streaming,
      },
    },
  ];
}

function terminalItemStatus(
  outcome: "completed" | "cancelled" | "failed",
): OrchestrationV2TurnItem["status"] {
  return outcome === "completed" ? "completed" : outcome === "cancelled" ? "cancelled" : "failed";
}

/** Readable text for a `history_trimmed` or `budget_warning` notice. */
function noticeMessage(update: SessionUpdate): string {
  if (update.type === "history_trimmed" && "reason" in update) {
    const dropped =
      "droppedMessages" in update && typeof update.droppedMessages === "number"
        ? ` (${update.droppedMessages} messages dropped)`
        : "";
    return `Context trimmed: ${update.reason ?? "history over budget"}${dropped}`;
  }
  if (update.type === "budget_warning" && "currentUsd" in update) {
    const spent = update.currentUsd === undefined ? "" : ` $${update.currentUsd.toFixed(2)}`;
    const limit =
      "limitUsd" in update && update.limitUsd !== undefined
        ? ` of $${update.limitUsd.toFixed(2)}`
        : "";
    return `Budget warning:${spent}${limit} spent`;
  }
  return update.type;
}

function subagentEvents(
  state: ProjectionState,
  toolCallId: string,
  name: string,
  input: unknown,
): ReadonlyArray<ProviderAdapterV2Event> {
  const call = subagentCallFromToolCall(name, input);
  if (call === null) return [];
  const appThread = state.identity.appThread;
  const modelSelection = state.identity.modelSelection;
  const scope = state.identity.providerTurnId;
  const subagentId = NodeId.make(`zc-subagent-${scope}-${toolCallId}`);
  const childThreadId = ThreadId.make(`zc-child-${scope}-${toolCallId}`);
  const subagent = {
    id: subagentId,
    threadId: state.identity.threadId,
    runId: state.identity.runId,
    parentNodeId: state.identity.nodeId,
    origin: "provider_native" as const,
    createdBy: "agent" as const,
    driver: ZEROCLAW_PROVIDER,
    providerInstanceId: state.identity.providerInstanceId,
    providerThreadId: state.identity.providerThreadId,
    childThreadId,
    nativeTaskRef: { driver: ZEROCLAW_PROVIDER, nativeId: toolCallId, strength: "strong" as const },
    prompt: call.prompt,
    title: call.title,
    model: null,
    status: "running" as const,
    result: null,
    startedAt: state.now,
    completedAt: null,
    updatedAt: state.now,
  };
  state.subagents.set(toolCallId, {
    record: subagent,
    hasChildThread: appThread !== undefined && modelSelection !== undefined,
  });
  if (appThread === undefined || modelSelection === undefined) {
    return [{ type: "subagent.updated", driver: ZEROCLAW_PROVIDER, subagent }];
  }
  // Without the child thread the card points at a thread that does not exist.
  const childThread = makeSubagentChildThread({
    parentThread: appThread,
    childThreadId,
    parentNodeId: state.identity.nodeId,
    activeProviderThreadId: null,
    providerInstanceId: state.identity.providerInstanceId,
    modelSelection,
    title: subagentThreadTitle({
      parentTitle: appThread.title,
      title: call.title,
      prompt: call.prompt,
      ordinal: state.subagents.size,
    }),
    now: state.now,
    createdBy: "agent",
    creationSource: "provider",
  });
  const promptArtifacts = makeSubagentConversationArtifacts({
    senderThreadId: state.identity.threadId,
    messageId: MessageId.make(`zc-submsg-${scope}-${toolCallId}`),
    turnItemId: TurnItemId.make(`zc-subprompt-${scope}-${toolCallId}`),
    threadId: childThreadId,
    rootNodeId: state.identity.nodeId,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: {
      driver: ZEROCLAW_PROVIDER,
      nativeId: `${toolCallId}:prompt`,
      strength: "weak",
    },
    role: "user",
    text: call.prompt,
    ordinal: SUBAGENT_PROMPT_ORDINAL,
    now: state.now,
  });
  return [
    { type: "app_thread.created", driver: ZEROCLAW_PROVIDER, appThread: childThread },
    { type: "message.updated", driver: ZEROCLAW_PROVIDER, message: promptArtifacts.message },
    { type: "turn_item.updated", driver: ZEROCLAW_PROVIDER, turnItem: promptArtifacts.turnItem },
    { type: "subagent.updated", driver: ZEROCLAW_PROVIDER, subagent },
  ];
}

function terminalEvents(
  state: ProjectionState,
  outcome: "completed" | "cancelled" | "failed",
  content: string | undefined,
): ReadonlyArray<ProviderAdapterV2Event> {
  if (outcome !== "failed") {
    state.text.assistant = finalAssistantText(state, content);
    return [
      ...reasoningEvents(state, false, terminalItemStatus(outcome)),
      ...assistantEvents(state, false, terminalItemStatus(outcome)),
      {
        type: "turn.terminal",
        driver: ZEROCLAW_PROVIDER,
        providerThreadId: state.identity.providerThreadId,
        providerTurnId: state.identity.providerTurnId,
        runOrdinal: state.identity.ordinal,
        status: outcome,
        failure: null,
        threadDisposition: "reusable",
      },
    ];
  }
  const failure: OrchestrationV2ProviderFailure = {
    class: "provider_error",
    message: content !== undefined && content.length > 0 ? content : "ZeroClaw turn failed.",
    code: null,
    retryable: null,
  };
  const failureItem = makeProviderFailureTurnItem({
    driver: ZEROCLAW_PROVIDER,
    threadId: state.identity.threadId,
    runId: state.identity.runId,
    nodeId: state.identity.nodeId,
    providerThreadId: state.identity.providerThreadId,
    providerTurnId: state.identity.providerTurnId,
    itemOrdinal: ++state.nextOrdinal,
    failure,
    occurredAt: state.now,
  });
  return [
    ...reasoningEvents(state, false, "failed"),
    ...assistantEvents(state, false, "completed"),
    { type: "turn_item.updated", driver: ZEROCLAW_PROVIDER, turnItem: failureItem },
    {
      type: "turn.terminal",
      driver: ZEROCLAW_PROVIDER,
      providerThreadId: state.identity.providerThreadId,
      providerTurnId: state.identity.providerTurnId,
      runOrdinal: state.identity.ordinal,
      failureItemOrdinal: failureItem.ordinal,
      status: "failed",
      failure,
      threadDisposition: "reusable",
    },
  ];
}

/**
 * Map one decoded session/update to the events it produces. Unknown types
 * produce no events. Mutates `state.items`, `state.tools`, `state.text`, and
 * `state.subagents` so later updates land on the rows earlier ones opened.
 */
export function sessionUpdateToEvents(
  state: ProjectionState,
  update: SessionUpdate,
): ProjectedUpdate {
  const { identity } = state;
  switch (update.type) {
    case "agent_message_chunk":
    case "agent_thought_chunk": {
      if (!("text" in update)) return { events: [] };
      const kind = update.type === "agent_message_chunk" ? "assistant" : "reasoning";
      state.text[kind] += update.text;
      return {
        events:
          kind === "assistant"
            ? assistantEvents(state, true, "running")
            : reasoningEvents(state, true, "running"),
      };
    }
    case "tool_call": {
      if (!("toolCallId" in update)) return { events: [] };
      const settledText = settleTextSegment(state);
      const id = itemId(state, update.toolCallId);
      const command = SHELL_TOOLS.has(update.name);
      const input = update.input ?? {};
      state.tools.set(update.toolCallId, {
        itemId: id,
        nativeId: update.toolCallId,
        name: update.name,
        command,
        input,
        ordinal: state.nextOrdinal,
        startedAt: state.now,
      });
      const item: OrchestrationV2TurnItem = command
        ? {
            ...baseItem(state, id, update.toolCallId),
            title: update.name,
            type: "command_execution",
            input: textOf(input),
          }
        : {
            ...baseItem(state, id, update.toolCallId),
            title: update.name,
            type: "dynamic_tool",
            toolName: update.name,
            input,
          };
      return {
        events: [
          ...settledText,
          { type: "turn_item.updated", driver: ZEROCLAW_PROVIDER, turnItem: item },
          ...subagentEvents(state, update.toolCallId, update.name, update.input),
        ],
      };
    }
    case "tool_result": {
      if (!("toolCallId" in update)) return { events: [] };
      const call = state.tools.get(update.toolCallId);
      const id = call?.itemId ?? itemId(state, update.toolCallId);
      const failed = update.status === "failed";
      const output = textOf(update.output);
      const shell = call?.command === true;
      const outputField = output.length > 0 ? { output } : {};
      const item: OrchestrationV2TurnItem = shell
        ? {
            ...baseItem(state, id, update.toolCallId),
            ordinal: call?.ordinal ?? state.nextOrdinal,
            title: call?.name ?? update.name ?? update.toolCallId,
            type: "command_execution",
            input: textOf(call?.input ?? {}),
            ...outputField,
            status: failed ? "failed" : "completed",
            completedAt: state.now,
          }
        : {
            ...baseItem(state, id, update.toolCallId),
            ordinal: call?.ordinal ?? state.nextOrdinal,
            title: call?.name ?? update.name ?? update.toolCallId,
            type: "dynamic_tool",
            toolName: call?.name ?? update.name ?? update.toolCallId,
            input: call?.input ?? {},
            ...outputField,
            status: failed ? "failed" : "completed",
            completedAt: state.now,
          };
      const events: ProviderAdapterV2Event[] = [
        { type: "turn_item.updated", driver: ZEROCLAW_PROVIDER, turnItem: item },
      ];
      const subagent = state.subagents.get(update.toolCallId);
      if (subagent !== undefined) {
        const outcome = subagentOutcomeFromToolResult(update.output);
        events.push({
          type: "subagent.updated",
          driver: ZEROCLAW_PROVIDER,
          subagent: {
            ...subagent.record,
            status: failed ? "failed" : outcome.status,
            result: outcome.result,
            completedAt: state.now,
            updatedAt: state.now,
          },
        });
        if (
          subagent.hasChildThread &&
          subagent.record.childThreadId !== null &&
          outcome.result !== null
        ) {
          const resultArtifacts = makeSubagentConversationArtifacts({
            messageId: MessageId.make(`zc-subresult-${subagent.record.id}`),
            turnItemId: TurnItemId.make(`zc-subresult-${subagent.record.id}`),
            threadId: subagent.record.childThreadId,
            rootNodeId: identity.nodeId,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: {
              driver: ZEROCLAW_PROVIDER,
              nativeId: `${update.toolCallId}:result`,
              strength: "weak",
            },
            role: "assistant",
            text: outcome.result,
            ordinal: SUBAGENT_PROMPT_ORDINAL + 1,
            now: state.now,
          });
          events.push(
            {
              type: "message.updated",
              driver: ZEROCLAW_PROVIDER,
              message: resultArtifacts.message,
            },
            {
              type: "turn_item.updated",
              driver: ZEROCLAW_PROVIDER,
              turnItem: resultArtifacts.turnItem,
            },
          );
        }
      }
      return { events };
    }
    case "approval_request": {
      if (!("requestId" in update)) return { events: [] };
      const requestId = RuntimeRequestId.make(update.requestId);
      const id = itemId(state, update.requestId);
      return {
        events: [
          {
            type: "turn_item.updated",
            driver: ZEROCLAW_PROVIDER,
            turnItem: {
              ...baseItem(state, id, update.requestId),
              status: "waiting",
              title: update.toolName,
              type: "approval_request",
              requestId,
              requestKind: "command",
              ...(update.argumentsSummary === undefined ? {} : { prompt: update.argumentsSummary }),
            },
          },
          {
            type: "runtime_request.updated",
            driver: ZEROCLAW_PROVIDER,
            threadId: identity.threadId,
            runtimeRequest: {
              id: requestId,
              nodeId: identity.nodeId,
              providerTurnId: identity.providerTurnId,
              nativeRequestRef: {
                driver: ZEROCLAW_PROVIDER,
                nativeId: update.requestId,
                strength: "strong",
              },
              kind: "command",
              status: "pending",
              responseCapability: {
                type: "live",
                providerSessionId: identity.providerSessionId,
              },
              createdAt: state.now,
              resolvedAt: null,
            },
          },
        ],
      };
    }
    case "plan":
      if (!("items" in update)) return { events: [] };
      return {
        events: [
          {
            type: "turn_item.updated",
            driver: ZEROCLAW_PROVIDER,
            turnItem: {
              ...baseItem(state, itemId(state, "plan"), "plan"),
              status: "completed",
              completedAt: state.now,
              type: "todo_list",
              planId: PlanId.make(`zc-plan-${identity.providerTurnId}`),
              steps: update.items.map((step, index) => ({
                id: `step-${index}`,
                text: step.content,
                status:
                  step.status === "completed"
                    ? "completed"
                    : step.status === "in_progress" || step.status === "running"
                      ? "running"
                      : "pending",
              })),
            },
          },
        ],
      };
    case "context_usage":
      return {
        events: [],
        ...("usedTokens" in update && update.usedTokens !== undefined
          ? {
              tokenUsage: {
                usedTokens: update.usedTokens,
                ...("maxTokens" in update && update.maxTokens !== undefined
                  ? { maxTokens: update.maxTokens }
                  : {}),
              },
            }
          : {}),
      };
    case "history_trimmed":
    case "budget_warning": {
      const message = noticeMessage(update);
      return {
        events: [
          {
            type: "turn_item.updated",
            driver: ZEROCLAW_PROVIDER,
            turnItem: {
              ...baseItem(state, itemId(state, update.type), update.type),
              status: "completed",
              completedAt: state.now,
              type: "system_notice",
              message,
            },
          },
        ],
      };
    }
    case "turn_complete":
      if (!("outcome" in update)) return { events: [] };
      return {
        events: terminalEvents(
          state,
          update.outcome,
          update.content === undefined ? undefined : update.content,
        ),
      };
    default:
      return { events: [] };
  }
}

/** Map a T3 approval decision to the ZeroClaw decision the daemon accepts. */
export function approvalDecisionToZeroClaw(
  decision: ProviderApprovalDecision,
): "allow_once" | "allow_always" | "reject" {
  switch (decision) {
    case "accept":
      return "allow_once";
    case "acceptForSession":
    case "acceptAlways":
      return "allow_always";
    default:
      return "reject";
  }
}

/** Split a `provider/model` slug. `default` and a slug with no slash return null. */
export function splitModelSlug(slug: string): { model: string; modelProvider: string } | null {
  if (slug === "default") return null;
  const separator = slug.indexOf("/");
  if (separator <= 0 || separator === slug.length - 1) return null;
  return { modelProvider: slug.slice(0, separator), model: slug.slice(separator + 1) };
}

export const AGENT_MISMATCH_MESSAGE = (current: string, requested: string) =>
  `This thread runs agent \`${current}\`. Start a new thread to use agent \`${requested}\`.`;

export const DEFAULT_RESTORE_MESSAGE = (model: string) =>
  `This thread already switched to \`${model}\`. ZeroClaw cannot restore the agent default in a live session. Start a new thread to use the agent's configured model.`;

export const NO_AGENT_MESSAGE =
  "No ZeroClaw agent is selected. Set a default agent in provider settings (defaultAgentAlias) or choose one for this thread.";
