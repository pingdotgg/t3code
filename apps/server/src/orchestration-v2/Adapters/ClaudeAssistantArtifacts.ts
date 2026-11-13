// @effect-diagnostics nodeBuiltinImport:off -- the SDK takes a Node ChildProcess for the CLI.
import { text } from "../unknownField.ts";

import type { ClaudeLedgerUsage, ClaudeModelLedger } from "../../provider/ClaudeTurnTokenUsage.ts";

import { query } from "@anthropic-ai/claude-agent-sdk";
import type {
  PermissionMode,
  SDKMessage,
  SDKRateLimitInfo,
  SDKResultMessage,
} from "@anthropic-ai/claude-agent-sdk";

import type {
  OrchestrationV2ConversationMessage,
  OrchestrationV2ExecutionNode,
  OrchestrationV2ProviderFailure,
  OrchestrationV2ProviderRetry,
  OrchestrationV2ProviderTurn,
  OrchestrationV2Subagent,
  OrchestrationV2AppThread,
  OrchestrationV2TurnItem,
  ThreadId,
} from "@t3tools/contracts";

import * as DateTime from "effect/DateTime";

import * as Deferred from "effect/Deferred";

import type { CompiledClaudeModelSelection } from "../../claudeModelOptions.ts";

import type { ClaudeScopedLimitNames } from "../../provider/claudeUsageLimits.ts";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";

import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import { CLAUDE_PROVIDER } from "./ClaudeProviderIdentity.ts";
import type { ClaudeAgentSdkQuerySession } from "./ClaudeQueryRunnerTypes.ts";
import type { ClaudeMessageUsage } from "./ClaudeProviderIdentity.ts";
import type { ClaudeNativeToolInput } from "./ClaudeToolClassification.ts";
import type { ClaudeRuntimeQueryPolicy } from "./ClaudeRuntimePolicy.ts";
import type { ClaudeToolClassification } from "./ClaudeToolClassification.ts";
import type { ClaudeToolPresentation } from "./ClaudeToolClassification.ts";

export function buildAssistantArtifacts(input: {
  readonly idAllocator: IdAllocator.IdAllocatorV2["Service"];
  readonly turnInput: ProviderAdapter.ProviderAdapterV2TurnInput;
  readonly providerTurnId: OrchestrationV2ProviderTurn["id"];
  readonly nativeItemId: string;
  readonly text: string;
  readonly ordinal: number;
  readonly startedAt: DateTime.Utc;
  readonly completedAt: DateTime.Utc;
}): {
  readonly node: OrchestrationV2ExecutionNode;
  readonly message: OrchestrationV2ConversationMessage;
  readonly turnItem: OrchestrationV2TurnItem;
} {
  const nodeId = input.idAllocator.derive.nodeFromProviderItem({
    driver: CLAUDE_PROVIDER,
    nativeItemId: input.nativeItemId,
  });
  const messageId = input.idAllocator.derive.messageFromProviderItem({
    driver: CLAUDE_PROVIDER,
    nativeItemId: input.nativeItemId,
  });
  const turnItemId = input.idAllocator.derive.turnItemFromProviderItem({
    driver: CLAUDE_PROVIDER,
    nativeItemId: input.nativeItemId,
  });
  const nativeItemRef = {
    driver: CLAUDE_PROVIDER,
    nativeId: input.nativeItemId,
    strength: "strong" as const,
  };

  return {
    node: {
      id: nodeId,
      threadId: input.turnInput.threadId,
      runId: input.turnInput.runId,
      parentNodeId: input.turnInput.rootNodeId,
      rootNodeId: input.turnInput.rootNodeId,
      kind: "assistant_message",
      status: "completed",
      countsForRun: false,
      providerThreadId: input.turnInput.providerThread.id,
      providerTurnId: input.providerTurnId,
      nativeItemRef,
      runtimeRequestId: null,
      checkpointScopeId: null,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
    },
    message: {
      createdBy: "agent",
      creationSource: "provider",
      id: messageId,
      threadId: input.turnInput.threadId,
      runId: input.turnInput.runId,
      nodeId,
      role: "assistant",
      text: input.text,
      attachments: [],
      streaming: false,
      createdAt: input.completedAt,
      updatedAt: input.completedAt,
    },
    turnItem: {
      id: turnItemId,
      threadId: input.turnInput.threadId,
      runId: input.turnInput.runId,
      nodeId,
      providerThreadId: input.turnInput.providerThread.id,
      providerTurnId: input.providerTurnId,
      nativeItemRef,
      parentItemId: null,
      ordinal: input.ordinal,
      status: "completed",
      title: null,
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      updatedAt: input.completedAt,
      type: "assistant_message",
      messageId,
      text: input.text,
      streaming: false,
    },
  };
}

export const CLAUDE_USAGE_LIMIT_WINDOWS = {
  five_hour: "5-hour",
  seven_day: "7-day",
  seven_day_opus: "7-day Opus",
  seven_day_sonnet: "7-day Sonnet",
  seven_day_overage_included: "7-day model",
  overage: "overage",
} satisfies Record<NonNullable<SDKRateLimitInfo["rateLimitType"]>, string>;

export const CLAUDE_USAGE_LIMIT_MAX_WAIT_MS = 30 * 24 * 60 * 60 * 1000;

export function describeClaudeUsageLimit(
  info: SDKRateLimitInfo,
  nowMs: number,
  names: ClaudeScopedLimitNames,
): string {
  const label =
    info.rateLimitType === "seven_day_overage_included" && names.overageIncluded
      ? `7-day ${names.overageIncluded}`
      : info.rateLimitType
        ? CLAUDE_USAGE_LIMIT_WINDOWS[info.rateLimitType]
        : undefined;
  const resetsAtMs = info.resetsAt === undefined ? undefined : info.resetsAt * 1000;
  const waitMs =
    resetsAtMs === undefined || !Number.isFinite(nowMs) ? undefined : resetsAtMs - nowMs;
  const wait =
    waitMs !== undefined && waitMs > 0 && waitMs <= CLAUDE_USAGE_LIMIT_MAX_WAIT_MS
      ? formatClaudeUsageLimitWait(waitMs)
      : undefined;
  return `Claude usage limit reached. This turn is paused until the ${
    label ? `${label} ` : ""
  }limit resets${wait ? ` in ${wait}` : ""}.`;
}

export function formatClaudeUsageLimitWait(waitMs: number): string {
  const totalMinutes = Math.ceil(waitMs / 60_000);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;
  if (hours === 0) return `${totalMinutes}m`;
  return minutes === 0 ? `${hours}h` : `${hours}h ${minutes}m`;
}

export interface ActiveClaudeTurnContext {
  readonly queryPolicy: ClaudeRuntimeQueryPolicy;
  readonly input: ProviderAdapter.ProviderAdapterV2TurnInput;
  readonly nativeThreadId: string;
  readonly nativeTurnId: string;
  nativeMessageCursor: string | null;
  readonly providerTurnId: OrchestrationV2ProviderTurn["id"];
  readonly providerTurnOrdinal: number;
  readonly startedAt: DateTime.Utc;
  readonly itemOrdinals: Map<string, number>;
  readonly assistant: {
    fallbackText: string;
    fallbackNativeItemId: string;
    emittedNativeItemIds: Set<string>;
    // The CLI repeats a notice that ends a prompt as the turn's result text.
    noticeTexts: Set<string>;
  };
  readonly reasoning: {
    messageId: string | null;
    readonly streamBlocks: Map<number, string>;
    readonly nextBlockIndex: Map<string, number>;
    readonly snapshotBlockIndex: Map<string, number>;
    readonly snapshots: Set<string>;
    lastThinking: {
      readonly messageId: string;
      readonly itemId: string;
      readonly text: string;
      readonly followsThinking: boolean;
    } | null;
    readonly blocks: Map<
      string,
      { readonly startedAt: DateTime.Utc; readonly ordinal: number; text: string }
    >;
  };
  // Snapshots repeat message_start input, sometimes as zeros, so only fill gaps in streamed usage.
  // Compaction clears usage without forgetting the root request.
  // `requestedAt` starts the request's prompt cache lifetime.
  streamUsage: {
    readonly messageId: string;
    requestedAt?: DateTime.Utc;
    usage: ClaudeMessageUsage | null;
  } | null;
  compactionTokens: number | undefined;
  readonly toolCalls: Map<string, ActiveClaudeToolCall>;
  // A successful status can precede the boundary that supplies its token counts.
  compaction: Extract<OrchestrationV2TurnItem, { type: "compaction" }> | null;
  readonly ignoredTaskIds: Set<string>;
  readonly announcedUsageLimits: Set<string>;
  authenticationFailureMessage: string | undefined;
  readonly rejectedRateLimitTypes: Set<string>;
  readonly rateLimitResetTimes: Map<string, string | null>;
  latestAssistantRateLimit: {
    readonly type: string | null;
    readonly resetAt: string | null;
  } | null;
  // Set while this turn's latest compaction status reports a failure, with
  // Claude's error text when it sent one.
  compactionFailure: { readonly message: string | undefined } | null;
  // Steers end segments whose usage is excluded from the final result; bill them too, oldest first.
  readonly steeredSegmentUsage: Array<SDKResultMessage["usage"]>;
  // Ledger growth of the steered segments; undefined once any segment's growth is unknown.
  steeredLedgerUsage: ClaudeLedgerUsage | undefined;
  readonly rootModels: Set<string>;
  readonly subagentsByTaskId: Map<string, ActiveClaudeSubagent>;
  readonly subagentsByToolUseId: Map<string, ActiveClaudeSubagent>;
  readonly promptUuid: string | null;
  promptEcho: "pending" | "confirmed";
  promptStarted: boolean;
  nativeWakeStarted: boolean;
  gatedFramesBeforeEcho: number;
  readonly heldRootFrames: Array<SDKMessage>;
}

export interface ActiveClaudeProviderRetry {
  readonly retry: OrchestrationV2ProviderRetry;
  readonly failure: OrchestrationV2ProviderFailure;
  readonly startedAt: DateTime.Utc;
  readonly itemOrdinal: number;
}

export interface ActiveClaudeSubagent {
  task: OrchestrationV2Subagent;
  readonly nativeTaskType: string | undefined;
  readonly confirmedOutcome: ProviderAdapter.ProviderAdapterV2SubagentOutcome | undefined;
  readonly rootNodeId: OrchestrationV2ExecutionNode["id"];
  readonly childThreadId: ThreadId;
  childThread: OrchestrationV2AppThread | null;
  readonly childRootNodeId: OrchestrationV2ExecutionNode["id"];
  readonly turnItemId: OrchestrationV2TurnItem["id"];
  readonly turnItemOrdinal: number;
  readonly runToolUseId: string | null;
  readonly effort: string | undefined;
  nextChildItemOrdinal: number;
  resultItemOrdinal: number | null;
  lastAssistantText: string | null;
  lastAssistantMessageId: string | null;
}

export interface ClaudeLiveQueryContext {
  readonly queryPolicy: ClaudeRuntimeQueryPolicy;
  readonly nativeThreadId: string;
  readonly query: ClaudeAgentSdkQuerySession;
  readonly queryPolicyKey: string;
  selection: CompiledClaudeModelSelection;
  readonly closed: Deferred.Deferred<void, never>;
  lastTurn: ActiveClaudeTurnContext | null;
  // "early" echoes on the first frame; "acknowledged" confirms uuid acceptance, but resume turns can still precede the prompt.
  promptEchoMode: "unknown" | "acknowledged" | "early" | "result_only";
  // The CLI may fall back from the requested mode on its first init frame.
  openedPermissionMode: PermissionMode;
  receivedInit: boolean;
  permissionMode: PermissionMode;
  stopping: boolean;
  readonly subagentsFromEarlierProcesses: ReadonlySet<ActiveClaudeSubagent>;
  // Subagents this process still ran when a replacement took over; only its exit can end them.
  handedOffSubagents: ReadonlySet<ActiveClaudeSubagent>;
  // The SDK's per-process model ledger at the last result; a new process starts at zero.
  modelLedger: ClaudeModelLedger | undefined;
  // Per process, not per session: a relative temp dir follows the cwd this CLI
  // was launched in, and a later turn's cwd can differ.
  readonly taskOutputRoot: string | undefined;
}

export interface ActiveClaudeToolCall {
  readonly nativeItemId: string;
  readonly toolName: string;
  readonly classification: ClaudeToolClassification;
  readonly input: ClaudeNativeToolInput;
  readonly threadId: ThreadId;
  readonly runId: ProviderAdapter.ProviderAdapterV2TurnInput["runId"] | null;
  readonly rootNodeId: OrchestrationV2ExecutionNode["id"];
  readonly parentNodeId: OrchestrationV2ExecutionNode["id"];
  readonly ordinal: number;
  readonly startedAt: DateTime.Utc;
  readonly presentation?: ClaudeToolPresentation;
}

export interface ClaudeSubagentProjectionTarget {
  readonly childThreadId: ThreadId;
  readonly childRootNodeId: OrchestrationV2ExecutionNode["id"];
  readonly nextOrdinal: () => number;
  readonly toolCalls: Map<string, ActiveClaudeToolCall>;
}
