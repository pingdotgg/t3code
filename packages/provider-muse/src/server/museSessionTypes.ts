import { MspError, type ProcessExit, type SendUserTurnOptions } from "@muse-code/sdk";
import {
  MUSE_DEFAULT_MODEL,
  ProviderDriverKind,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2ConversationMessage,
  type OrchestrationV2ExecutionNode,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderSession,
  type OrchestrationV2ProviderThread,
  type OrchestrationV2ProviderTurn,
  type OrchestrationV2RuntimeRequest,
  type OrchestrationV2Subagent,
  type OrchestrationV2TurnItemStatus,
  type NodeId,
  type OrchestrationV2TurnItem,
  type ProviderInstanceId,
  type PlanId,
  type OrchestrationV2PlanStep,
  type ProviderApprovalDecision,
  type RuntimeRequestId,
  type ServerProviderModel,
  type ThreadId,
} from "@t3tools/contracts";
import type { MuseSettings } from "../settings.ts";
import { AgentScope, type AgentScopeShape } from "@t3tools/shared/AgentScope";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import * as Cause from "effect/Cause";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";

import * as ProviderHost from "@t3tools/provider-core/server/ProviderHost";
import * as McpProviderSession from "@t3tools/provider-core/server/mcpSession";
import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { buildRuntimeInstructions } from "@t3tools/provider-core/server/runtimeInstructions";
import { museModelCapabilities, resolveMuseReasoningEffort } from "./modelCatalog.ts";
import {
  MuseApproval,
  MuseCompactResult,
  MuseContextUsage,
  MuseDelta,
  MuseItemEvent,
  MuseSessionResult,
  MuseSubscriptionUsage,
  MuseTokenUsageEvent,
  MuseTodoList,
  MuseTurnRetryScheduled,
  MuseTurnCompleted,
  MuseTurnStartResult,
  MuseUserInput,
  museApprovalChoices,
  museApprovalDecision,
  museApprovalOptions,
  type MuseItem,
} from "./protocol.ts";
import { isMuseUsageLimitFailure, museUsageLimitResetAt } from "./usageLimits.ts";
import {
  createMuseSdkHostEffect,
  museApprovalMode,
  museCanonicalPath,
  musePermissionProfile,
  museWorkspaceRoot,
  type createMuseSdkHost,
  type MuseSdkHost,
} from "./sdk.ts";
import type * as ProviderEventLoggers from "@t3tools/provider-core/server/ProviderEventLoggers";
import {
  providerMessageTextWithAttachmentPaths,
  isProviderNativeImageAttachment,
} from "@t3tools/provider-core/server/attachmentPrompt";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import {
  backgroundWorkNotification,
  type BackgroundWorkReport,
} from "@t3tools/provider-core/server/notification";
import type * as ProviderContinuationRequests from "@t3tools/provider-core/server/ProviderContinuationRequests";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import {
  makeSubagentChildThread,
  makeSubagentConversationArtifacts,
  subagentThreadTitle,
} from "@t3tools/provider-core/server/subagentProjection";
import { turnScopedSelectionTransition } from "@t3tools/provider-core/server/selectionTransition";
import { museItemStatus, museToolPresentation } from "./itemPresentation.ts";
import { MUSE_PROVIDER, MuseProviderCapabilitiesV2 } from "./museCapabilities.ts";
export interface ActiveTurn {
  readonly input: ProviderAdapter.ProviderAdapterV2TurnInput;
  providerTurn: OrchestrationV2ProviderTurn;
  readonly nativeId: string;
  readonly joined: Set<string>;
  readonly items: Map<string, MuseItem>;
  readonly ordinals: Map<string, number>;
  readonly started: Map<string, DateTime.Utc>;
  readonly dirty: Set<string>;
  readonly settledRequests: Set<string>;
  readonly done: Deferred.Deferred<void>;
  todoPlanId?: PlanId;
  nextOrdinal: number;
  flushScheduled: boolean;
  interruptRequested: boolean;
  compact: boolean;
}

export interface PendingRequest {
  readonly native:
    | { type: "approval"; value: MuseApproval }
    | { type: "question"; value: MuseUserInput };
  request: OrchestrationV2RuntimeRequest;
  node: OrchestrationV2ExecutionNode;
  item: OrchestrationV2TurnItem;
  response?: Pick<OrchestrationV2RuntimeRequest, "decision" | "answers">;
  shown: boolean;
}

// Muse 1.4.4 cannot read/subscribe to inline child sessions; retain prompt, root status, and result here.
export interface ChildContext {
  readonly childSessionId: string;
  readonly childThreadId: ThreadId;
  readonly appThread: OrchestrationV2AppThread;
  readonly rootNodeId: NodeId;
  readonly parentThreadId: ThreadId;
  status: OrchestrationV2TurnItemStatus;
  result?: string;
}

export type Inbox =
  | { type: "notification"; method: string; params: unknown; epoch: number }
  | { type: "failure"; cause: unknown; epoch: number }
  | { type: "flush"; turn: ActiveTurn };
