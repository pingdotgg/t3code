import {
  CommandId,
  type RunId,
  isProviderAvailable,
  MessageId,
  type ModelSelection,
  NodeId,
  ORCHESTRATOR_MCP_RUNNING_TASK_NEXT,
  TurnItemId,
  type OrchestrationV2Run,
  type OrchestrationV2Subagent,
  type OrchestrationV2ThreadProjection,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ThreadLaunchWorkspaceStrategy,
  type OrchestrationV2TurnItem,
  OrchestratorMcpFailure,
  type OrchestratorMcpCapabilitiesInput,
  type OrchestratorMcpCapabilitiesResult,
  type OrchestratorMcpModelOption,
  type OrchestratorMcpCreateThreadsInput,
  type OrchestratorMcpCreateThreadsResult,
  type OrchestratorMcpCreatedThread,
  type OrchestratorMcpDelegateTaskInput,
  type OrchestratorMcpDelegateTaskResult,
  type OrchestratorMcpDeleteScheduledTaskInput,
  type OrchestratorMcpRequestSecretInput,
  type OrchestratorMcpRequestSecretResult,
  type OrchestratorMcpDeleteScheduledTaskResult,
  type OrchestratorMcpListScheduledTasksResult,
  type OrchestratorMcpScheduledTask,
  type OrchestratorMcpScheduleTaskInput,
  type OrchestratorMcpScheduleTaskResult,
  type OrchestratorMcpTarget,
  type OrchestratorMcpTaskCancelInput,
  type OrchestratorMcpTaskCancelResult,
  type OrchestratorMcpUpdateScheduledTaskInput,
  type OrchestratorMcpListScheduledTasksInput,
  type ProjectId,
  type OrchestratorMcpThreadDetail,
  type OrchestratorMcpThreadPullRequest,
  type OrchestratorMcpThreadInterruptInput,
  type OrchestratorMcpThreadInterruptResult,
  type OrchestratorMcpThreadListInput,
  type OrchestratorMcpThreadListItem,
  type OrchestratorMcpThreadListResult,
  type OrchestratorMcpThreadReadInput,
  type OrchestratorMcpThreadReadResult,
  type OrchestratorMcpThreadRun,
  type OrchestratorMcpThreadSendInput,
  type OrchestratorMcpThreadSendResult,
  type OrchestratorMcpThreadTimelineItem,
  type OrchestratorMcpThreadWaitInput,
  type OrchestratorMcpThreadWaitResult,
  type ProviderInteractionMode,
  type ProviderOptionDescriptor,
  type ProviderOptionSelection,
  ProviderRequestKind,
  type RuntimeMode,
  type ScheduledTask,
  type ScheduledTaskUpsertInput,
  type ServerProvider,
  type ServerProviderModel,
  ThreadId,
  isOrchestrationV2WorkActive,
  resolveProjectProviderInstanceEnabled,
} from "@t3tools/contracts";
import { getProviderOptionCurrentValue } from "@t3tools/shared/model";
import { runRanAfter } from "@t3tools/shared/orchestrationV2ThreadError";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import {
  normalizeThreadPullRequestKey,
  visibleThreadPullRequests,
} from "../sourceControl/threadPullRequests.ts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import * as ProviderAdapterRegistry from "../orchestration-v2/ProviderAdapterRegistry.ts";
import {
  subagentResultForRun,
  delegatedTaskProgress,
} from "@t3tools/provider-core/server/subagentProjection";
import {
  DispatchModeLimit,
  type DispatchModeRefusal,
} from "../orchestration-v2/DispatchModeLimit.ts";
import type {
  ProjectionRecordField,
  ProjectionRecordFilter,
} from "../orchestration-v2/ProjectionStore.ts";
import { runOutcome } from "../orchestration-v2/RestartBackgroundNote.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ThreadLaunchService from "../orchestration-v2/ThreadLaunchService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import { isSnoozed } from "../orchestration-v2/ThreadSettlementService.ts";
import { userFacingDispatchErrorMessage } from "../orchestration-v2/UserFacingErrors.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as ServerSettings from "../serverSettings.ts";
import {
  clientModeCeiling,
  type McpInvocationScope,
  type McpThreadInvocationScope,
  requireThreadScope,
  threadLinkFor,
} from "./McpInvocationContext.ts";
import * as Metrics from "../observability/Metrics.ts";
import {
  interactionModeRank,
  resolveInteractionMode,
  resolveRuntimeMode,
  runtimeModeRank,
  taskPrompt,
} from "./delegatedTaskModes.ts";
import { isLiveCallerShell, threadNotFound } from "./threadAccess.ts";
import * as SecretRequests from "../secrets/SecretRequests.ts";
import * as PeerForwarding from "../peer/PeerForwarding.ts";
import * as RemoteDelegation from "../peer/RemoteDelegation.ts";

export * from "./mcpSupport0.ts";
export * from "./mcpSupport1.ts";

export class OrchestratorMcpService extends Context.Service<
  OrchestratorMcpService,
  OrchestratorMcpServiceShape
>()("t3/mcp/OrchestratorMcpService") {}


import type { OrchestratorMcpServiceShape } from "./mcpServiceShape.ts";
export type { OrchestratorMcpServiceShape };

export type SuccessOf<F> = F extends (...args: never[]) => import("effect/Effect").Effect<infer A, infer _E, infer _R> ? A : never;

import { DEFAULT_THREAD_ITEM_MAX_CHARS, DEFAULT_THREAD_LIST_LIMIT, DEFAULT_THREAD_READ_LIMIT, DEFAULT_THREAD_RUN_LIMIT, DEFAULT_WAIT_TIMEOUT_MS, MAX_WAIT_TIMEOUT_MS, SECRET_REQUEST_POLL_INTERVAL_MS, agentStopReason, capabilityModelOption, delegatedTaskRun, directAppOwnedChildTasks, directChildTaskIds, errorMessage, failure, isTerminalTaskStatus, isThreadManagementError, knownOptions, listCapabilityModels, listItemFromShell, providerConstraints, stableCommandId, stableMessageId, stableOperationMessageId, stablePart, stableThreadId, taskResultTransfer, threadManagementFailure, threadPullRequests, threadRun, threadSettlement, threadTitle } from "./mcpSupport0.ts";
import { pageIncludesTerminalTaskResult, threadDetail, timelineItem } from "./mcpSupport1.ts";
import { install0 } from "./mcpServicePart0.ts";
import { install1 } from "./mcpServicePart1.ts";

import { mcpApiPart0 } from "./mcpApiPart0.ts";
import { mcpApiPart1 } from "./mcpApiPart1.ts";
import { mcpApiPart2 } from "./mcpApiPart2.ts";

const make = Effect.gen(function* () {
  const d0 = yield* install0({  });
  const d1 = Object.assign(d0, yield* install1(d0));
  return OrchestratorMcpService.of({
    ...mcpApiPart0(d1), ...mcpApiPart1(d1), ...mcpApiPart2(d1),
  });
});

export const layer: Layer.Layer<
  OrchestratorMcpService,
  never,
  | SecureRandom.SecureRandom
  | ThreadManagementService.ThreadManagementService
  | ThreadLaunchService.ThreadLaunchService
  | GitVcsDriver.GitVcsDriver
  | ProviderRegistry.ProviderRegistry
  | ProviderAdapterRegistry.ProviderAdapterRegistryV2
  | ScheduledTaskService.ScheduledTaskService
  | ProjectService.ProjectService
  | SecretRequests.SecretRequests
  | ServerSettings.ServerSettingsService
  | RemoteDelegation.RemoteDelegation
> = Layer.effect(OrchestratorMcpService, make);



