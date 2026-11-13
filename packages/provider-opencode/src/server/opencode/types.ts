/**
 * Session, thread and turn shapes shared by the OpenCode v1 session helpers.
 */
import type {
  Event as OpenCodeEvent,
  Message as OpenCodeMessage,
  Part as OpenCodePart,
  PermissionRequest,
  PermissionRuleset,
  QuestionRequest,
  Session as OpenCodeSession,
  Todo as OpenCodeTodo,
  ToolPart,
} from "@opencode-ai/sdk/v2";
import {
  defaultInstanceIdForDriver,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2PlanStep,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderFailure,
  type OrchestrationV2ProviderRef,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItem,
  type PlanId,
  ProviderDriverKind,
  type ProviderInstanceId,
  type ProviderRequestKind,
  type ProviderSessionId,
  type RuntimeRequestId,
  type ThreadId,
} from "@t3tools/contracts";
import { OpenCodeSettings } from "../../settings.ts";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import type {
  OpenCodePermissionRequestKind,
} from "./permissions.ts";
import type {
  OpenCodeTurnTokenUsageAccumulator,
} from "./usage.ts";

export interface ActiveOpenCodeTurn {
  readonly usage: OpenCodeTurnTokenUsageAccumulator;
  readonly isRoot: boolean;
  readonly threadId: ThreadId;
  readonly runId: ProviderAdapter.ProviderAdapterV2TurnInput["runId"] | null;
  readonly rootNodeId: ProviderAdapter.ProviderAdapterV2TurnInput["rootNodeId"];
  readonly appThread: OrchestrationV2AppThread;
  readonly modelSelection: ModelSelection;
  readonly runtimePolicy: ProviderAdapter.ProviderAdapterV2RuntimePolicy;
  readonly providerTurnId: OrchestrationV2ProviderTurn["id"];
  readonly providerThreadId: OrchestrationV2ProviderTurn["providerThreadId"];
  readonly runOrdinal: number;
  readonly startedAt: DateTime.Utc;
  readonly itemOrdinals: Map<string, number>;
  readonly parts: Map<string, Exclude<OpenCodePart, ToolPart>>;
  readonly partIdsByMessage: Map<string, Set<string>>;
  readonly toolNamesByCallId: Map<string, string>;
  mcpServerNames?: ReadonlyArray<string>;
  readonly providerTurn: OrchestrationV2ProviderTurn;
  nextItemOrdinal: number;
  nativeUserMessageId: string | null;
  admissionMessageId: string | null;
  interrupted: boolean;
  finalized: boolean;
  planId: PlanId | null;
  admissionGeneration: number;
  admissionReconciliationGeneration: number | null;
  admissionPending: boolean;
  admissionAccepted: boolean;
  admissionMessageObserved: boolean;
  idleDuringAdmission: boolean;
  admissionSettled: Deferred.Deferred<void>;
  admissionAbortController: AbortController | null;
}

export interface OpenCodeSubagentContext {
  readonly nativeItemId: string;
  readonly nodeId: OrchestrationV2Subagent["id"];
  readonly parentState: OpenCodeThreadState;
  readonly parentTurn: ActiveOpenCodeTurn;
  readonly prompt: string;
  readonly title: string | null;
  readonly startedAt: DateTime.Utc;
  childSessionId: string | null;
  childThreadId: ThreadId | null;
  childProviderThreadId: OrchestrationV2ProviderThread["id"] | null;
  model: string | null;
  result: string | null;
}

export interface OpenCodeThreadState {
  readonly nativeSessionId: string;
  providerThread: OrchestrationV2ProviderThread;
  appThread: OrchestrationV2AppThread | null;
  activeTurn: ActiveOpenCodeTurn | null;
  readonly providerTurns: Map<string, OrchestrationV2ProviderTurn>;
  readonly runtimeRequests: Map<string, OrchestrationV2RuntimeRequest>;
  readonly messageRoles: Map<string, "user" | "assistant">;
  readonly userMessageIds: Array<string>;
  parentSubagent: OpenCodeSubagentContext | null;
  nextChildTurnOrdinal: number;
  nextAdmissionGeneration: number;
  permission: PermissionRuleset;
  /** Parent rules last written into this child's `permission`; empty for root sessions. */
  inheritedPermission: PermissionRuleset;
}

export interface OpenCodeRequestOwner {
  readonly state: OpenCodeThreadState;
  readonly turn: ActiveOpenCodeTurn;
  readonly subagent: OpenCodeSubagentContext | null;
}

export interface PendingOpenCodeRequest {
  readonly requestId: RuntimeRequestId;
  readonly nativeRequestId: string;
  readonly nativeSessionId: string;
  readonly turn: ActiveOpenCodeTurn;
  readonly state: OpenCodeThreadState;
  readonly nodeId: OrchestrationV2ExecutionNode["id"];
  readonly parentNodeId: OrchestrationV2ExecutionNode["id"];
  readonly turnItemId: OrchestrationV2TurnItem["id"];
  readonly requestKind: OpenCodePermissionRequestKind | "user_input";
  readonly createdAt: DateTime.Utc;
  readonly permission?: PermissionRequest;
  readonly question?: QuestionRequest;
}

export interface OpenCodeAdapterV2Options {
  readonly instanceId: ProviderInstanceId;
  readonly settings: OpenCodeSettings;
  readonly environment: NodeJS.ProcessEnv;
  readonly nativeEventLogger?: ProviderEventLoggers.EventNdjsonLogger;
}
