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
import * as Crypto from "effect/Crypto";
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

const DEFAULT_WAIT_TIMEOUT_MS = 10 * 60 * 1_000;
const MAX_WAIT_TIMEOUT_MS = 60 * 60 * 1_000;
const TASK_WAKE_EVENTS = [
  { thread: "parent", eventType: "subagent.updated" },
  { thread: "child", eventType: "run.updated" },
  { thread: "child", eventType: "subagent.updated" },
  { thread: "child", eventType: "provider-thread.updated" },
  { thread: "child", eventType: "runtime-request.updated" },
] as const;
const SECRET_REQUEST_POLL_INTERVAL_MS = 500;
const DEFAULT_THREAD_LIST_LIMIT = 50;
const DEFAULT_THREAD_READ_LIMIT = 50;
const DEFAULT_THREAD_RUN_LIMIT = 10;
const DEFAULT_THREAD_ITEM_MAX_CHARS = 20_000;

interface ResolvedTarget {
  readonly modelSelection: ModelSelection;
  readonly supportedRuntimeModes: ReadonlyArray<RuntimeMode> | undefined;
}

type TerminalTaskStatus = Extract<
  OrchestratorMcpDelegateTaskResult["status"],
  "completed" | "failed" | "cancelled" | "interrupted"
>;

export interface OrchestratorMcpServiceShape {
  readonly capabilities: (
    scope: McpInvocationScope,
    input?: OrchestratorMcpCapabilitiesInput,
  ) => Effect.Effect<OrchestratorMcpCapabilitiesResult, OrchestratorMcpFailure>;
  readonly delegateTask: (
    scope: McpInvocationScope,
    input: OrchestratorMcpDelegateTaskInput,
  ) => Effect.Effect<OrchestratorMcpDelegateTaskResult, OrchestratorMcpFailure>;
  readonly taskStatus: (
    scope: McpInvocationScope,
    taskId: NodeId,
  ) => Effect.Effect<OrchestratorMcpDelegateTaskResult, OrchestratorMcpFailure>;
  readonly cancelTask: (
    scope: McpInvocationScope,
    input: OrchestratorMcpTaskCancelInput,
  ) => Effect.Effect<OrchestratorMcpTaskCancelResult, OrchestratorMcpFailure>;
  readonly createThreads: (
    scope: McpInvocationScope,
    input: OrchestratorMcpCreateThreadsInput,
  ) => Effect.Effect<OrchestratorMcpCreateThreadsResult, OrchestratorMcpFailure>;
  readonly scheduleTask: (
    scope: McpInvocationScope,
    input: OrchestratorMcpScheduleTaskInput,
  ) => Effect.Effect<OrchestratorMcpScheduleTaskResult, OrchestratorMcpFailure>;
  readonly listScheduledTasks: (
    scope: McpInvocationScope,
    input: OrchestratorMcpListScheduledTasksInput,
  ) => Effect.Effect<OrchestratorMcpListScheduledTasksResult, OrchestratorMcpFailure>;
  readonly updateScheduledTask: (
    scope: McpInvocationScope,
    input: OrchestratorMcpUpdateScheduledTaskInput,
  ) => Effect.Effect<OrchestratorMcpScheduleTaskResult, OrchestratorMcpFailure>;
  readonly deleteScheduledTask: (
    scope: McpInvocationScope,
    input: OrchestratorMcpDeleteScheduledTaskInput,
  ) => Effect.Effect<OrchestratorMcpDeleteScheduledTaskResult, OrchestratorMcpFailure>;
  /** Only status reaches the agent, never this value. */
  readonly requestSecret: (
    scope: McpInvocationScope,
    input: OrchestratorMcpRequestSecretInput,
  ) => Effect.Effect<OrchestratorMcpRequestSecretResult, OrchestratorMcpFailure>;
  readonly listThreads: (
    scope: McpInvocationScope,
    input: OrchestratorMcpThreadListInput,
  ) => Effect.Effect<OrchestratorMcpThreadListResult, OrchestratorMcpFailure>;
  readonly readThread: (
    scope: McpInvocationScope,
    input: OrchestratorMcpThreadReadInput,
  ) => Effect.Effect<OrchestratorMcpThreadReadResult, OrchestratorMcpFailure>;
  readonly sendToThread: (
    scope: McpInvocationScope,
    input: OrchestratorMcpThreadSendInput,
  ) => Effect.Effect<OrchestratorMcpThreadSendResult, OrchestratorMcpFailure>;
  readonly waitForThread: (
    scope: McpInvocationScope,
    input: OrchestratorMcpThreadWaitInput,
  ) => Effect.Effect<OrchestratorMcpThreadWaitResult, OrchestratorMcpFailure>;
  readonly interruptThread: (
    scope: McpInvocationScope,
    input: OrchestratorMcpThreadInterruptInput,
  ) => Effect.Effect<OrchestratorMcpThreadInterruptResult, OrchestratorMcpFailure>;
}

export class OrchestratorMcpService extends Context.Service<
  OrchestratorMcpService,
  OrchestratorMcpServiceShape
>()("t3/mcp/OrchestratorMcpService") {}

const isThreadManagementError = Schema.is(ThreadManagementService.ThreadManagementError);

function failure(code: OrchestratorMcpFailure["code"], message: string): OrchestratorMcpFailure {
  return new OrchestratorMcpFailure({ code, message });
}

function threadManagementFailure(error: unknown): OrchestratorMcpFailure {
  if (!isThreadManagementError(error)) return failure("orchestration_error", errorMessage(error));
  switch (error._tag) {
    case "ThreadManagementThreadNotFoundError":
      return failure("thread_not_found", error.message);
    case "ThreadManagementRunNotFoundError":
      return failure("run_not_found", error.message);
    case "ThreadManagementThreadArchivedError":
    case "ThreadManagementNoSteerableRunError":
      return failure("thread_not_sendable", error.message);
    case "ThreadManagementThreadNotInterruptibleError":
      return failure("thread_not_interruptible", error.message);
    case "ThreadManagementProjectionLoadError":
    case "ThreadManagementProjectThreadsListError":
    case "ThreadManagementDurableRunProjectionError":
      return failure("orchestration_error", error.message);
    case "ThreadManagementProviderInstanceDisabledError":
      return failure("invalid_request", error.message);
  }
}

// Without a reason, a Stop reads as the user's (see RunExecutionService.USER_STOP_REASON).
function agentStopReason(reason: string | undefined): string {
  return reason === undefined ? "Stopped by an agent" : `Stopped by an agent: ${reason}`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function scheduledTaskWorkspaceStrategy(
  boundToThread: boolean,
): ScheduledTask["workspaceStrategy"] {
  return boundToThread
    ? { type: "root" }
    : { type: "worktree", baseRef: "main", startFromOrigin: true };
}

function scheduledTaskSummary(task: ScheduledTask, mayRun: boolean): OrchestratorMcpScheduledTask {
  return {
    scheduledTaskId: task.id,
    title: task.title,
    prompt: task.prompt,
    enabled: task.enabled,
    projectId: task.projectId,
    boundThreadId: task.threadId,
    schedule: task.schedule,
    nextRunAt: task.nextRunAt,
    lastRunStatus: task.lastRunStatus,
    ...(task.webhook?.url == null || !mayRun ? {} : { webhookUrl: task.webhook.url }),
    ...(task.webhook === undefined
      ? {}
      : { webhookSignature: task.webhook.hasSecret ? "set" : "none" }),
  };
}

/**
 * Large catalogs (OpenCode, Cursor, Pi) can list hundreds of models, so agents
 * get a short list by default and search for the rest. These providers have
 * small official catalogs, so all their current models are listed.
 */
const FULL_CATALOG_DRIVERS: ReadonlySet<string> = new Set(["codex", "claudeAgent", "muse", "grok"]);
const LISTED_MODEL_LIMIT = 8;

/**
 * Picks the models orchestrator_capabilities shows for one provider. Hidden models never
 * appear. Search words naming the provider are dropped; other words list matches. With no
 * words left, lists pinned models (custom, favorite, the caller's own) plus non-legacy
 * models, or only the first few in the user's model order for large catalogs.
 */
function listCapabilityModels(input: {
  readonly provider: ServerProvider;
  readonly preferences:
    | { readonly hiddenModels: ReadonlyArray<string>; readonly modelOrder: ReadonlyArray<string> }
    | undefined;
  readonly isPinned: (model: ServerProviderModel) => boolean;
  readonly searchTerms: ReadonlyArray<string>;
}) {
  const rank = new Map(input.preferences?.modelOrder.map((slug, index) => [slug, index]));
  const visible = input.provider.models
    .filter((model) => model.isCustom || !input.preferences?.hiddenModels.includes(model.slug))
    .toSorted((a, b) => (rank.get(a.slug) ?? rank.size) - (rank.get(b.slug) ?? rank.size));
  const { instanceId, driver, displayName } = input.provider;
  const providerText = `${instanceId} ${driver} ${displayName ?? ""}`.toLowerCase();
  const modelTerms = input.searchTerms.filter((term) => !providerText.includes(term));
  if (modelTerms.length > 0) {
    const matches = visible.filter((model) => {
      const text = `${model.slug} ${model.name} ${model.subProvider ?? ""}`.toLowerCase();
      return modelTerms.every((term) => text.includes(term));
    });
    const listed = matches.slice(0, LISTED_MODEL_LIMIT);
    return { listed, omitted: matches.length - listed.length };
  }
  const current = visible.filter((model) => !model.isLegacy);
  const shown = new Set(
    FULL_CATALOG_DRIVERS.has(input.provider.driver)
      ? current
      : current.slice(0, LISTED_MODEL_LIMIT),
  );
  const listed = visible.filter((model) => input.isPinned(model) || shown.has(model));
  return { listed, omitted: visible.length - listed.length };
}

/** Option ids and allowed values are all a delegating agent needs; labels are UI copy. */
function capabilityModelOption(descriptor: ProviderOptionDescriptor): OrchestratorMcpModelOption {
  const defaultValue = getProviderOptionCurrentValue(descriptor);
  return {
    id: descriptor.id,
    values:
      descriptor.type === "boolean" ? [false, true] : descriptor.options.map((choice) => choice.id),
    ...(defaultValue === undefined ? {} : { default: defaultValue }),
  };
}

function providerConstraints(
  provider: ServerProvider | undefined,
  supportsOrchestrationV2: boolean,
): ReadonlyArray<string> {
  const constraints: Array<string> = [];
  if (!supportsOrchestrationV2) {
    constraints.push("No V2 provider adapter is registered.");
  }
  if (provider === undefined) return constraints;
  if (!isProviderAvailable(provider)) {
    constraints.push(provider.unavailableReason ?? "Provider driver is unavailable.");
  }
  if (!provider.enabled) {
    constraints.push("Provider instance is disabled.");
    // Disabled snapshots contain placeholders for installation, health, and auth.
    return constraints;
  }
  if (!provider.installed) constraints.push("Provider executable is not installed.");
  if (provider.status === "error" || provider.status === "disabled") {
    constraints.push(provider.message ?? `Provider status is ${provider.status}.`);
  }
  if (provider.auth.status === "unauthenticated") {
    constraints.push("Provider is not authenticated.");
  }
  return constraints;
}

/** Skip checks without descriptors; reject duplicate IDs because consumers disagree on precedence. */
function invalidOptionSelections(
  selections: ReadonlyArray<ProviderOptionSelection>,
  descriptors: ReadonlyArray<ProviderOptionDescriptor> | undefined,
): ReadonlyArray<string> {
  const problems: Array<string> = [];
  const seen = new Set<string>();
  for (const selection of selections) {
    if (seen.has(selection.id)) {
      problems.push(`Option ${selection.id} was specified more than once.`);
      continue;
    }
    seen.add(selection.id);
    if (descriptors === undefined) continue;
    const descriptor = descriptors.find((candidate) => candidate.id === selection.id);
    if (descriptor === undefined) {
      const known = descriptors.map((candidate) => candidate.id).join(", ");
      problems.push(`Unknown option ${selection.id}; supported options: ${known || "none"}.`);
      continue;
    }
    if (descriptor.type === "boolean" && typeof selection.value !== "boolean") {
      problems.push(`Option ${selection.id} expects a boolean value.`);
      continue;
    }
    if (
      descriptor.type === "select" &&
      !descriptor.options.some((choice) => choice.id === selection.value)
    ) {
      const choices = descriptor.options.map((choice) => choice.id).join(", ");
      problems.push(`Option ${selection.id} must be one of: ${choices}.`);
    }
  }
  return problems;
}

function taskStatusForRun(
  run: Pick<OrchestrationV2Run, "status" | "restartCancelledBackgroundWork"> | undefined,
): OrchestratorMcpDelegateTaskResult["status"] {
  switch (run === undefined ? undefined : runOutcome(run)) {
    case "queued":
      return "queued";
    case "waiting":
      return "waiting";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
    case "rolled_back":
      return "cancelled";
    case "interrupted":
      return "interrupted";
    case "preparing":
    case "starting":
    case "running":
    case undefined:
      return "running";
  }
}

function delegatedTaskRun(
  childProjection: Pick<OrchestrationV2ThreadProjection, "runs" | "contextTransfers">,
  task: OrchestrationV2Subagent,
): OrchestrationV2Run | undefined {
  const taskRun = childProjection.runs.find((run) => run.delegatedTaskId === task.id);
  if (taskRun !== undefined) return taskRun;
  const spawnTransfer = childProjection.contextTransfers.find(
    (transfer) =>
      transfer.type === "subagent_spawn" &&
      transfer.sourceThreadId === task.threadId &&
      transfer.targetThreadId === task.childThreadId,
  );
  if (spawnTransfer === undefined) {
    return childProjection.runs[0];
  }
  return spawnTransfer.targetRunId === null
    ? undefined
    : childProjection.runs.find((run) => run.id === spawnTransfer.targetRunId);
}

function hasPendingChildRuns(
  childProjection: Pick<OrchestrationV2ThreadProjection, "runs">,
  delegatedRun: OrchestrationV2Run | undefined,
): boolean {
  return childProjection.runs.some(
    (run) =>
      !ThreadManagementService.isTerminalRunStatus(run.status) &&
      !(run.status === "queued" && run.queueHeld === true) &&
      (delegatedRun === undefined || run.ordinal > delegatedRun.ordinal),
  );
}

function isTerminalTaskStatus(
  status: OrchestratorMcpDelegateTaskResult["status"],
): status is TerminalTaskStatus {
  return (
    status === "completed" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "interrupted"
  );
}

function endsTaskWait(result: OrchestratorMcpDelegateTaskResult): boolean {
  return (
    result.hasPendingQuestion ||
    result.pendingApproval !== null ||
    isTerminalTaskStatus(result.status)
  );
}

const isApprovalRequestKind = Schema.is(ProviderRequestKind);

function activeTaskRunIds(
  child: Pick<OrchestrationV2ThreadProjection, "runs">,
  taskId: NodeId,
  originalRun: OrchestrationV2Run | undefined,
) {
  return new Set(
    child.runs
      .filter(
        (run) =>
          !ThreadManagementService.isTerminalRunStatus(run.status) &&
          (run.delegatedTaskId === taskId ||
            // Legacy tasks own only their original run, not later turns in the child thread.
            (run.delegatedTaskId === undefined && run.id === originalRun?.id)),
      )
      .map((run) => run.id),
  );
}

function pendingTaskApproval(
  child: Pick<OrchestrationV2ThreadProjection, "nodes" | "runtimeRequests">,
  taskRunIds: ReadonlySet<RunId>,
) {
  let approval: OrchestratorMcpDelegateTaskResult["pendingApproval"] = null;
  let oldestCreatedAt = Infinity;
  for (const request of child.runtimeRequests) {
    if (
      request.status !== "pending" ||
      request.responseCapability.type !== "live" ||
      !isApprovalRequestKind(request.kind)
    ) {
      continue;
    }
    const runId = child.nodes.find((node) => node.id === request.nodeId)?.runId;
    if (runId === undefined || runId === null || !taskRunIds.has(runId)) continue;
    const createdAt = DateTime.toEpochMillis(request.createdAt);
    if (createdAt < oldestCreatedAt) {
      oldestCreatedAt = createdAt;
      approval = { requestId: request.id, kind: request.kind, runId };
    }
  }
  return approval;
}

/** Every task `directAppOwnedChildTasks` can return, so callers load only those. */
function directChildTaskIds(
  target: Pick<OrchestrationV2ThreadProjection, "thread" | "runs">,
  returnedRunIds: ReadonlySet<RunId | null>,
): ReadonlyArray<NodeId> {
  const ids = new Set<NodeId>();
  if (target.thread.forkedFrom?.type === "node") ids.add(target.thread.forkedFrom.nodeId);
  for (const run of target.runs) {
    if (returnedRunIds.has(run.id) && run.delegatedTaskId !== undefined) {
      ids.add(run.delegatedTaskId);
    }
  }
  return [...ids];
}

function directAppOwnedChildTasks(
  parent: Pick<OrchestrationV2ThreadProjection, "thread" | "subagents">,
  target: Pick<OrchestrationV2ThreadProjection, "thread" | "runs">,
  returnedRunIds: ReadonlySet<RunId | null>,
): ReadonlyArray<OrchestrationV2Subagent> {
  if (
    target.thread.lineage.parentThreadId !== parent.thread.id ||
    target.thread.lineage.relationshipToParent !== "subagent"
  ) {
    return [];
  }
  const original = parent.subagents.find(
    (task) =>
      task.origin === "app_owned" &&
      task.threadId === parent.thread.id &&
      task.id ===
        (target.thread.forkedFrom?.type === "node" ? target.thread.forkedFrom.nodeId : undefined) &&
      task.childThreadId === target.thread.id,
  );
  const taskIds = new Set(
    target.runs
      .filter((run) => returnedRunIds.has(run.id))
      .map((run) => run.delegatedTaskId ?? original?.id),
  );
  return parent.subagents.filter(
    (task) =>
      taskIds.has(task.id) &&
      task.origin === "app_owned" &&
      task.childThreadId === target.thread.id,
  );
}

function taskResultTransfer(
  parent: Pick<OrchestrationV2ThreadProjection, "thread" | "contextTransfers">,
  child: Pick<OrchestrationV2ThreadProjection, "runs" | "contextTransfers">,
  task: OrchestrationV2Subagent,
) {
  const originalRun = delegatedTaskRun(child, task);
  const resultRunIds = new Set(
    child.runs
      .filter(
        (run) =>
          run.delegatedTaskId === task.id ||
          (originalRun?.delegatedTaskId === undefined && run.delegatedTaskId === undefined),
      )
      .map((run) => run.id),
  );
  if (originalRun !== undefined) resultRunIds.add(originalRun.id);
  return parent.contextTransfers.find(
    (transfer) =>
      transfer.type === "subagent_result" &&
      transfer.sourceThreadId === task.childThreadId &&
      transfer.targetThreadId === parent.thread.id &&
      ((transfer.sourcePoint.runId !== undefined && resultRunIds.has(transfer.sourcePoint.runId)) ||
        (transfer.sourcePoint.runId === undefined && originalRun?.delegatedTaskId === undefined)),
  );
}

function pageIncludesTerminalTaskResult(input: {
  readonly parent: Pick<OrchestrationV2ThreadProjection, "thread" | "contextTransfers">;
  readonly page: ReadonlyArray<OrchestrationV2ThreadProjection["visibleTurnItems"][number]>;
  readonly task: OrchestrationV2Subagent;
  readonly target: Pick<
    OrchestrationV2ThreadProjection,
    "thread" | "runs" | "contextTransfers" | "messages" | "turnItems"
  >;
  readonly maxChars: number;
}): boolean {
  const transfer = taskResultTransfer(input.parent, input.target, input.task);
  if (transfer === undefined) return false;
  const run =
    transfer.sourcePoint.runId === undefined
      ? delegatedTaskRun(input.target, input.task)
      : input.target.runs.find((run) => run.id === transfer.sourcePoint.runId);
  if (run === undefined || !isTerminalTaskStatus(taskStatusForRun(run))) return false;

  const result = subagentResultForRun(input.target, run);
  if (result.messageId === null && result.turnItemId === null) return false;

  return input.page.some((row) => {
    if (row.sourceThreadId !== input.target.thread.id) return false;
    const matchesResult =
      (result.turnItemId !== null && row.sourceItemId === result.turnItemId) ||
      (result.messageId !== null &&
        row.item.type === "assistant_message" &&
        row.item.messageId === result.messageId);
    if (!matchesResult) return false;

    const text = turnItemText(row.item);
    return text !== null && text.length <= input.maxChars;
  });
}

function latestTerminalResultRun(
  projection: Pick<OrchestrationV2ThreadProjection, "messages" | "runs">,
  delegatedRun: OrchestrationV2Run | undefined,
): OrchestrationV2Run | undefined {
  const monitorRunIds = new Set(
    projection.messages
      .filter((message) => message.notification?.source.kind === "monitor")
      .map((message) => message.runId),
  );
  return projection.runs
    .filter(
      (run) =>
        ThreadManagementService.isTerminalRunStatus(run.status) &&
        !monitorRunIds.has(run.id) &&
        run.status !== "rolled_back" &&
        (run.id === delegatedRun?.id || run.startedAt !== null),
    )
    .reduce<OrchestrationV2Run | undefined>(
      (latest, run) => (latest === undefined || runRanAfter(run, latest) ? run : latest),
      undefined,
    );
}

function canExposeTaskRunResult(run: OrchestrationV2Run | undefined): run is OrchestrationV2Run {
  return (
    run !== undefined && run.status !== "rolled_back" && isTerminalTaskStatus(taskStatusForRun(run))
  );
}

function stablePart(value: string): string {
  return encodeURIComponent(value);
}

function stableCommandId(input: {
  readonly scope: McpInvocationScope;
  readonly requestKey: string;
  readonly operation: string;
  readonly index?: number;
}): CommandId {
  return CommandId.make(
    [
      "command",
      "mcp",
      stablePart(input.scope.requestNamespace),
      stablePart(input.operation),
      stablePart(input.requestKey),
      ...(input.index === undefined ? [] : [String(input.index)]),
    ].join(":"),
  );
}

function stableThreadId(input: {
  readonly scope: McpInvocationScope;
  readonly requestKey: string;
  readonly index: number;
}): ThreadId {
  return ThreadId.make(
    [
      "thread",
      "mcp",
      stablePart(input.scope.requestNamespace),
      stablePart(input.requestKey),
      String(input.index),
    ].join(":"),
  );
}

function stableMessageId(input: {
  readonly scope: McpInvocationScope;
  readonly requestKey: string;
  readonly index: number;
}): MessageId {
  return MessageId.make(
    [
      "message",
      "mcp",
      stablePart(input.scope.requestNamespace),
      stablePart(input.requestKey),
      String(input.index),
    ].join(":"),
  );
}

function stableOperationMessageId(input: {
  readonly scope: McpInvocationScope;
  readonly requestKey: string;
  readonly operation: string;
}): MessageId {
  return MessageId.make(
    [
      "message",
      "mcp",
      stablePart(input.scope.requestNamespace),
      stablePart(input.operation),
      stablePart(input.requestKey),
    ].join(":"),
  );
}

function threadTitle(input: {
  readonly parentTitle: string;
  readonly prompt: string | undefined;
  readonly title: string | undefined;
  readonly index: number;
}): string {
  const detail = input.title?.trim() || input.prompt?.trim();
  if (!detail) return `${input.parentTitle} thread ${input.index + 1}`;
  return detail.length > 80 ? `${detail.slice(0, 77)}...` : detail;
}

function threadSettlement(
  thread: Pick<OrchestrationV2ThreadShell, "settledOverride" | "settledAt">,
): Pick<OrchestratorMcpThreadListItem, "settled" | "settledAt"> {
  const settled = thread.settledOverride === "settled";
  return {
    settled,
    settledAt: settled && thread.settledAt !== null ? DateTime.formatIso(thread.settledAt) : null,
  };
}

function threadSnooze(
  thread: Parameters<typeof isSnoozed>[0],
  nowMs: number,
): Pick<OrchestratorMcpThreadListItem, "snoozed" | "snoozedUntil"> {
  const snoozed = isSnoozed(thread, nowMs);
  return {
    snoozed,
    snoozedUntil:
      snoozed && thread.snoozedUntil != null ? DateTime.formatIso(thread.snoozedUntil) : null,
  };
}

function threadPullRequests(
  links: OrchestrationV2ThreadShell["pullRequests"],
): OrchestratorMcpThreadPullRequest[] {
  return visibleThreadPullRequests(links ?? []).map((link) => ({
    host: normalizeThreadPullRequestKey(link).host,
    repository: link.repository,
    number: link.number,
    url: link.url,
    source: link.source,
    state: link.snapshot?.state ?? null,
  }));
}

function listItemFromShell(
  scope: McpInvocationScope,
  shell: OrchestrationV2ThreadShell,
  nowMs: number,
): OrchestratorMcpThreadListItem {
  return {
    threadId: shell.id,
    projectId: shell.projectId,
    title: shell.title,
    link: threadLinkFor(scope, shell.id),
    createdBy: shell.createdBy,
    creationSource: shell.creationSource,
    status: shell.activityRunStatus ?? shell.status,
    latestRunId: shell.latestRunId,
    providerInstanceId: shell.modelSelection.instanceId,
    model: shell.modelSelection.model,
    runtimeMode: shell.runtimeMode,
    interactionMode: shell.interactionMode,
    linkedPullRequest: shell.linkedPullRequest ?? null,
    pullRequests: threadPullRequests(shell.pullRequests),
    ...threadSettlement(shell),
    ...threadSnooze(shell, nowMs),
    parentThreadId: shell.lineage.parentThreadId,
    relationshipToParent: shell.lineage.relationshipToParent,
    itemCount: shell.visibleItemCount,
    createdAt: DateTime.formatIso(shell.createdAt),
    updatedAt: DateTime.formatIso(shell.updatedAt),
  };
}

function threadDetail(
  scope: McpInvocationScope,
  projection: Pick<OrchestrationV2ThreadProjection, "thread" | "runs" | "runtimeRequests">,
  itemCount: number,
  shell: OrchestrationV2ThreadShell,
  nowMs: number,
): OrchestratorMcpThreadDetail {
  const latest = ThreadManagementService.latestRun(projection);
  const active = ThreadManagementService.latestActiveRun(projection);
  return {
    threadId: projection.thread.id,
    projectId: projection.thread.projectId,
    title: projection.thread.title,
    link: threadLinkFor(scope, projection.thread.id),
    createdBy: projection.thread.createdBy,
    creationSource: projection.thread.creationSource,
    status: active?.status ?? latest?.status ?? "idle",
    latestRunId: latest?.id ?? null,
    activeRunId: active?.id ?? null,
    providerInstanceId: projection.thread.modelSelection.instanceId,
    model: projection.thread.modelSelection.model,
    runtimeMode: projection.thread.runtimeMode,
    interactionMode: projection.thread.interactionMode,
    linkedPullRequest: projection.thread.linkedPullRequest ?? null,
    pullRequests: threadPullRequests(projection.thread.pullRequests),
    titleRegeneration:
      projection.thread.titleRegeneration === undefined ||
      projection.thread.titleRegeneration === null
        ? null
        : {
            requestId: projection.thread.titleRegeneration.requestId,
            startedAt: DateTime.formatIso(projection.thread.titleRegeneration.startedAt),
          },
    branch: projection.thread.branch,
    worktreePath: projection.thread.worktreePath,
    parentThreadId: projection.thread.lineage.parentThreadId,
    relationshipToParent: projection.thread.lineage.relationshipToParent,
    runCount: projection.runs.length,
    itemCount,
    pendingRequestCount: projection.runtimeRequests.filter(
      (request) => request.status === "pending",
    ).length,
    archived: projection.thread.archivedAt !== null,
    ...threadSettlement(projection.thread),
    ...threadSnooze(shell, nowMs),
    createdAt: DateTime.formatIso(projection.thread.createdAt),
    updatedAt: DateTime.formatIso(projection.thread.updatedAt),
  };
}

function threadRun(run: OrchestrationV2Run): OrchestratorMcpThreadRun {
  return {
    runId: run.id,
    ordinal: run.ordinal,
    status: run.status,
    providerInstanceId: run.modelSelection.instanceId,
    model: run.modelSelection.model,
    requestedAt: DateTime.formatIso(run.requestedAt),
    startedAt: run.startedAt === null ? null : DateTime.formatIso(run.startedAt),
    completedAt: run.completedAt === null ? null : DateTime.formatIso(run.completedAt),
  };
}

function jsonText(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function turnItemText(item: OrchestrationV2TurnItem): string | null {
  switch (item.type) {
    case "notification":
      return [item.summary, item.detail].filter((part) => part !== undefined).join("\n");
    case "user_message":
    case "assistant_message":
    case "reasoning":
      return item.text;
    case "proposed_plan":
      return item.markdown;
    case "todo_list":
      return [item.explanation, ...item.steps.map((step) => `[${step.status}] ${step.text}`)]
        .filter((line): line is string => line !== undefined)
        .join("\n");
    case "user_input_request":
      return jsonText(item.questions);
    case "file_change":
      return [
        item.fileName,
        item.additions === undefined && item.deletions === undefined
          ? undefined
          : `+${item.additions ?? 0} -${item.deletions ?? 0}`,
        item.diffStr ?? item.newStr,
      ]
        .filter((line): line is string => line !== undefined)
        .join("\n");
    case "command_execution":
      return [`$ ${item.input}`, item.output]
        .filter((line): line is string => line !== undefined)
        .join("\n");
    case "file_search":
      return jsonText({ pattern: item.pattern, results: item.results });
    case "web_search":
      return jsonText({ patterns: item.patterns, results: item.results });
    case "approval_request":
      return [item.prompt ?? item.requestKind, item.reason]
        .filter((line): line is string => line !== undefined)
        .join("\n");
    case "checkpoint":
      return jsonText(item.files);
    case "run_interrupt_request":
    case "run_interrupt_result":
    case "system_notice":
      return item.message;
    case "error":
      return item.failure.message;
    case "compaction":
      return item.summary ?? null;
    case "handoff":
      return item.summary ?? `${item.strategy} handoff to ${item.toProviderInstanceId}`;
    case "fork":
      return `Forked to thread ${item.targetThreadId}.`;
    case "thread_created":
      return `Created thread ${item.targetThreadId} with ${item.targetProviderInstanceId} (${item.targetModel}).`;
    case "secret_request":
      return `Asked the user for ${item.label}: ${item.secretStatus}.`;
    case "link_request":
      return item.linkStatus === "linked"
        ? `Linked ${item.linkedLabel ?? item.label ?? item.url ?? "an environment"} (${item.linkedAccess}).`
        : `Asked the user to link ${item.label ?? item.url ?? "an environment"}: ${item.linkStatus}.`;
    case "subagent":
      return item.result ?? item.progress ?? item.prompt;
    case "dynamic_tool":
      return jsonText({ toolName: item.toolName, input: item.input, output: item.output });
  }
}

function timelineItem(input: {
  readonly row: OrchestrationV2ThreadProjection["visibleTurnItems"][number];
  readonly maxChars: number;
  readonly textOffset?: number;
  readonly messagesByThreadId: ReadonlyMap<ThreadId, OrchestrationV2ThreadProjection["messages"]>;
}): OrchestratorMcpThreadTimelineItem {
  const text = turnItemText(input.row.item);
  const offset = input.textOffset ?? 0;
  const end = offset + input.maxChars;
  const textTruncated = text !== null && text.length > end;
  const messageId =
    input.row.item.type === "user_message" || input.row.item.type === "assistant_message"
      ? input.row.item.messageId
      : null;
  const message =
    messageId === null
      ? undefined
      : input.messagesByThreadId
          .get(input.row.sourceThreadId)
          ?.find((candidate) => candidate.id === messageId);
  return {
    position: input.row.position,
    visibility: input.row.visibility,
    sourceThreadId: input.row.sourceThreadId,
    itemId: input.row.sourceItemId,
    ...(input.row.item.type === "subagent" ? { subagentId: input.row.item.subagentId } : {}),
    runId: input.row.item.runId,
    messageId,
    createdBy: message?.createdBy ?? null,
    creationSource: message?.creationSource ?? null,
    ...(message?.senderThreadId === undefined ? {} : { senderThreadId: message.senderThreadId }),
    type: input.row.item.type,
    status: input.row.item.status,
    title: input.row.item.title,
    text: text === null ? null : text.slice(offset, end),
    textTruncated,
    nextTextOffset: textTruncated ? end : null,
    updatedAt: DateTime.formatIso(input.row.item.updatedAt),
  };
}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const providerRegistry = yield* ProviderRegistry.ProviderRegistry;
  const providerAdapters = yield* ProviderAdapterRegistry.ProviderAdapterRegistryV2;
  const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
  const projects = yield* ProjectService.ProjectService;
  const threadLaunch = yield* ThreadLaunchService.ThreadLaunchService;
  const gitDriver = yield* GitVcsDriver.GitVcsDriver;
  const serverSettings = yield* ServerSettings.ServerSettingsService;
  const remoteDelegation = yield* RemoteDelegation.RemoteDelegation;

  const requireProject = (projectId: ProjectId) =>
    projects.getById(projectId).pipe(
      Effect.mapError((error) =>
        failure("orchestration_error", `Unable to read project ${projectId}: ${error.message}`),
      ),
      Effect.flatMap(
        Option.match({
          onNone: () =>
            Effect.fail(failure("invalid_request", `Project ${projectId} was not found.`)),
          onSome: Effect.succeed,
        }),
      ),
    );

  const projectDefaultModelSelection = (
    project: Effect.Success<ReturnType<typeof requireProject>>,
  ) =>
    project.defaultModelSelection === null
      ? Effect.fail(
          failure(
            "invalid_request",
            `Project ${project.id} has no default model, so this caller cannot pick one for it.`,
          ),
        )
      : Effect.succeed(project.defaultModelSelection);
  const secretRequests = yield* SecretRequests.SecretRequests;

  const requireCapability = (scope: McpInvocationScope) =>
    scope.capabilities.has("orchestration")
      ? Effect.void
      : Effect.fail(
          failure(
            "capability_denied",
            "This MCP credential does not grant orchestration capabilities.",
          ),
        );

  const loadProjection = (threadId: ThreadId) =>
    threadManagement
      .getThreadRecords(
        threadId,
        [
          "runs",
          "messages",
          "providerThreads",
          "providerTurns",
          "runtimeRequests",
          "contextTransfers",
          "turnItems",
        ],
        { turnItemTypes: [], messageRoles: ["user"] },
      )
      .pipe(
        Effect.mapError((error) =>
          failure(
            "orchestration_error",
            `Unable to read thread ${threadId}: ${errorMessage(error)}`,
          ),
        ),
      );

  // A dispatcher thread holds thousands of tasks, each with its full prompt; read only the ones named.
  const loadTasks = (threadId: ThreadId, taskIds: ReadonlyArray<NodeId>) =>
    threadManagement.getThreadRecords(threadId, ["subagents"], { subagentIds: taskIds }).pipe(
      Effect.map(({ subagents }) => subagents),
      Effect.mapError((error) =>
        failure("orchestration_error", `Unable to read thread ${threadId}: ${errorMessage(error)}`),
      ),
    );

  // Task waits read on every wake of a parent that may hold thousands of
  // tasks, so they read only the task they watch and what its status needs.
  const loadTaskParent = (threadId: ThreadId, taskId: NodeId) =>
    threadManagement
      .getThreadRecords(threadId, ["runs", "subagents", "contextTransfers"], {
        subagentIds: [taskId],
      })
      .pipe(
        Effect.mapError((error) =>
          failure(
            "orchestration_error",
            `Unable to read thread ${threadId}: ${errorMessage(error)}`,
          ),
        ),
      );

  const loadProjectThread = (
    projectId: OrchestrationV2ThreadProjection["thread"]["projectId"],
    threadId: ThreadId,
  ) =>
    threadManagement
      .getProjectThreadRecords(
        { projectId, threadId },
        [
          "runs",
          "messages",
          "subagents",
          "providerThreads",
          "providerTurns",
          "runtimeRequests",
          "contextTransfers",
          "turnItems",
        ],
        { turnItemTypes: [], messageRoles: ["user"] },
      )
      .pipe(Effect.mapError(threadManagementFailure));

  const loadCaller = Effect.fn("OrchestratorMcpService.loadCaller")(function* (
    scope: McpInvocationScope,
  ) {
    yield* requireCapability(scope);
    if (scope.thread === undefined) {
      return {
        parent: undefined,
        limits: clientModeCeiling(scope.client),
      } as const;
    }
    const parent = yield* loadProjection(scope.thread.threadId);
    return {
      parent,
      limits: {
        runtimeMode: parent.thread.runtimeMode,
        interactionMode: parent.thread.interactionMode,
      },
    } as const;
  });

  const loadThreadCaller = Effect.fn("OrchestratorMcpService.loadThreadCaller")(function* (
    scope: McpInvocationScope,
    operation: string,
  ) {
    yield* requireCapability(scope);
    const threadScope = yield* requireThreadScope(scope, operation);
    const parent = yield* loadProjection(threadScope.thread.threadId);
    return { scope: threadScope, parent } as const;
  });

  const resolveProjectTarget = (
    parent: Pick<OrchestrationV2ThreadProjection, "thread"> | undefined,
    projectId: ProjectId | undefined,
  ) =>
    projectId !== undefined
      ? Effect.succeed(projectId)
      : parent !== undefined
        ? Effect.succeed(parent.thread.projectId)
        : Effect.fail(
            failure(
              "target_required",
              "Pass projectId: this MCP client is not running inside a T3 thread.",
            ),
          );

  const loadTargetThread = Effect.fn("OrchestratorMcpService.loadTargetThread")(function* (
    threadId: ThreadId,
  ) {
    const shell = yield* threadManagement
      .getThreadShell(threadId)
      .pipe(Effect.mapError(threadManagementFailure));
    if (shell === null || shell.deletedAt !== null) {
      return yield* threadNotFound(threadManagement, threadId, `Thread ${threadId} was not found.`);
    }
    return yield* loadProjectThread(shell.projectId, threadId);
  });

  const loadScopedThread = Effect.fn("OrchestratorMcpService.loadScopedThread")(function* (
    scope: McpInvocationScope,
    threadId: ThreadId,
  ) {
    const caller = yield* loadCaller(scope);
    const target =
      caller.parent !== undefined && threadId === caller.parent.thread.id
        ? caller.parent
        : yield* loadTargetThread(threadId);
    return { ...caller, target } as const;
  });

  /** Cross-thread writes require a live caller run; stale session credentials cannot authorize them. */
  const assertLiveCallerForOtherThread = (
    scope: McpInvocationScope,
    parent: Pick<OrchestrationV2ThreadProjection, "thread" | "runs"> | undefined,
    target: Pick<OrchestrationV2ThreadProjection, "thread">,
  ) =>
    parent === undefined || target.thread.id === parent.thread.id
      ? Effect.void
      : assertLiveCaller(scope, parent);

  const assertLiveCallerForOtherProject = (
    scope: McpInvocationScope,
    parent: Pick<OrchestrationV2ThreadProjection, "thread" | "runs"> | undefined,
    projectId: ProjectId,
  ) =>
    parent === undefined || projectId === parent.thread.projectId
      ? Effect.void
      : assertLiveCaller(scope, parent);

  const assertLiveCaller = (
    scope: McpInvocationScope,
    parent: Pick<OrchestrationV2ThreadProjection, "thread" | "runs">,
  ) => {
    const notActive = failure(
      "parent_not_active",
      "The calling provider no longer owns an active thread run.",
    );
    const activeRun = ThreadManagementService.latestActiveRun(parent);
    if (parent.thread.archivedAt === null && activeRun === undefined) {
      // Decide from this one fresh snapshot: a run may have started since `parent` was read.
      return threadManagement.getThreadShell(parent.thread.id).pipe(
        Effect.mapError(threadManagementFailure),
        Effect.flatMap((shell) =>
          isLiveCallerShell(shell, scope.thread?.providerInstanceId)
            ? Effect.void
            : Effect.fail(notActive),
        ),
      );
    }
    return parent.thread.archivedAt !== null ||
      activeRun === undefined ||
      activeRun.providerInstanceId !== scope.thread?.providerInstanceId
      ? Effect.fail(notActive)
      : Effect.void;
  };

  const loadReadableThread = Effect.fn("OrchestratorMcpService.loadReadableThread")(function* (
    scope: McpInvocationScope,
    threadId: ThreadId,
  ) {
    const { parent } = yield* loadCaller(scope);
    const shell = yield* threadManagement
      .getThreadShell(threadId)
      .pipe(Effect.mapError(threadManagementFailure));
    if (shell === null || shell.deletedAt !== null) {
      return yield* threadNotFound(
        threadManagement,
        threadId,
        `Thread ${threadId} is no longer available.`,
      );
    }
    const target = yield* threadManagement
      .getProjectThreadRecords({ projectId: shell.projectId, threadId }, [
        "runs",
        "runtimeRequests",
        "contextTransfers",
      ])
      .pipe(Effect.mapError(threadManagementFailure));
    return { parent, target, shell } as const;
  });

  const loadProviders = providerRegistry.getProviders;

  const loadOrchestrationCapableInstanceIds = () =>
    providerAdapters.list().pipe(Effect.map((instanceIds) => new Set(instanceIds)));

  /** Background agents miss foreground-only health probes; re-probe once before refusing. */
  const assertTargetEnabledForProject = (
    parent: Pick<OrchestrationV2ThreadProjection, "thread">,
    commandId: CommandId,
    target: ResolvedTarget,
  ) =>
    threadManagement
      .assertProviderInstanceEnabled({
        projectId: parent.thread.projectId,
        commandId,
        instanceId: target.modelSelection.instanceId,
      })
      .pipe(Effect.mapError(threadManagementFailure));

  const resolveTargetRechecking = (input: Parameters<typeof resolveTarget>[0]) => {
    const instanceId =
      input.target?.providerInstanceId ??
      (input.target?.driverKind === undefined
        ? input.parent.thread.modelSelection.instanceId
        : undefined);
    const resolved = resolveTarget(input);
    if (instanceId === undefined) return resolved;
    return resolved.pipe(
      Effect.catchIf(
        (error) => error.code === "provider_unavailable",
        () =>
          providerRegistry
            .refreshInstance(instanceId)
            .pipe(Effect.flatMap((providers) => resolveTarget({ ...input, providers }))),
      ),
    );
  };

  const resolveTarget = Effect.fn("OrchestratorMcpService.resolveTarget")(function* (input: {
    readonly parent: Pick<OrchestrationV2ThreadProjection, "thread">;
    readonly target: OrchestratorMcpTarget | undefined;
    readonly providers: ReadonlyArray<ServerProvider>;
    /** Receipt replays bypass current settings because they start no work. Dispatch must reuse the checked command ID. */
    readonly skipProjectEnablementFilter?: boolean;
  }): Effect.fn.Return<ResolvedTarget, OrchestratorMcpFailure> {
    const requestedInstanceId = input.target?.providerInstanceId;
    const requestedDriver = input.target?.driverKind;
    const orchestrationCapableInstanceIds = yield* loadOrchestrationCapableInstanceIds();
    let instanceId = requestedInstanceId;

    if (instanceId === undefined && requestedDriver !== undefined) {
      const candidates = input.providers.filter(
        (provider) =>
          provider.driver === requestedDriver &&
          orchestrationCapableInstanceIds.has(provider.instanceId),
      );
      if (candidates.length === 0) {
        return yield* failure(
          "provider_unavailable",
          `No V2 provider adapter is registered for driver ${requestedDriver}.`,
        );
      }
      const healthyCandidates = candidates.filter(
        (candidate) => providerConstraints(candidate, true).length === 0,
      );
      const inheritedCandidate = healthyCandidates.find(
        (candidate) => candidate.instanceId === input.parent.thread.modelSelection.instanceId,
      );
      const orderedCandidates = [
        ...(inheritedCandidate === undefined ? [] : [inheritedCandidate]),
        ...healthyCandidates.filter((candidate) => candidate !== inheritedCandidate),
      ];
      for (const candidate of orderedCandidates) {
        const enabledForProject =
          input.skipProjectEnablementFilter === true ||
          (yield* threadManagement.isProviderInstanceEnabledForProject({
            projectId: input.parent.thread.projectId,
            instanceId: candidate.instanceId,
          }));
        if (enabledForProject) {
          instanceId = candidate.instanceId;
          break;
        }
      }
      if (instanceId === undefined) {
        return yield* failure(
          "provider_unavailable",
          healthyCandidates.length === 0
            ? `No available V2 provider instance for driver ${requestedDriver}.`
            : `No instance of driver ${requestedDriver} is enabled for this project.`,
        );
      }
    }
    instanceId ??= input.parent.thread.modelSelection.instanceId;

    const provider = input.providers.find((candidate) => candidate.instanceId === instanceId);
    if (provider === undefined) {
      return yield* failure(
        "provider_unavailable",
        `Provider instance ${instanceId} is not registered.`,
      );
    }
    if (requestedDriver !== undefined && provider.driver !== requestedDriver) {
      return yield* failure(
        "invalid_request",
        `Provider instance ${instanceId} uses driver ${provider.driver}, not ${requestedDriver}.`,
      );
    }
    const constraints = providerConstraints(
      provider,
      orchestrationCapableInstanceIds.has(provider.instanceId),
    );
    if (constraints.length > 0) {
      return yield* failure(
        "provider_unavailable",
        `Provider ${instanceId} cannot run a child task: ${constraints.join(" ")}`,
      );
    }

    const inheritedSelection = input.parent.thread.modelSelection;
    const requestedModel = input.target?.model;
    const model =
      requestedModel ??
      (instanceId === inheritedSelection.instanceId
        ? inheritedSelection.model
        : provider.models[0]?.slug);
    if (model === undefined) {
      return yield* failure(
        "model_unavailable",
        `Provider ${instanceId} has no model available for inheritance.`,
      );
    }
    if (
      requestedModel !== undefined &&
      provider.models.length > 0 &&
      !provider.models.some((candidate) => candidate.slug === requestedModel)
    ) {
      return yield* failure(
        "model_unavailable",
        `Model ${requestedModel} is not advertised by provider ${instanceId}.`,
      );
    }

    const requestedOptions = input.target?.options;
    if (requestedOptions !== undefined) {
      const descriptors = provider.models.find((candidate) => candidate.slug === model)
        ?.capabilities?.optionDescriptors;
      const invalid = invalidOptionSelections(requestedOptions, descriptors);
      if (invalid.length > 0) {
        return yield* failure(
          "invalid_request",
          `Model ${model} on provider ${instanceId} rejected options: ${invalid.join(" ")}`,
        );
      }
    }

    const inheritsOptions =
      instanceId === inheritedSelection.instanceId && model === inheritedSelection.model;
    let options = inheritsOptions ? inheritedSelection.options : undefined;
    if (requestedOptions !== undefined) {
      const selections = new Map(
        (requestedOptions.length === 0 ? [] : (options ?? [])).map((selection) => [
          selection.id,
          selection,
        ]),
      );
      for (const selection of requestedOptions) {
        selections.set(selection.id, selection);
      }
      options = [...selections.values()];
    }
    return {
      modelSelection: { instanceId, model, ...(options === undefined ? {} : { options }) },
      supportedRuntimeModes: provider.supportedRuntimeModes,
    };
  });

  const requestKey = (clientRequestId: string | undefined): Effect.Effect<string> =>
    clientRequestId === undefined
      ? crypto.randomUUIDv4().pipe(Effect.orDie)
      : Effect.succeed(clientRequestId);

  const readTask = Effect.fn("OrchestratorMcpService.readTask")(function* (
    scope: McpThreadInvocationScope,
    taskId: NodeId,
    waitTimedOut = false,
    acknowledgeTerminal = false,
    acknowledgementOperation = "task-status-acknowledge",
  ): Effect.fn.Return<OrchestratorMcpDelegateTaskResult, OrchestratorMcpFailure> {
    yield* requireCapability(scope);
    const parentProjection = yield* loadTaskParent(scope.thread.threadId, taskId);
    const task = parentProjection.subagents.find(
      (candidate) =>
        candidate.id === taskId &&
        candidate.origin === "app_owned" &&
        candidate.threadId === scope.thread.threadId,
    );
    if (task === undefined || (task.childThreadId === null && task.remoteChild === undefined)) {
      return yield* failure(
        "task_not_found",
        `Delegated task ${taskId} does not belong to thread ${scope.thread.threadId}.`,
      );
    }
    if (task.childThreadId === null) {
      return yield* readRemoteTask(scope, task, waitTimedOut, acknowledgeTerminal);
    }
    const childControls = yield* threadManagement
      .getThreadRecords(
        task.childThreadId,
        [
          "runs",
          "messages",
          "contextTransfers",
          "subagents",
          "providerThreads",
          "runtimeRequests",
          "nodes",
          "turnItems",
        ],
        {
          messageRoles: ["user"],
          omitSettledLeafNodes: true,
          turnItemTypes: ["secret_request"],
        },
      )
      .pipe(Effect.mapError(threadManagementFailure));
    const childRun = delegatedTaskRun(childControls, task);
    const terminalRun = latestTerminalResultRun(childControls, childRun);
    const progress = delegatedTaskProgress(childControls);
    const taskResultRun =
      childRun?.delegatedTaskId === task.id
        ? childControls.runs
            .filter((run) => run.delegatedTaskId === task.id)
            .toSorted((a, b) => b.ordinal - a.ordinal)[0]
        : progress.resultRun;
    const taskWorkState =
      childRun?.delegatedTaskId === task.id
        ? isTerminalTaskStatus(taskStatusForRun(taskResultRun))
          ? "result_available"
          : "working"
        : progress.state;
    const resultRunIds = [
      ...new Set(
        [taskResultRun?.id, terminalRun?.id].filter((id): id is RunId => id !== undefined),
      ),
    ];
    const resultRecords = yield* threadManagement
      .getThreadRecords(task.childThreadId, ["messages", "turnItems"], {
        messageRoles: ["assistant"],
        messageRunIds: resultRunIds,
        turnItemRunIds: resultRunIds,
        turnItemTypes: ["assistant_message", "error"],
      })
      .pipe(Effect.mapError(threadManagementFailure));
    const childProjection = {
      ...childControls,
      messages: [...childControls.messages, ...resultRecords.messages],
      turnItems: resultRecords.turnItems,
    };
    const heldForRestart =
      task.result === null &&
      taskWorkState === "result_available" &&
      (yield* threadManagement
        .delegatedTaskResultPending(task.childThreadId, childRun?.delegatedTaskId)
        .pipe(Effect.mapError(threadManagementFailure)));
    const workState =
      task.result !== null ? "result_available" : heldForRestart ? "working" : taskWorkState;
    const status =
      task.result !== null
        ? taskStatusForRun(
            task.status === "completed" ||
              task.status === "failed" ||
              task.status === "cancelled" ||
              task.status === "interrupted"
              ? { status: task.status }
              : childRun,
          )
        : workState === "result_available"
          ? taskStatusForRun(taskResultRun ?? childRun)
          : taskStatusForRun(taskResultRun ?? childRun) === "queued"
            ? "queued"
            : "running";
    const derivedResult =
      task.result !== null
        ? task.result
        : taskResultRun !== undefined && isTerminalTaskStatus(status)
          ? subagentResultForRun(childProjection, taskResultRun).text
          : null;
    const resultTransfers = parentProjection.contextTransfers.filter(
      (transfer) =>
        transfer.type === "subagent_result" &&
        transfer.sourceThreadId === task.childThreadId &&
        transfer.targetThreadId === scope.thread.threadId,
    );
    const resultTransferForRun = (run: OrchestrationV2Run | undefined) =>
      !canExposeTaskRunResult(run)
        ? null
        : (resultTransfers.find((transfer) => transfer.sourcePoint.runId === run.id) ??
          (run.id === childRun?.id
            ? resultTransfers.find((transfer) => transfer.sourcePoint.runId === undefined)
            : undefined) ??
          null);
    const resultTransfer = taskResultTransfer(parentProjection, childProjection, task) ?? null;
    const terminalStatus = terminalRun === undefined ? null : taskStatusForRun(terminalRun);
    const latestTerminalSummary = canExposeTaskRunResult(terminalRun)
      ? terminalRun.id === childRun?.id
        ? derivedResult
        : subagentResultForRun(childProjection, terminalRun).text
      : null;
    const resultContextTransferId = resultTransfer?.id ?? null;
    const latestTerminalResultContextTransferId = resultTransferForRun(terminalRun)?.id ?? null;
    const modelSelection = childRun?.modelSelection ??
      childControls.thread.modelSelection ?? {
        instanceId: task.providerInstanceId,
        model: task.model,
      };
    const taskRunIds = activeTaskRunIds(childControls, task.id, childRun);
    const result = {
      taskId: task.id,
      childThreadId: task.childThreadId,
      link: formatThreadLink({
        environmentId: scope.environmentId,
        threadId: task.childThreadId,
      }),
      childRunId: childRun?.id ?? null,
      childNodeId: task.id,
      status,
      workState,
      hasPendingChildRuns: hasPendingChildRuns(childProjection, childRun),
      providerInstanceId: modelSelection.instanceId,
      model: modelSelection.model,
      options: modelSelection.options ?? [],
      summary: derivedResult,
      resultContextTransferId,
      latestTerminalRunId: terminalRun?.id ?? null,
      latestTerminalStatus:
        terminalStatus !== null && isTerminalTaskStatus(terminalStatus) ? terminalStatus : null,
      latestTerminalSummary: latestTerminalSummary === derivedResult ? null : latestTerminalSummary,
      latestTerminalResultContextTransferId:
        latestTerminalResultContextTransferId === resultContextTransferId
          ? null
          : latestTerminalResultContextTransferId,
      hasPendingQuestion:
        !isTerminalTaskStatus(status) &&
        (childControls.turnItems.some(
          (item) =>
            item.type === "secret_request" &&
            item.status === "waiting" &&
            item.nodeId !== null &&
            item.runId !== null &&
            taskRunIds.has(item.runId),
        ) ||
          childControls.runtimeRequests.some((request) => {
            const requestRunId = childControls.nodes.find(
              (node) => node.id === request.nodeId,
            )?.runId;
            return (
              request.kind === "user_input" &&
              request.status === "pending" &&
              request.responseCapability.type === "live" &&
              requestRunId != null &&
              taskRunIds.has(requestRunId)
            );
          })),
      pendingApproval:
        isTerminalTaskStatus(status) || task.completionDelivery?.state === "disposed"
          ? null
          : pendingTaskApproval(childControls, taskRunIds),
      waitTimedOut,
    } satisfies OrchestratorMcpDelegateTaskResult;
    const response: OrchestratorMcpDelegateTaskResult =
      endsTaskWait(result) || task.completionDelivery?.state === "disposed"
        ? result
        : { ...result, next: ORCHESTRATOR_MCP_RUNNING_TASK_NEXT };
    if (
      acknowledgeTerminal &&
      isTerminalTaskStatus(status) &&
      task.completionDelivery?.state !== "acknowledged" &&
      task.completionDelivery?.state !== "disposed"
    ) {
      const observingRun = ThreadManagementService.latestActiveRun(parentProjection);
      const acknowledgementRequestKey = yield* requestKey(undefined);
      yield* threadManagement
        .dispatch({
          type: "delegated_task.completion-delivery.acknowledge",
          commandId: stableCommandId({
            scope,
            requestKey: acknowledgementRequestKey,
            operation: acknowledgementOperation,
          }),
          parentThreadId: scope.thread.threadId,
          taskId,
          observedByRunId:
            observingRun?.providerInstanceId === scope.thread.providerInstanceId
              ? observingRun.id
              : null,
        })
        .pipe(
          Effect.mapError((error) =>
            failure(
              "orchestration_error",
              `Unable to acknowledge delegated task ${taskId}: ${errorMessage(error)}`,
            ),
          ),
        );
    }
    return response;
  });

  /** `mode=wait` on a task already recorded, as `delegateTask` does for its own. */
  const awaitTask = Effect.fn("OrchestratorMcpService.awaitTask")(function* (
    scope: McpThreadInvocationScope,
    taskId: NodeId,
    requestedTimeoutMs: number | undefined,
  ): Effect.fn.Return<OrchestratorMcpDelegateTaskResult, OrchestratorMcpFailure> {
    const timeoutMs = Math.min(
      MAX_WAIT_TIMEOUT_MS,
      Math.max(1, requestedTimeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS),
    );
    const waited = yield* waitForTask(scope, taskId, timeoutMs);
    if (Option.isSome(waited)) return waited.value;
    // As for a local task: once the blocking wait ends, a later result wakes the parent.
    yield* threadManagement
      .dispatch({
        type: "delegated_task.wake-policy",
        commandId: stableCommandId({
          scope,
          requestKey: taskId,
          operation: "delegate-task-wake-policy",
        }),
        parentThreadId: scope.thread.threadId,
        taskId,
        completionWake: "always",
      })
      .pipe(Effect.ignoreCause({ log: true }));
    return yield* readTask(scope, taskId, true, true);
  });

  /**
   * A task that runs in a linked environment, answered from its row here:
   * the follower records its result once its thread there ends.
   */
  const readRemoteTask = Effect.fn("OrchestratorMcpService.readRemoteTask")(function* (
    scope: McpThreadInvocationScope,
    task: OrchestrationV2Subagent,
    waitTimedOut: boolean,
    acknowledgeTerminal: boolean,
  ): Effect.fn.Return<OrchestratorMcpDelegateTaskResult, OrchestratorMcpFailure> {
    const status: OrchestratorMcpDelegateTaskResult["status"] =
      task.result === null
        ? "running"
        : task.status === "completed" ||
            task.status === "failed" ||
            task.status === "cancelled" ||
            task.status === "interrupted"
          ? task.status
          : "completed";
    const terminal = isTerminalTaskStatus(status);
    if (
      acknowledgeTerminal &&
      terminal &&
      task.completionDelivery?.state !== "acknowledged" &&
      task.completionDelivery?.state !== "disposed"
    ) {
      const parentProjection = yield* loadProjection(scope.thread.threadId);
      const observingRun = ThreadManagementService.latestActiveRun(parentProjection);
      yield* threadManagement
        .dispatch({
          type: "delegated_task.completion-delivery.acknowledge",
          commandId: stableCommandId({
            scope,
            requestKey: yield* requestKey(undefined),
            operation: "task-status-acknowledge",
          }),
          parentThreadId: scope.thread.threadId,
          taskId: task.id,
          observedByRunId:
            observingRun?.providerInstanceId === scope.thread.providerInstanceId
              ? observingRun.id
              : null,
        })
        .pipe(
          Effect.mapError((error) =>
            failure(
              "orchestration_error",
              `Unable to acknowledge delegated task ${task.id}: ${errorMessage(error)}`,
            ),
          ),
        );
    }
    return {
      taskId: task.id,
      childThreadId: null,
      ...(task.remoteChild === undefined
        ? {}
        : { remoteChild: task.remoteChild, link: formatThreadLink(task.remoteChild) }),
      childRunId: null,
      childNodeId: task.id,
      status,
      workState: terminal ? "result_available" : "working",
      hasPendingChildRuns: false,
      providerInstanceId: task.providerInstanceId,
      model: task.model,
      summary: task.result,
      resultContextTransferId: null,
      latestTerminalRunId: null,
      latestTerminalStatus: terminal
        ? (status as OrchestratorMcpDelegateTaskResult["latestTerminalStatus"])
        : null,
      latestTerminalSummary: terminal ? task.result : null,
      latestTerminalResultContextTransferId: null,
      // Its questions and approvals are answered in the environment it runs in.
      hasPendingQuestion: false,
      pendingApproval: null,
      waitTimedOut,
    } satisfies OrchestratorMcpDelegateTaskResult;
  });

  const waitForTask = Effect.fn("OrchestratorMcpService.waitForTask")(
    function* (scope: McpThreadInvocationScope, taskId: NodeId, _timeoutMs: number) {
      const streamError = (error: unknown) =>
        failure(
          "orchestration_error",
          `Unable to watch delegated task ${taskId}: ${errorMessage(error)}`,
        );
      // One global cursor before both reads captures later events from either thread.
      const afterSequence = yield* threadManagement
        .getThreadEventSequence(scope.thread.threadId)
        .pipe(Effect.mapError(streamError));
      const initial = yield* readTask(scope, taskId, false, true);
      if (endsTaskWait(initial)) {
        return Option.some(initial);
      }
      // One stream per event type, so transcript events never fill a buffer.
      // A remote task has no child here; its completion lands on the parent.
      const childThreadId = initial.childThreadId;
      const wakeEvents =
        childThreadId === null
          ? TASK_WAKE_EVENTS.filter(({ thread }) => thread === "parent")
          : TASK_WAKE_EVENTS;
      const streams = wakeEvents.map(({ thread, eventType }) =>
        threadManagement.streamStoredEventsFrom({
          threadId:
            thread === "parent" || childThreadId === null ? scope.thread.threadId : childThreadId,
          afterSequence,
          eventType,
        }),
      );
      if (childThreadId !== null) {
        streams.push(
          threadManagement
            .streamStoredEventsFrom({
              threadId: childThreadId,
              afterSequence,
              eventType: "turn-item.updated",
            })
            .pipe(
              Stream.filter(
                (stored) =>
                  stored.event.type === "turn-item.updated" &&
                  stored.event.payload.type === "secret_request",
              ),
            ),
        );
      }
      return yield* Stream.mergeAll(streams, { concurrency: "unbounded" }).pipe(
        Stream.mapError(streamError),
        Stream.mapEffect(() => readTask(scope, taskId, false, true)),
        Stream.filter(endsTaskWait),
        Stream.runHead,
      );
    },
    (effect, _scope, _taskId, timeoutMs) =>
      effect.pipe(Effect.timeoutOption(Duration.millis(timeoutMs)), Effect.map(Option.flatten)),
  );

  const scheduledTaskRunModes = Effect.fn("OrchestratorMcpService.scheduledTaskRunModes")(
    function* (task: ScheduledTask) {
      const modes = [{ runtimeMode: task.runtimeMode, interactionMode: task.interactionMode }];
      if (task.threadId === null) return modes;
      const bound = yield* threadManagement
        .getThreadShell(task.threadId)
        .pipe(Effect.mapError(threadManagementFailure));
      return bound === null || bound.deletedAt !== null ? modes : [...modes, bound];
    },
  );

  const withinLimits = (
    limits: {
      readonly runtimeMode: RuntimeMode;
      readonly interactionMode: ProviderInteractionMode;
    },
    modes: { readonly runtimeMode: RuntimeMode; readonly interactionMode: ProviderInteractionMode },
  ) =>
    runtimeModeRank(modes.runtimeMode) <= runtimeModeRank(limits.runtimeMode) &&
    interactionModeRank(modes.interactionMode) <= interactionModeRank(limits.interactionMode);

  /**
   * Its webhook URL starts runs, so only a caller that may start one sees it: never a client
   * approved for read-only access, and a thread caller only with a live turn, at modes covering
   * every mode the task runs at.
   */
  const summarizeScheduledTask = Effect.fn("OrchestratorMcpService.summarizeScheduledTask")(
    function* (
      scope: McpInvocationScope,
      caller: {
        readonly parent: Pick<OrchestrationV2ThreadProjection, "thread" | "runs"> | undefined;
        readonly limits: {
          readonly runtimeMode: RuntimeMode;
          readonly interactionMode: ProviderInteractionMode;
        };
      },
      task: ScheduledTask,
    ) {
      const live =
        caller.parent === undefined
          ? scope.client?.access !== "read-only"
          : Exit.isSuccess(yield* Effect.exit(assertLiveCaller(scope, caller.parent)));
      const modes = yield* scheduledTaskRunModes(task).pipe(Effect.option);
      return scheduledTaskSummary(
        task,
        live &&
          Option.isSome(modes) &&
          modes.value.every((mode) => withinLimits(caller.limits, mode)),
      );
    },
  );

  /**
   * A scheduled task the caller may change: one whose runs execute at modes no
   * broader than the caller's own, so editing its prompt cannot run work above
   * the caller's limits.
   */
  const loadScheduledTask = Effect.fn("OrchestratorMcpService.loadScheduledTask")(function* (
    scheduledTaskId: ScheduledTask["id"],
    limits: {
      readonly runtimeMode: RuntimeMode;
      readonly interactionMode: ProviderInteractionMode;
    },
  ): Effect.fn.Return<ScheduledTask, OrchestratorMcpFailure> {
    const { tasks } = yield* scheduledTasks
      .list()
      .pipe(
        Effect.mapError((error) =>
          failure("orchestration_error", `Could not load scheduled task: ${error.message}`),
        ),
      );
    const task = tasks.find((candidate) => candidate.id === scheduledTaskId);
    if (task === undefined) {
      return yield* failure("task_not_found", `Scheduled task ${scheduledTaskId} was not found.`);
    }
    for (const modes of yield* scheduledTaskRunModes(task)) {
      yield* resolveRuntimeMode(limits.runtimeMode, modes.runtimeMode);
      yield* resolveInteractionMode(limits.interactionMode, modes.interactionMode);
    }
    return task;
  });

  return OrchestratorMcpService.of({
    scheduleTask: Effect.fn("OrchestratorMcpService.scheduleTask")(function* (scope, input) {
      const { parent, limits } = yield* loadCaller(scope);
      const projectId = yield* resolveProjectTarget(parent, input.projectId);
      yield* assertLiveCallerForOtherProject(scope, parent, projectId);
      const project = yield* requireProject(projectId);
      const bindToCurrentThread =
        input.bindToCurrentThread ??
        (parent !== undefined && parent.thread.projectId === projectId);
      if (bindToCurrentThread && (parent === undefined || parent.thread.projectId !== projectId)) {
        return yield* failure(
          "invalid_request",
          parent === undefined
            ? "bindToCurrentThread needs an agent running inside a T3 thread."
            : "bindToCurrentThread binds to this thread, which belongs to a different project.",
        );
      }
      const modelSelection =
        parent?.thread.modelSelection ?? (yield* projectDefaultModelSelection(project));
      const derivedTitle = input.prompt.split("\n")[0]?.trim() ?? "";
      const title =
        input.title ?? (derivedTitle.length > 0 ? derivedTitle.slice(0, 80) : "Scheduled task");
      const upsertInput: ScheduledTaskUpsertInput = {
        title,
        prompt: input.prompt,
        enabled: input.enabled ?? true,
        schedule: input.schedule,
        projectId,
        threadId: bindToCurrentThread && parent !== undefined ? parent.thread.id : null,
        workspaceStrategy: scheduledTaskWorkspaceStrategy(bindToCurrentThread),
        modelSelection,
        runtimeMode: limits.runtimeMode,
        interactionMode: limits.interactionMode,
        createdBy: "agent",
        creationSource: "mcp",
        // Scope the idempotency key by provider session so two callers
        // reusing the same clientRequestId cannot collide on one task row.
        ...(input.clientRequestId === undefined
          ? {}
          : {
              commandId: stableCommandId({
                scope,
                requestKey: input.clientRequestId,
                operation: "schedule-task",
              }),
            }),
      };
      const { task } = yield* scheduledTasks
        .upsert(upsertInput)
        .pipe(
          Effect.mapError((error) =>
            failure("orchestration_error", `Could not schedule task: ${error.message}`),
          ),
        );
      return yield* summarizeScheduledTask(scope, { parent, limits }, task);
    }),
    listScheduledTasks: Effect.fn("OrchestratorMcpService.listScheduledTasks")(
      function* (scope, input) {
        const { parent, limits } = yield* loadCaller(scope);
        const projectId = input.projectId ?? parent?.thread.projectId;
        const { tasks } = yield* scheduledTasks
          .list()
          .pipe(
            Effect.mapError((error) =>
              failure("orchestration_error", `Could not list scheduled tasks: ${error.message}`),
            ),
          );
        return {
          tasks: yield* Effect.forEach(
            tasks.filter((task) => projectId === undefined || task.projectId === projectId),
            (task) => summarizeScheduledTask(scope, { parent, limits }, task),
          ),
        };
      },
    ),
    updateScheduledTask: Effect.fn("OrchestratorMcpService.updateScheduledTask")(
      function* (scope, input) {
        const { parent, limits } = yield* loadCaller(scope);
        const existing = yield* loadScheduledTask(input.scheduledTaskId, limits);
        yield* assertLiveCallerForOtherProject(scope, parent, existing.projectId);
        if (
          input.bindToCurrentThread === true &&
          (parent === undefined || parent.thread.projectId !== existing.projectId)
        ) {
          return yield* failure(
            "invalid_request",
            parent === undefined
              ? "bindToCurrentThread needs an agent running inside a T3 thread."
              : "bindToCurrentThread binds to this thread, which belongs to a different project.",
          );
        }
        const threadId =
          input.bindToCurrentThread === undefined
            ? existing.threadId
            : input.bindToCurrentThread && parent !== undefined
              ? parent.thread.id
              : null;
        // Update workspace strategy on rebinding so unbound root tasks cannot run in the shared checkout.
        const workspaceStrategy =
          input.bindToCurrentThread === undefined
            ? existing.workspaceStrategy
            : scheduledTaskWorkspaceStrategy(input.bindToCurrentThread);
        const upsertInput: ScheduledTaskUpsertInput = {
          id: existing.id,
          title: input.title ?? existing.title,
          prompt: input.prompt ?? existing.prompt,
          enabled: input.enabled ?? existing.enabled,
          schedule: input.schedule ?? existing.schedule,
          projectId: existing.projectId,
          threadId,
          workspaceStrategy,
          modelSelection: existing.modelSelection,
          runtimeMode: existing.runtimeMode,
          interactionMode: existing.interactionMode,
          createdBy: existing.createdBy,
          creationSource: existing.creationSource,
        };
        const { task } = yield* scheduledTasks
          .upsert(upsertInput)
          .pipe(
            Effect.mapError((error) =>
              failure("orchestration_error", `Could not update scheduled task: ${error.message}`),
            ),
          );
        return yield* summarizeScheduledTask(scope, { parent, limits }, task);
      },
    ),
    deleteScheduledTask: Effect.fn("OrchestratorMcpService.deleteScheduledTask")(
      function* (scope, input) {
        const { parent, limits } = yield* loadCaller(scope);
        const existing = yield* loadScheduledTask(input.scheduledTaskId, limits);
        yield* assertLiveCallerForOtherProject(scope, parent, existing.projectId);
        yield* scheduledTasks
          .delete({ id: existing.id })
          .pipe(
            Effect.mapError((error) =>
              failure("orchestration_error", `Could not delete scheduled task: ${error.message}`),
            ),
          );
        return { scheduledTaskId: existing.id, deleted: true };
      },
    ),
    requestSecret: Effect.fn("OrchestratorMcpService.requestSecret")(function* (scope, input) {
      const { scope: threadScope, parent } = yield* loadThreadCaller(scope, "request_secret");
      const threadId = threadScope.thread.threadId;
      const run = ThreadManagementService.latestActiveRun(parent);
      if (
        run === undefined ||
        run.rootNodeId === null ||
        run.providerInstanceId !== threadScope.thread.providerInstanceId
      ) {
        return yield* failure(
          "parent_not_active",
          "Asking for a secret requires an active run owned by this MCP provider session.",
        );
      }
      const runId = run.id;
      const nodeId = run.rootNodeId;
      const key = yield* requestKey(input.clientRequestId);
      const turnItemId = TurnItemId.make(
        `turn-item:secret-request:${stablePart(threadId)}:${stablePart(key)}`,
      );
      const record = (secretStatus: "pending" | "cancelled") =>
        threadManagement
          .dispatch({
            type: "secret_request.record",
            commandId: stableCommandId({
              scope,
              requestKey: key,
              operation: `secret-${secretStatus}`,
            }),
            threadId: threadId,
            runId,
            nodeId,
            turnItemId,
            label: input.label,
            reason: input.reason,
            ...(input.placeholder === undefined ? {} : { placeholder: input.placeholder }),
            ...(input.delivery === "file" ? { delivery: "file" as const } : {}),
            secretStatus,
          })
          .pipe(
            Effect.mapError((error) =>
              failure(
                "orchestration_error",
                `Could not record the secret request: ${errorMessage(error)}`,
              ),
            ),
          );
      yield* record("pending");
      // Only this call can hand the agent its ref, so the card must not
      // outlive it: a timeout, a failed wait or an aborted call closes it as
      // cancelled.
      const closeCard = record("cancelled").pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not close a secret request card", { error: error.message }),
        ),
      );

      const answered = yield* Effect.gen(function* () {
        while (true) {
          const projection = yield* threadManagement
            .getThreadRecords(threadId, ["runs", "turnItems"], {
              turnItemTypes: ["secret_request"],
              messageRoles: [],
            })
            .pipe(
              Effect.mapError((error) =>
                failure(
                  "orchestration_error",
                  `Unable to read the secret request: ${errorMessage(error)}`,
                ),
              ),
            );
          const item = projection.turnItems.find((candidate) => candidate.id === turnItemId);
          if (item?.type === "secret_request" && item.secretStatus !== "pending") {
            return item.secretStatus;
          }
          const current = projection.runs.find((candidate) => candidate.id === runId);
          if (
            current === undefined ||
            ThreadManagementService.isTerminalRunStatus(current.status)
          ) {
            yield* record("cancelled");
            return "cancelled" as const;
          }
          yield* Effect.sleep(Duration.millis(SECRET_REQUEST_POLL_INTERVAL_MS));
        }
      }).pipe(
        Effect.timeoutOption(
          Duration.millis(
            Math.min(input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS, MAX_WAIT_TIMEOUT_MS),
          ),
        ),
        Effect.onExit((exit) => (Exit.isSuccess(exit) ? Effect.void : closeCard)),
      );
      if (Option.isNone(answered)) yield* closeCard;
      const status = Option.isSome(answered)
        ? answered.value
        : yield* threadManagement
            .getThreadRecords(threadId, ["turnItems"], {
              turnItemTypes: ["secret_request"],
              messageRoles: [],
            })
            .pipe(
              Effect.map((records) => {
                const item = records.turnItems.find((candidate) => candidate.id === turnItemId);
                return item?.type === "secret_request" &&
                  (item.secretStatus === "saved" || item.secretStatus === "declined")
                  ? item.secretStatus
                  : ("timed_out" as const);
              }),
              Effect.orElseSucceed(() => "timed_out" as const),
            );
      yield* Effect.annotateCurrentSpan({ "secret_request.status": status });
      yield* Metrics.increment(Metrics.secretRequestsTotal, { status });
      if (status !== "saved") return { status };
      if (input.delivery === "file") {
        const file = yield* secretRequests
          .saveToFile({ threadId, turnItemId })
          .pipe(Effect.mapError((error) => failure("orchestration_error", error.message)));
        return { status, file };
      }
      const secretRef = yield* secretRequests.savedRef({ threadId: threadId, turnItemId });
      if (Option.isNone(secretRef)) {
        return yield* failure(
          "orchestration_error",
          "The user saved the secret, but it could not be read. Ask again with a new clientRequestId.",
        );
      }
      return { status, secretRef: secretRef.value };
    }),

    capabilities: Effect.fn("OrchestratorMcpService.capabilities")(function* (scope, input = {}) {
      const { parent, limits } = yield* loadCaller(scope);
      const providers = yield* loadProviders;
      const orchestrationCapableInstanceIds = yield* loadOrchestrationCapableInstanceIds();
      const settings = yield* serverSettings.getSettings.pipe(
        Effect.mapError(() => failure("orchestration_error", "Unable to read server settings.")),
      );
      const inherited = parent?.thread.modelSelection;
      const searchTerms = input.search?.toLowerCase().split(/\s+/) ?? [];
      return {
        parentThreadId: parent?.thread.id ?? null,
        inheritedProviderInstanceId: inherited?.instanceId ?? null,
        inheritedModel: inherited?.model ?? null,
        inheritedOptions: inherited?.options ?? [],
        runtimeMode: limits.runtimeMode,
        interactionMode: limits.interactionMode,
        providers: providers.map((provider) => {
          const constraints = providerConstraints(
            provider,
            orchestrationCapableInstanceIds.has(provider.instanceId),
          );
          const { listed, omitted } = listCapabilityModels({
            provider,
            preferences: settings.providerModelPreferences?.[provider.instanceId],
            searchTerms,
            isPinned: (model) =>
              model.isCustom ||
              (inherited?.instanceId === provider.instanceId && inherited.model === model.slug) ||
              (settings.favorites ?? []).some(
                (favorite) =>
                  favorite.provider === provider.instanceId && favorite.model === model.slug,
              ),
          });
          return {
            providerInstanceId: provider.instanceId,
            driverKind: provider.driver,
            displayName: provider.displayName ?? null,
            models: listed.map((model) => {
              const options = model.capabilities?.optionDescriptors ?? [];
              return {
                id: model.slug,
                ...(model.name.toLowerCase() === model.slug.toLowerCase()
                  ? {}
                  : { label: model.name }),
                ...(options.length === 0 ? {} : { options: options.map(capabilityModelOption) }),
              };
            }),
            ...(omitted === 0 ? {} : { omittedModels: omitted }),
            ...(provider.supportedRuntimeModes === undefined ||
            provider.supportedRuntimeModes.length === 0
              ? {}
              : { runtimeModes: [...provider.supportedRuntimeModes] }),
            canRunChildTask: constraints.length === 0,
            canRunCrossProviderChildTask: constraints.length === 0,
            constraints: [...constraints],
          };
        }),
        features: {
          appOwnedSubagents: true,
          asyncPolling: true,
          cancellation: true,
          batchThreadCreation: true,
          threadManagement: true,
          incrementalThreadRead: true,
          scheduledTasks: true,
          maxBatchThreads: 20,
        },
      };
    }),
    delegateTask: Effect.fn("OrchestratorMcpService.delegateTask")(function* (callerScope, input) {
      const environmentId =
        input.target === undefined
          ? undefined
          : PeerForwarding.remoteTarget(callerScope, input.target.environmentId);
      if (input.target !== undefined && environmentId !== undefined) {
        yield* requireCapability(callerScope);
        const scope = yield* requireThreadScope(callerScope, "delegate_task");
        // The task's child runs as an ordinary thread there; this thread keeps the task.
        const { taskId } = yield* remoteDelegation.delegate(scope, {
          ...input,
          target: { ...input.target, environmentId },
        });
        return yield* input.mode === "wait"
          ? awaitTask(scope, taskId, input.timeoutMs)
          : readTask(scope, taskId, false, true);
      }
      const { scope, parent } = yield* loadThreadCaller(callerScope, "delegate_task");
      if (
        input.target?.projectId !== undefined &&
        input.target.projectId !== parent.thread.projectId
      ) {
        return yield* failure(
          "invalid_request",
          "A local task runs in this thread's project. Omit target.projectId, or pass target.environmentId to run it in that environment's project.",
        );
      }
      const parentRun = parent.runs
        .filter(ThreadManagementService.isActiveRun)
        .toSorted((left, right) => right.ordinal - left.ordinal)[0];
      if (
        parentRun === undefined ||
        parentRun.rootNodeId === null ||
        parentRun.providerInstanceId !== scope.thread.providerInstanceId
      ) {
        return yield* failure(
          "parent_not_active",
          "Delegated tasks require an active run owned by this MCP provider session.",
        );
      }
      const providers = yield* loadProviders;
      const key = yield* requestKey(input.clientRequestId);
      const commandId = stableCommandId({
        scope,
        requestKey: key,
        operation: "delegate-task",
      });
      const isRetryOfAcceptedDelegation = yield* threadManagement.hasReceipt(commandId);
      const target = yield* resolveTargetRechecking({
        parent,
        target: input.target,
        providers,
        skipProjectEnablementFilter: isRetryOfAcceptedDelegation,
      });
      const runtimeMode = yield* resolveRuntimeMode(
        parent.thread.runtimeMode,
        input.runtimeMode,
        target,
      );
      const interactionMode = yield* resolveInteractionMode(
        parent.thread.interactionMode,
        input.interactionMode,
      );
      let workspaceStrategy: OrchestrationV2ThreadLaunchWorkspaceStrategy | undefined;
      if (input.isolation === "worktree" && !isRetryOfAcceptedDelegation) {
        const project = yield* requireProject(parent.thread.projectId);
        const base = yield* gitDriver
          .resolveCommit({
            cwd: parent.thread.worktreePath ?? project.workspaceRoot,
            revision: "HEAD",
          })
          .pipe(
            Effect.mapError(() =>
              failure("invalid_request", "Unable to resolve the parent checkout commit."),
            ),
          );
        // Launch preparation creates the worktree from the project root, so a
        // parent checkout in another repository (such as a Git folder inside
        // Scratch) would hand it a commit it cannot find.
        if (parent.thread.worktreePath !== null) {
          yield* gitDriver
            .resolveCommit({ cwd: project.workspaceRoot, revision: base.commitSha })
            .pipe(
              Effect.mapError(() =>
                failure(
                  "invalid_request",
                  `Isolation "worktree" creates the child checkout in project "${project.title}" (${project.workspaceRoot}), which does not contain the parent checkout's commit. Use isolation "shared" to work in the parent's checkout.`,
                ),
              ),
            );
        }
        workspaceStrategy = { type: "worktree", baseRef: base.commitSha, startFromOrigin: false };
      }
      // ThreadManagementService.dispatch is the chokepoint for this command
      // type's own enablement check, using the same command id and its
      // receipt-replay exemption, so no separate assert runs here.
      const result = yield* threadManagement
        .dispatch({
          type: "delegated_task.request",
          createdBy: "agent",
          creationSource: "mcp",
          commandId,
          parentThreadId: scope.thread.threadId,
          parentRunId: parentRun.id,
          parentNodeId: parentRun.rootNodeId,
          task: taskPrompt(input),
          ...(input.title === undefined ? {} : { title: input.title }),
          modelSelection: target.modelSelection,
          runtimeMode,
          interactionMode,
          ...(workspaceStrategy === undefined ? {} : { workspaceStrategy }),
          // Async delegations wake the parent on every child terminal; wait
          // delegations deliver through the blocking tool call, so a wake is
          // only needed if the parent settled first (timeout, disconnect).
          completionWake: input.mode === "wait" ? "settled_only" : "always",
        })
        .pipe(
          Effect.mapError((error) =>
            error._tag === "ThreadManagementProviderInstanceDisabledError"
              ? threadManagementFailure(error)
              : failure(
                  "orchestration_error",
                  `Unable to create delegated task: ${errorMessage(error)}`,
                ),
          ),
        );
      const taskEvent = result.storedEvents.find(
        (stored) =>
          stored.event.type === "subagent.updated" && stored.event.payload.origin === "app_owned",
      );
      if (taskEvent?.event.type !== "subagent.updated") {
        return yield* failure(
          "orchestration_error",
          "Delegated task command did not produce a task projection.",
        );
      }
      const taskId = taskEvent.event.payload.id;
      const childThreadId = taskEvent.event.payload.childThreadId;
      const childRunEvent = result.storedEvents.find(
        (stored) => stored.event.type === "run.created" && stored.event.threadId === childThreadId,
      );
      if (
        childThreadId !== null &&
        childRunEvent?.event.type === "run.created" &&
        childRunEvent.event.payload.workspacePreparation !== undefined
      ) {
        yield* threadLaunch.prepareRun({
          commandId,
          threadId: childThreadId,
          runId: childRunEvent.event.payload.id,
        });
      }

      if (input.mode !== "wait") {
        return yield* readTask(scope, taskId, false, true);
      }
      const timeoutMs = Math.min(
        MAX_WAIT_TIMEOUT_MS,
        Math.max(1, input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS),
      );
      const waited = yield* waitForTask(scope, taskId, timeoutMs);
      if (Option.isSome(waited) && isTerminalTaskStatus(waited.value.status)) {
        return waited.value;
      }
      // An incomplete wait gives up delivery: upgrade so a later terminal
      // wakes the parent even mid-turn.
      yield* threadManagement
        .dispatch({
          type: "delegated_task.wake-policy",
          commandId: stableCommandId({
            scope,
            requestKey: key,
            operation: "delegate-task-wake-policy",
          }),
          parentThreadId: scope.thread.threadId,
          taskId,
          completionWake: "always",
        })
        .pipe(
          Effect.catch((error) =>
            Effect.logWarning("orchestrator-mcp.delegate-task.wake-policy-failed", {
              taskId,
              outcome:
                error._tag === "OrchestratorCommandPreviouslyRejectedError"
                  ? "previously_rejected"
                  : "dispatch_failed",
              error,
            }),
          ),
          Effect.catchCause((cause) =>
            Effect.logWarning("orchestrator-mcp.delegate-task.wake-policy-failed", {
              taskId,
              outcome: "defect",
              cause,
            }),
          ),
        );
      return yield* readTask(scope, taskId, Option.isNone(waited), true);
    }),
    taskStatus: Effect.fn("OrchestratorMcpService.taskStatus")(function* (callerScope, taskId) {
      const scope = yield* requireThreadScope(callerScope, "task_status");
      return yield* readTask(scope, taskId, false, true);
    }),
    cancelTask: Effect.fn("OrchestratorMcpService.cancelTask")(function* (callerScope, input) {
      const scope = yield* requireThreadScope(callerScope, "task_cancel");
      const current = yield* readTask(scope, input.taskId);
      const childThreadId = current.childThreadId;
      if (childThreadId === null) {
        // The task runs in a linked environment: its thread there is stopped through the link.
        const subagents = yield* loadTasks(scope.thread.threadId, [input.taskId]);
        const remoteTask = subagents.find(
          (task) =>
            task.id === input.taskId &&
            task.origin === "app_owned" &&
            task.remoteChild !== undefined,
        );
        if (remoteTask === undefined) {
          return yield* failure(
            "task_not_found",
            `Delegated task ${input.taskId} does not belong to thread ${scope.thread.threadId}.`,
          );
        }
        return yield* remoteDelegation.cancel(scope, remoteTask, input);
      }
      const key = yield* requestKey(input.clientRequestId);
      const parentProjection = yield* loadProjection(scope.thread.threadId);
      // Cancelling stops the child and every task under it, each a write to a
      // thread its user may have raised above the parent's modes since it was
      // delegated. All of them are checked before anything is stopped.
      const assertStoppable = Effect.fn("OrchestratorMcpService.assertStoppable")(function* (
        threadId: ThreadId,
      ): Effect.fn.Return<void, OrchestratorMcpFailure> {
        const shell = yield* threadManagement
          .getThreadShell(threadId)
          .pipe(Effect.mapError(threadManagementFailure));
        if (shell !== null && shell.deletedAt === null) {
          yield* resolveRuntimeMode(parentProjection.thread.runtimeMode, shell.runtimeMode);
          yield* resolveInteractionMode(
            parentProjection.thread.interactionMode,
            shell.interactionMode,
          );
        }
        const { subagents } = yield* threadManagement
          .getThreadRecords(threadId, ["subagents"])
          .pipe(Effect.mapError(threadManagementFailure));
        for (const task of subagents) {
          if (task.origin === "app_owned" && task.childThreadId !== null) {
            yield* assertStoppable(task.childThreadId);
          }
        }
      });
      yield* assertStoppable(childThreadId);
      const parentTask = (yield* loadTasks(scope.thread.threadId, [input.taskId])).find(
        (task) => task.id === input.taskId && task.origin === "app_owned",
      );
      const disposeCompletionDelivery =
        parentTask?.completionDelivery?.state === "disposed"
          ? Effect.void
          : threadManagement
              .dispatch({
                type: "delegated_task.completion-delivery.dispose",
                commandId: stableCommandId({
                  scope,
                  requestKey: key,
                  operation: "cancel-task-completion-delivery",
                }),
                parentThreadId: scope.thread.threadId,
                taskId: input.taskId,
              })
              .pipe(
                Effect.asVoid,
                Effect.mapError((error) =>
                  failure(
                    "orchestration_error",
                    `Unable to dispose delegated task ${input.taskId} completion delivery: ${errorMessage(error)}`,
                  ),
                ),
              );
      const stopChild = Effect.gen(function* () {
        const commandId = stableCommandId({ scope, requestKey: key, operation: "cancel-task" });
        const reason = agentStopReason(input.reason);
        yield* threadManagement
          .dispatch({
            type: "thread.stop",
            commandId,
            threadId: childThreadId,
            stopDelegatedTasks: false,
            reason,
          })
          .pipe(
            Effect.mapError((error) =>
              failure(
                "task_not_cancellable",
                `Unable to stop delegated task ${input.taskId}: ${errorMessage(error)}`,
              ),
            ),
          );
        yield* threadManagement
          .stopDelegatedTasks({ threadId: childThreadId, commandId, reason })
          .pipe(
            Effect.mapError((error) =>
              failure(
                "task_not_cancellable",
                `Stopped delegated task ${input.taskId}, but not every task it delegated: ${errorMessage(error)}`,
              ),
            ),
          );
        const stopped = yield* threadManagement
          .getThreadRecords(childThreadId, ["runs"])
          .pipe(Effect.mapError(threadManagementFailure));
        for (const run of stopped.runs) {
          if (
            run.status !== "queued" ||
            (run.delegatedTaskId !== input.taskId && run.id !== current.childRunId)
          )
            continue;
          // Stop preserves the queue for Resume. Cancelling a task must also
          // remove that task's queued turn, including a previously held one.
          yield* threadManagement
            .dispatch({
              type: "queued-run.cancel",
              commandId: stableCommandId({
                scope,
                requestKey: key,
                operation: `cancel-task-queued-run:${run.id}`,
              }),
              threadId: childThreadId,
              runId: run.id,
            })
            .pipe(Effect.mapError(threadManagementFailure));
        }
      });
      // Checked above; a user raising one of these threads meanwhile is
      // caught again under that thread's lock, which leaves it running.
      const refused = yield* Ref.make<DispatchModeRefusal | undefined>(undefined);
      const stopWithinLimit = stopChild.pipe(
        Effect.provideService(DispatchModeLimit, {
          runtimeMode: parentProjection.thread.runtimeMode,
          interactionMode: parentProjection.thread.interactionMode,
          refused,
        }),
        Effect.catch((error) =>
          Effect.flatMap(Ref.get(refused), (refusal) =>
            Effect.fail(
              refusal === undefined
                ? error
                : failure(
                    refusal.mode === "runtime"
                      ? "runtime_mode_escalation_denied"
                      : "interaction_mode_escalation_denied",
                    `Thread ${refusal.threadId} now runs in ${refusal.runtimeMode}/${refusal.interactionMode} mode, above this thread's; its user changed it while the task was being cancelled.`,
                  ),
            ),
          ),
        ),
      );
      // A follow-up that lost its child run stays running on the parent, while its
      // status here comes from the child's last run. Stop on the parent cancels that task.
      const cancelOrphan = Effect.gen(function* () {
        if (parentTask?.runId == null || !isOrchestrationV2WorkActive(parentTask.status))
          return false;
        yield* threadManagement.dispatch({
          type: "subagent.stop",
          commandId: stableCommandId({
            scope,
            requestKey: key,
            operation: "cancel-task-orphan",
          }),
          threadId: scope.thread.threadId,
          runId: parentTask.runId,
          subagentId: parentTask.id,
        });
        const { subagents } = yield* threadManagement.getThreadRecords(
          scope.thread.threadId,
          ["subagents"],
          { subagentIds: [input.taskId] },
        );
        return subagents.some((task) => task.id === input.taskId && task.status === "cancelled");
      }).pipe(Effect.mapError(threadManagementFailure));
      if (isTerminalTaskStatus(current.status)) {
        // The child can still run work for another turn, so it is stopped either way.
        yield* stopWithinLimit;
        const cancelled = yield* cancelOrphan;
        yield* disposeCompletionDelivery;
        return {
          taskId: input.taskId,
          status: cancelled ? "cancelled" : current.status,
        } satisfies OrchestratorMcpTaskCancelResult;
      }
      const child = yield* loadProjection(childThreadId);
      if (
        current.workState !== "waiting_for_children" &&
        ThreadManagementService.latestActiveRun(child) === undefined &&
        !child.runs.some(
          (run) =>
            run.status === "queued" &&
            (run.delegatedTaskId === input.taskId || run.id === current.childRunId),
        )
      ) {
        if (yield* cancelOrphan) return { taskId: input.taskId, status: "cancelled" };
        return yield* failure(
          "task_not_cancellable",
          `Delegated task ${input.taskId} has no interruptible child run.`,
        );
      }
      yield* stopWithinLimit;
      yield* disposeCompletionDelivery.pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("orchestrator-mcp.cancel-task.delivery-dispose-failed", {
            taskId: input.taskId,
            cause,
          }),
        ),
      );
      return {
        taskId: input.taskId,
        status: "cancel_requested",
      };
    }),
    createThreads: Effect.fn("OrchestratorMcpService.createThreads")(
      function* (callerScope, input) {
        const { scope, parent } = yield* loadThreadCaller(callerScope, "create_threads");
        const parentRun = ThreadManagementService.latestActiveRun(parent);
        if (
          parentRun === undefined ||
          parentRun.rootNodeId === null ||
          parentRun.providerInstanceId !== scope.thread.providerInstanceId
        ) {
          return yield* failure(
            "parent_not_active",
            "Thread creation requires an active run owned by this MCP provider session.",
          );
        }
        const parentNodeId = parentRun.rootNodeId;
        const providers = yield* loadProviders;
        const key = yield* requestKey(input.clientRequestId);
        const created = yield* Effect.forEach(
          input.threads,
          (request, index) =>
            Effect.gen(function* () {
              const commandId = stableCommandId({
                scope,
                requestKey: key,
                operation: "create-thread",
                index,
              });
              const threadId = stableThreadId({
                scope,
                requestKey: key,
                index,
              });
              const isRetryOfAcceptedCreation = yield* threadManagement.hasReceipt(commandId);
              const committedThread = isRetryOfAcceptedCreation
                ? yield* threadManagement
                    .getThreadShell(threadId)
                    .pipe(Effect.mapError(threadManagementFailure))
                : null;
              const target = yield* resolveTargetRechecking({
                parent,
                target:
                  committedThread === null
                    ? request.target
                    : {
                        ...request.target,
                        providerInstanceId: committedThread.modelSelection.instanceId,
                      },
                providers,
                skipProjectEnablementFilter: isRetryOfAcceptedCreation,
              });
              const runtimeMode = yield* resolveRuntimeMode(
                parent.thread.runtimeMode,
                request.runtimeMode,
                target,
              );
              const interactionMode = yield* resolveInteractionMode(
                parent.thread.interactionMode,
                request.interactionMode,
              );
              yield* assertTargetEnabledForProject(parent, commandId, target);
              const title = threadTitle({
                parentTitle: parent.thread.title,
                prompt: request.prompt,
                title: request.title,
                index,
              });
              yield* threadManagement
                .dispatch({
                  type: "thread.create",
                  createdBy: "agent",
                  creationSource: "mcp",
                  commandId,
                  threadId,
                  projectId: parent.thread.projectId,
                  title,
                  modelSelection: target.modelSelection,
                  runtimeMode,
                  interactionMode,
                  branch: parent.thread.branch,
                  worktreePath: parent.thread.worktreePath,
                  ...(parent.thread.linkOrigin === undefined
                    ? {}
                    : { linkOrigin: parent.thread.linkOrigin }),
                })
                .pipe(
                  Effect.mapError((error) =>
                    failure(
                      "orchestration_error",
                      `Unable to create thread ${index + 1}: ${errorMessage(error)}`,
                    ),
                  ),
                );
              // A receipt can appear after target resolution; use the committed thread's selection.
              const resolvedModelSelection = (yield* threadManagement
                .getThreadRecords(threadId, [])
                .pipe(Effect.mapError(threadManagementFailure))).thread.modelSelection;
              if (request.prompt !== undefined) {
                yield* threadManagement
                  .dispatch({
                    type: "message.dispatch",
                    createdBy: "agent",
                    creationSource: "mcp",
                    commandId: stableCommandId({
                      scope,
                      requestKey: key,
                      operation: "dispatch-thread",
                      index,
                    }),
                    threadId,
                    senderThreadId: scope.thread.threadId,
                    messageId: stableMessageId({
                      scope,
                      requestKey: key,
                      index,
                    }),
                    text: request.prompt,
                    attachments: [],
                    modelSelection: resolvedModelSelection,
                    dispatchMode: { type: "start_immediately" },
                  })
                  .pipe(
                    Effect.mapError((error) =>
                      error._tag === "ThreadManagementProviderInstanceDisabledError"
                        ? threadManagementFailure(error)
                        : failure(
                            "orchestration_error",
                            `Unable to start thread ${index + 1}: ${errorMessage(error)}`,
                          ),
                    ),
                  );
              }
              const projection = yield* loadProjection(threadId);
              const run = projection.runs.at(-1);
              yield* threadManagement
                .dispatch({
                  type: "thread.created.record",
                  commandId: stableCommandId({
                    scope,
                    requestKey: key,
                    operation: "record-created-thread",
                    index,
                  }),
                  parentThreadId: scope.thread.threadId,
                  parentRunId: parentRun.id,
                  parentNodeId,
                  targetThreadId: threadId,
                  targetRunId: run?.id ?? null,
                })
                .pipe(
                  Effect.mapError((error) =>
                    failure(
                      "orchestration_error",
                      `Unable to record thread ${index + 1} in the parent timeline: ${errorMessage(error)}`,
                    ),
                  ),
                );
              return {
                threadId,
                link: formatThreadLink({ environmentId: scope.environmentId, threadId }),
                runId: run?.id ?? null,
                status: run?.status ?? "idle",
                title: projection.thread.title,
                createdBy: projection.thread.createdBy,
                creationSource: projection.thread.creationSource,
                providerInstanceId: resolvedModelSelection.instanceId,
                model: resolvedModelSelection.model,
              } satisfies OrchestratorMcpCreatedThread;
            }),
          { concurrency: 1 },
        );
        return { threads: created };
      },
    ),
    listThreads: Effect.fn("OrchestratorMcpService.listThreads")(function* (scope, input) {
      const { parent } = yield* loadCaller(scope);
      const projectId = input.allProjects
        ? null
        : yield* resolveProjectTarget(parent, input.projectId);
      const projectThreads = yield* threadManagement
        .listProjectThreads({
          projectId: projectId ?? undefined,
          includeSubagents: input.includeSubagents !== false,
        })
        .pipe(
          Effect.mapError((error) =>
            failure("orchestration_error", `Unable to list threads: ${errorMessage(error)}`),
          ),
        );
      const nowMs = yield* Clock.currentTimeMillis;
      const statuses = input.statuses === undefined ? null : new Set(input.statuses);
      const titleContains = input.titleContains?.toLocaleLowerCase();
      const filtered = projectThreads
        .filter(
          (thread) => statuses === null || statuses.has(thread.activityRunStatus ?? thread.status),
        )
        .filter(
          (thread) =>
            input.settled === undefined || threadSettlement(thread).settled === input.settled,
        )
        .filter(
          (thread) => input.snoozed === undefined || isSnoozed(thread, nowMs) === input.snoozed,
        )
        .filter(
          (thread) =>
            titleContains === undefined || thread.title.toLocaleLowerCase().includes(titleContains),
        );
      const cursor = input.cursor ?? 0;
      const limit = input.limit ?? DEFAULT_THREAD_LIST_LIMIT;
      const page = filtered.slice(cursor, cursor + limit);
      const nextCursor = cursor + page.length < filtered.length ? cursor + page.length : null;
      return {
        projectId,
        currentThreadId: parent?.thread.id ?? null,
        threads: page.map((shell) => listItemFromShell(scope, shell, nowMs)),
        nextCursor,
        total: filtered.length,
      } satisfies OrchestratorMcpThreadListResult;
    }),
    readThread: Effect.fn("OrchestratorMcpService.readThread")(function* (scope, input) {
      const { parent, target, shell } = yield* loadReadableThread(scope, input.threadId);
      const view = input.view ?? "messages";
      const afterPosition = input.afterPosition ?? -1;
      const limit = input.limit ?? DEFAULT_THREAD_READ_LIMIT;
      const maxChars = input.maxCharsPerItem ?? DEFAULT_THREAD_ITEM_MAX_CHARS;
      const timeline = yield* threadManagement
        .getTimelinePage(input.threadId, {
          afterPosition,
          limit,
          view,
          ...(input.itemId === undefined ? {} : { itemId: input.itemId }),
        })
        .pipe(Effect.mapError(threadManagementFailure));
      const page = timeline.items;
      const messageIdsByThread = new Map<ThreadId, Array<MessageId>>();
      for (const row of page) {
        if (row.item.type !== "user_message" && row.item.type !== "assistant_message") continue;
        const ids = messageIdsByThread.get(row.sourceThreadId) ?? [];
        ids.push(row.item.messageId);
        messageIdsByThread.set(row.sourceThreadId, ids);
      }
      const sourceMessages = yield* Effect.forEach(
        [...messageIdsByThread],
        ([threadId, messageIds]) =>
          threadManagement.getThreadRecords(threadId, ["messages"], { messageIds }).pipe(
            Effect.map((records) => [threadId, records.messages] as const),
            Effect.mapError(threadManagementFailure),
          ),
        { concurrency: 1 },
      );
      const messagesByThreadId = new Map(sourceMessages);
      const returnedRunIds = new Set(
        page.filter((row) => row.sourceThreadId === target.thread.id).map((row) => row.item.runId),
      );
      const tasks =
        parent === undefined
          ? []
          : directAppOwnedChildTasks(
              {
                thread: parent.thread,
                subagents: yield* loadTasks(
                  parent.thread.id,
                  directChildTaskIds(target, returnedRunIds),
                ),
              },
              target,
              returnedRunIds,
            );
      if (
        parent !== undefined &&
        scope.thread !== undefined &&
        tasks.length > 0 &&
        (input.textOffset ?? 0) === 0
      ) {
        for (const task of tasks) {
          const transfer = taskResultTransfer(parent, target, task);
          const resultRunId = transfer?.sourcePoint.runId ?? delegatedTaskRun(target, task)?.id;
          const resultRunIds = resultRunId === undefined ? [] : [resultRunId];
          const resultRecords = yield* threadManagement
            .getThreadRecords(target.thread.id, ["messages", "turnItems"], {
              messageRoles: ["assistant"],
              messageRunIds: resultRunIds,
              turnItemRunIds: resultRunIds,
              turnItemTypes: ["assistant_message", "error"],
            })
            .pipe(Effect.mapError(threadManagementFailure));
          if (
            pageIncludesTerminalTaskResult({
              parent,
              page,
              task,
              target: { ...target, ...resultRecords },
              maxChars,
            })
          ) {
            yield* readTask(
              scope as McpThreadInvocationScope,
              task.id,
              false,
              true,
              "thread-read-acknowledge",
            );
          }
        }
      }
      return {
        thread: threadDetail(
          scope,
          target,
          timeline.totalItems,
          shell,
          yield* Clock.currentTimeMillis,
        ),
        recentRuns: target.runs
          .toSorted((left, right) => right.ordinal - left.ordinal)
          .slice(0, input.runLimit ?? DEFAULT_THREAD_RUN_LIMIT)
          .map(threadRun),
        items: page.map((row) =>
          timelineItem({
            row,
            maxChars,
            messagesByThreadId,
            ...(input.itemId === undefined ? {} : { textOffset: input.textOffset ?? 0 }),
          }),
        ),
        nextPosition: page.at(-1)?.position ?? null,
        hasMore: timeline.hasMore,
      } satisfies OrchestratorMcpThreadReadResult;
    }),
    sendToThread: Effect.fn("OrchestratorMcpService.sendToThread")(function* (scope, input) {
      const { parent, limits, target } = yield* loadScopedThread(scope, input.threadId);
      yield* assertLiveCallerForOtherThread(scope, parent, target);
      yield* resolveRuntimeMode(limits.runtimeMode, target.thread.runtimeMode);
      yield* resolveInteractionMode(limits.interactionMode, target.thread.interactionMode);

      const mode = input.mode ?? "auto";
      const key = yield* requestKey(input.clientRequestId);
      const messageId = stableOperationMessageId({
        scope,
        requestKey: key,
        operation: "thread-send",
      });
      const result = yield* threadManagement
        .sendToThread({
          projectId: target.thread.projectId,
          commandId: stableCommandId({
            scope,
            requestKey: key,
            operation: "thread-send",
          }),
          threadId: input.threadId,
          ...(parent === undefined ? {} : { senderThreadId: parent.thread.id }),
          messageId,
          text: input.message,
          attachments: [],
          mode,
          createdBy: "agent",
          creationSource: "mcp",
        })
        .pipe(
          Effect.mapError((error) =>
            isThreadManagementError(error)
              ? threadManagementFailure(error)
              : failure(
                  "orchestration_error",
                  `Unable to send to thread ${input.threadId}: ${userFacingDispatchErrorMessage(error) ?? errorMessage(error)}`,
                ),
          ),
        );
      return {
        threadId: input.threadId,
        link: threadLinkFor(scope, input.threadId),
        messageId,
        runId: result.run.id,
        ...(result.run.delegatedTaskId === undefined ? {} : { taskId: result.run.delegatedTaskId }),
        status: result.run.status,
        delivery: result.delivery,
      } satisfies OrchestratorMcpThreadSendResult;
    }),
    waitForThread: Effect.fn("OrchestratorMcpService.waitForThread")(function* (scope, input) {
      const { parent, target } = yield* loadScopedThread(scope, input.threadId);
      const result = yield* threadManagement
        .waitForThread({
          projectId: target.thread.projectId,
          threadId: input.threadId,
          ...(input.runId === undefined ? {} : { runId: input.runId }),
          timeoutMs: Math.min(
            MAX_WAIT_TIMEOUT_MS,
            Math.max(1, input.timeoutMs ?? DEFAULT_WAIT_TIMEOUT_MS),
          ),
          ...(input.untilDelegatedWorkSettled === true ? { untilDelegatedWorkSettled: true } : {}),
        })
        .pipe(Effect.mapError(threadManagementFailure));
      const status = result.run === null ? "idle" : runOutcome(result.run);
      const taskId = result.run?.delegatedTaskId;
      const ownedTask =
        result.timedOut &&
        status !== "waiting" &&
        parent !== undefined &&
        taskId !== undefined &&
        (yield* loadTasks(parent.thread.id, [taskId])).some(
          (task) =>
            task.id === taskId &&
            task.origin === "app_owned" &&
            task.threadId === parent.thread.id &&
            task.childThreadId === input.threadId &&
            task.completionDelivery?.state !== "disposed",
        );
      // A child waiting on a question or approval needs an answer, not a wake.
      const childRequests = ownedTask
        ? (yield* threadManagement
            .getThreadRecords(input.threadId, ["runtimeRequests"])
            .pipe(Effect.mapError(threadManagementFailure))).runtimeRequests
        : [];
      const wakesCaller =
        ownedTask && !childRequests.some((request) => request.status === "pending");
      return {
        threadId: input.threadId,
        runId: result.run?.id ?? null,
        status,
        timedOut: result.timedOut,
        hasPendingQuestion: result.hasPendingQuestion,
        pendingApproval: result.pendingApproval,
        ...(wakesCaller ? { next: ORCHESTRATOR_MCP_RUNNING_TASK_NEXT } : {}),
        ...(result.resultRun === undefined
          ? {}
          : {
              resultRun: { runId: result.resultRun.id, status: runOutcome(result.resultRun) },
            }),
      } satisfies OrchestratorMcpThreadWaitResult;
    }),
    interruptThread: Effect.fn("OrchestratorMcpService.interruptThread")(function* (scope, input) {
      const { parent, limits, target } = yield* loadScopedThread(scope, input.threadId);
      yield* assertLiveCallerForOtherThread(scope, parent, target);
      yield* resolveRuntimeMode(limits.runtimeMode, target.thread.runtimeMode);
      yield* resolveInteractionMode(limits.interactionMode, target.thread.interactionMode);
      const key = yield* requestKey(input.clientRequestId);
      // A peer from before `stop` drops it when decoding, so it interrupts
      // the run instead, as this call did then.
      if (input.stop === true) {
        const commandId = stableCommandId({ scope, requestKey: key, operation: "thread-stop" });
        // The cause goes to the log; the caller learns only that the stop failed.
        const stopFailed = (error: unknown) =>
          Effect.logWarning("orchestrator-mcp.thread-stop-failed", {
            threadId: input.threadId,
            error,
          }).pipe(
            Effect.andThen(
              Effect.fail(
                failure("orchestration_error", `Unable to stop thread ${input.threadId}.`),
              ),
            ),
          );
        const stopped = yield* threadManagement
          .dispatch({
            type: "thread.stop",
            commandId,
            threadId: input.threadId,
            ...(input.reason === undefined ? {} : { reason: input.reason }),
          })
          .pipe(Effect.catch(stopFailed));
        // A retry with the same clientRequestId repeats only the stops that failed.
        yield* threadManagement
          .stopDelegatedTasks({ threadId: input.threadId, commandId, reason: input.reason })
          .pipe(Effect.catch(stopFailed));
        // The run this stop interrupted, from its own events, so a retry
        // reports the same run even if another has started since. Stop also
        // holds queued runs and marks runs it could not interrupt, with no
        // provider turn; neither is the run it interrupted.
        const interrupted = stopped.storedEvents.find(
          ({ event }) =>
            (event.type === "run.updated" && event.payload.status === "interrupted") ||
            (event.type === "turn-item.updated" &&
              event.payload.type === "run_interrupt_request" &&
              event.payload.providerTurnId !== null),
        )?.event.runId;
        return {
          threadId: input.threadId,
          runId: interrupted ?? null,
          status: interrupted === undefined ? "no_active_run" : "interrupt_requested",
        } satisfies OrchestratorMcpThreadInterruptResult;
      }
      const result = yield* threadManagement
        .interruptThread({
          projectId: target.thread.projectId,
          commandId: stableCommandId({
            scope,
            requestKey: key,
            operation: "thread-interrupt",
          }),
          threadId: input.threadId,
          ...(input.runId === undefined ? {} : { runId: input.runId }),
          reason: agentStopReason(input.reason),
        })
        .pipe(
          Effect.mapError((error) =>
            isThreadManagementError(error)
              ? threadManagementFailure(error)
              : failure(
                  "orchestration_error",
                  `Unable to interrupt thread ${input.threadId}: ${errorMessage(error)}`,
                ),
          ),
        );
      if (result.type === "no_active_run") {
        return {
          threadId: input.threadId,
          runId: null,
          status: "no_active_run",
        } satisfies OrchestratorMcpThreadInterruptResult;
      }
      return {
        threadId: input.threadId,
        runId: result.run.id,
        status: result.type === "already_terminal" ? result.run.status : "interrupt_requested",
      } satisfies OrchestratorMcpThreadInterruptResult;
    }),
  });
});

export const layer: Layer.Layer<
  OrchestratorMcpService,
  never,
  | Crypto.Crypto
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
