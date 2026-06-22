import type {
  ChatAttachment,
  CheckpointId,
  CheckpointRef,
  CheckpointScopeId,
  EnvironmentId,
  MessageId,
  OrchestrationProjectShell,
  OrchestrationV2PlanArtifact,
  OrchestrationV2ProviderCapabilities,
  OrchestrationV2RunStatus,
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadShell,
  OrchestrationV2TurnItem,
  PlanId,
  ProjectId,
  ProviderApprovalDecision,
  ProviderInstanceId,
  ProviderRequestKind,
  RunId,
  RuntimeRequestId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export interface EnvironmentProject extends OrchestrationProjectShell {
  readonly environmentId: EnvironmentId;
}

/**
 * A pristine V2 thread projection paired with the environment that produced it.
 *
 * Keep the projection nested so its identity and every structurally shared
 * collection remain intact. This is the scoped detail boundary for rich V2
 * consumers; it is intentionally not another presentation-shaped thread.
 */
export interface ScopedThreadProjection {
  readonly environmentId: EnvironmentId;
  readonly projection: OrchestrationV2ThreadProjection;
}

export interface ThreadRunSummary {
  readonly runId: RunId;
  readonly status: OrchestrationV2RunStatus;
  readonly requestedAt: string | null;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly assistantMessageId: MessageId | null;
  readonly sourcePlanRef?: {
    readonly threadId: ThreadId;
    readonly planId: PlanId;
  };
}

export interface ThreadRuntimeSummary {
  readonly status: OrchestrationV2RunStatus | "idle";
  readonly activeRunId: RunId | null;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerName: string | null;
  readonly lastError: string | null;
  readonly updatedAt: string;
}

export function threadRuntimeIsActive(runtime: ThreadRuntimeSummary | null | undefined): boolean {
  return runtime !== null && runtime !== undefined && threadRunStatusIsActive(runtime.status);
}

export function threadRunStatusIsActive(status: ThreadRuntimeSummary["status"]): boolean {
  return (
    status === "queued" || status === "starting" || status === "running" || status === "waiting"
  );
}

export interface ThreadConversationMessage {
  readonly id: MessageId;
  readonly role: "user" | "assistant" | "system";
  readonly text: string;
  readonly attachments?: ReadonlyArray<ChatAttachment>;
  readonly runId: RunId | null;
  readonly streaming: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ThreadProposedPlan {
  readonly id: PlanId;
  readonly runId: RunId | null;
  readonly planMarkdown: string;
  readonly status: OrchestrationV2PlanArtifact["status"];
  readonly implementedAt: string | null;
  readonly implementationThreadId: ThreadId | null;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface ThreadTodoPlan {
  readonly id: PlanId;
  readonly runId: RunId | null;
  readonly status: OrchestrationV2PlanArtifact["status"];
  readonly explanation: string | null;
  readonly steps: ReadonlyArray<{
    readonly id: string;
    readonly step: string;
    readonly status: "pending" | "inProgress" | "completed";
  }>;
  readonly updatedAt: string;
}

export interface ThreadCheckpointSummary {
  readonly checkpointId?: CheckpointId;
  readonly scopeId?: CheckpointScopeId;
  readonly runId: RunId;
  readonly checkpointTurnCount: number;
  readonly checkpointRef: CheckpointRef;
  readonly status: "ready" | "missing" | "error" | "stale";
  readonly files: ReadonlyArray<{
    readonly path: string;
    readonly kind: string;
    readonly additions: number;
    readonly deletions: number;
  }>;
  readonly assistantMessageId: MessageId | null;
  readonly completedAt: string;
}

export interface ThreadPendingApproval {
  readonly requestId: RuntimeRequestId;
  readonly requestKind: ProviderRequestKind;
  readonly createdAt: string;
  readonly detail?: string;
  readonly responseCapability: "live" | "not_resumable";
}

export interface ThreadUserInputQuestion {
  readonly id: string;
  readonly header: string;
  readonly question: string;
  readonly options: ReadonlyArray<{
    readonly label: string;
    readonly description: string;
  }>;
  readonly multiSelect: boolean;
}

export interface ThreadPendingUserInput {
  readonly requestId: RuntimeRequestId;
  readonly createdAt: string;
  readonly questions: ReadonlyArray<ThreadUserInputQuestion>;
  readonly responseCapability: "live" | "not_resumable";
}

export type ThreadWorkEntryTone = "thinking" | "tool" | "info" | "error";
export type ThreadWorkEntryStatus = "inProgress" | "completed" | "failed" | "declined" | "stopped";

/**
 * Stable parity presentation for a V2 turn item. `structuredPayload` always
 * retains the complete source item so generic rendering never loses provider
 * or tool data.
 */
export interface ThreadWorkEntry {
  readonly id: string;
  readonly createdAt: string;
  readonly runId: RunId | null;
  readonly label: string;
  readonly detail?: string;
  readonly command?: string;
  readonly rawCommand?: string;
  readonly changedFiles?: ReadonlyArray<string>;
  readonly tone: ThreadWorkEntryTone;
  readonly toolTitle?: string;
  readonly toolData?: unknown;
  readonly itemType: OrchestrationV2TurnItem["type"];
  readonly requestKind?: ProviderRequestKind;
  readonly toolLifecycleStatus: ThreadWorkEntryStatus;
  readonly structuredPayload: OrchestrationV2TurnItem;
}

export interface EnvironmentThreadShell {
  readonly environmentId: EnvironmentId;
  readonly id: ThreadId;
  readonly projectId: ProjectId;
  readonly title: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly modelSelection: OrchestrationV2ThreadShell["modelSelection"];
  readonly runtimeMode: OrchestrationV2ThreadShell["runtimeMode"];
  readonly interactionMode: OrchestrationV2ThreadShell["interactionMode"];
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly lineage: OrchestrationV2ThreadShell["lineage"];
  readonly forkedFrom: OrchestrationV2ThreadShell["forkedFrom"];
  readonly activeProviderThreadId: OrchestrationV2ThreadShell["activeProviderThreadId"];
  readonly latestRun: ThreadRunSummary | null;
  readonly runtime: ThreadRuntimeSummary | null;
  readonly latestUserMessageAt: string | null;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly hasActionableProposedPlan: boolean;
  readonly itemCount: number;
  readonly visibleItemCount: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly archivedAt: string | null;
  readonly deletedAt: string | null;
  readonly source: OrchestrationV2ThreadShell;
}

export interface EnvironmentThread extends EnvironmentThreadShell {
  readonly projection: OrchestrationV2ThreadProjection;
  readonly runs: ReadonlyArray<ThreadRunSummary>;
  readonly capabilities: OrchestrationV2ProviderCapabilities | null;
  readonly availableActions: {
    readonly canSendMessage: boolean;
    readonly canInterrupt: boolean;
    readonly canRespondToApproval: boolean;
    readonly canRespondToUserInput: boolean;
    readonly canRollback: boolean;
    readonly canArchive: boolean;
    readonly canUnarchive: boolean;
    readonly canDelete: boolean;
    readonly canUpdateSettings: boolean;
  };
  readonly messages: ReadonlyArray<ThreadConversationMessage>;
  readonly workEntries: ReadonlyArray<ThreadWorkEntry>;
  readonly proposedPlans: ReadonlyArray<ThreadProposedPlan>;
  readonly todoPlans: ReadonlyArray<ThreadTodoPlan>;
  readonly pendingApprovals: ReadonlyArray<ThreadPendingApproval>;
  readonly pendingUserInputs: ReadonlyArray<ThreadPendingUserInput>;
  readonly checkpoints: ReadonlyArray<ThreadCheckpointSummary>;
}

function iso(value: DateTime.Utc): string {
  return DateTime.formatIso(value);
}

function nullableIso(value: DateTime.Utc | null): string | null {
  return value === null ? null : iso(value);
}

function terminalRunStatus(status: OrchestrationV2RunStatus): boolean {
  return (
    status === "completed" ||
    status === "interrupted" ||
    status === "failed" ||
    status === "cancelled" ||
    status === "rolled_back"
  );
}

function workEntryStatus(item: OrchestrationV2TurnItem): ThreadWorkEntryStatus {
  switch (item.status) {
    case "pending":
    case "running":
    case "waiting":
      return "inProgress";
    case "completed":
      return "completed";
    case "failed":
      return "failed";
    case "cancelled":
    case "interrupted":
      return "stopped";
  }
}

function workEntryTone(item: OrchestrationV2TurnItem): ThreadWorkEntryTone {
  if (item.status === "failed") return "error";
  if (item.type === "reasoning") return "thinking";
  switch (item.type) {
    case "command_execution":
    case "file_change":
    case "file_search":
    case "web_search":
    case "dynamic_tool":
    case "subagent":
      return "tool";
    default:
      return "info";
  }
}

function summarizeWorkItem(item: OrchestrationV2TurnItem): {
  readonly label: string;
  readonly detail?: string;
  readonly command?: string;
  readonly rawCommand?: string;
  readonly changedFiles?: ReadonlyArray<string>;
  readonly toolTitle?: string;
  readonly toolData?: unknown;
  readonly requestKind?: ProviderRequestKind;
} {
  const title = item.title?.trim() || null;
  switch (item.type) {
    case "reasoning":
      return { label: title ?? "Thinking", ...(item.text ? { detail: item.text } : {}) };
    case "command_execution":
      return {
        label: title ?? "Ran command",
        command: item.input,
        rawCommand: item.input,
        ...(item.output ? { detail: item.output } : {}),
        toolTitle: title ?? "Command",
        toolData: item,
      };
    case "file_change":
      return {
        label: title ?? `Changed ${item.fileName}`,
        changedFiles: [item.fileName],
        ...(item.diffStr ? { detail: item.diffStr } : {}),
        toolTitle: title ?? "File change",
        toolData: item,
      };
    case "file_search":
      return {
        label: title ?? "Searched files",
        ...(item.pattern ? { detail: item.pattern } : {}),
        toolTitle: title ?? "File search",
        toolData: item,
      };
    case "web_search":
      return {
        label: title ?? "Searched the web",
        ...(item.patterns?.length ? { detail: item.patterns.join(", ") } : {}),
        toolTitle: title ?? "Web search",
        toolData: item,
      };
    case "approval_request":
      return {
        label: title ?? "Approval requested",
        ...(item.prompt ? { detail: item.prompt } : {}),
        requestKind: item.requestKind,
        toolData: item,
      };
    case "user_input_request":
      return {
        label: title ?? "Input requested",
        detail: item.questions.map((question) => question.question).join("\n"),
        toolData: item,
      };
    case "checkpoint":
      return {
        label: title ?? "Checkpoint captured",
        changedFiles: item.files.map((file) => file.path),
        toolData: item,
      };
    case "run_interrupt_request":
      return { label: title ?? "Interrupt requested", detail: item.message, toolData: item };
    case "run_interrupt_result":
      return { label: title ?? "Run interrupted", detail: item.message, toolData: item };
    case "compaction":
      return {
        label: title ?? "Context compacted",
        ...(item.summary ? { detail: item.summary } : {}),
        toolData: item,
      };
    case "handoff":
      return {
        label: title ?? "Context handed off",
        ...(item.summary ? { detail: item.summary } : {}),
        toolData: item,
      };
    case "fork":
      return { label: title ?? "Thread forked", detail: item.targetThreadId, toolData: item };
    case "subagent":
      return {
        label: title ?? "Subagent",
        detail: item.result ?? item.prompt,
        toolTitle: title ?? "Subagent",
        toolData: item,
      };
    case "dynamic_tool":
      return {
        label: title ?? item.toolName ?? "Tool call",
        toolTitle: title ?? item.toolName ?? "Tool",
        toolData: { input: item.input, output: item.output },
      };
    case "user_message":
      return { label: title ?? "User message", detail: item.text, toolData: item };
    case "assistant_message":
      return { label: title ?? "Assistant message", detail: item.text, toolData: item };
    case "proposed_plan":
      return { label: title ?? "Proposed plan", detail: item.markdown, toolData: item };
    case "todo_list":
      return {
        label: title ?? "Plan updated",
        detail: item.steps.map((step) => step.text).join("\n"),
        toolData: item,
      };
  }
}

function presentWorkEntries(
  projection: OrchestrationV2ThreadProjection,
): ReadonlyArray<ThreadWorkEntry> {
  return projection.visibleTurnItems
    .filter(
      ({ item }) =>
        item.type !== "user_message" &&
        item.type !== "assistant_message" &&
        item.type !== "proposed_plan" &&
        item.type !== "todo_list",
    )
    .map(({ item }) => {
      const summary = summarizeWorkItem(item);
      return {
        id: item.id,
        createdAt: iso(item.startedAt ?? item.updatedAt),
        runId: item.runId,
        ...summary,
        tone: workEntryTone(item),
        itemType: item.type,
        toolLifecycleStatus: workEntryStatus(item),
        structuredPayload: item,
      } satisfies ThreadWorkEntry;
    });
}

function presentRuns(projection: OrchestrationV2ThreadProjection): ReadonlyArray<ThreadRunSummary> {
  return projection.runs
    .toSorted((left, right) => left.ordinal - right.ordinal)
    .map((run) => ({
      runId: run.id,
      status: run.status,
      requestedAt: iso(run.requestedAt),
      startedAt: nullableIso(run.startedAt),
      completedAt: nullableIso(run.completedAt),
      assistantMessageId:
        projection.messages.findLast(
          (message) => message.runId === run.id && message.role === "assistant",
        )?.id ?? null,
      ...(run.sourcePlanRef === undefined ? {} : { sourcePlanRef: run.sourcePlanRef }),
    }));
}

function presentLatestRun(projection: OrchestrationV2ThreadProjection): ThreadRunSummary | null {
  return presentRuns(projection).at(-1) ?? null;
}

function presentRuntime(
  shell: OrchestrationV2ThreadShell,
  projection?: OrchestrationV2ThreadProjection,
): ThreadRuntimeSummary | null {
  const latestRun = projection === undefined ? null : presentLatestRun(projection);
  const hasRuntime = shell.latestRunId !== null || shell.activeProviderThreadId !== null;
  if (!hasRuntime && latestRun === null) return null;
  const providerSession = projection?.providerSessions.findLast(
    (session) => session.providerInstanceId === shell.providerInstanceId,
  );
  return {
    status: latestRun?.status ?? shell.status,
    activeRunId: shell.activeRunId,
    providerInstanceId: shell.providerInstanceId,
    providerName: providerSession?.driver ?? null,
    lastError: providerSession?.lastError ?? null,
    updatedAt: iso(projection?.updatedAt ?? shell.updatedAt),
  };
}

export function scopeProject(
  environmentId: EnvironmentId,
  project: OrchestrationProjectShell,
): EnvironmentProject {
  return { ...project, environmentId };
}

export function presentThreadShell(
  environmentId: EnvironmentId,
  thread: OrchestrationV2ThreadShell,
): EnvironmentThreadShell {
  const updatedAt = iso(thread.updatedAt);
  const latestRun =
    thread.latestRunId === null
      ? null
      : ({
          runId: thread.latestRunId,
          status: thread.status === "idle" ? "completed" : thread.status,
          requestedAt: null,
          startedAt: null,
          completedAt:
            thread.status === "idle" || terminalRunStatus(thread.status) ? updatedAt : null,
          assistantMessageId: null,
        } satisfies ThreadRunSummary);
  return {
    environmentId,
    id: thread.id,
    projectId: thread.projectId,
    title: thread.title,
    providerInstanceId: thread.providerInstanceId,
    modelSelection: thread.modelSelection,
    runtimeMode: thread.runtimeMode,
    interactionMode: thread.interactionMode,
    branch: thread.branch,
    worktreePath: thread.worktreePath,
    lineage: thread.lineage,
    forkedFrom: thread.forkedFrom,
    activeProviderThreadId: thread.activeProviderThreadId,
    latestRun,
    runtime: presentRuntime(thread),
    latestUserMessageAt: nullableIso(thread.latestUserMessageAt),
    hasPendingApprovals:
      thread.pendingRuntimeRequest !== null &&
      thread.pendingRuntimeRequest.kind !== "user_input" &&
      thread.pendingRuntimeRequest.kind !== "auth_refresh",
    hasPendingUserInput: thread.pendingRuntimeRequest?.kind === "user_input",
    hasActionableProposedPlan: thread.hasActionableProposedPlan,
    itemCount: thread.itemCount,
    visibleItemCount: thread.visibleItemCount,
    createdAt: iso(thread.createdAt),
    updatedAt,
    archivedAt: nullableIso(thread.archivedAt),
    deletedAt: nullableIso(thread.deletedAt),
    source: thread,
  };
}

export const scopeThreadShell = presentThreadShell;

function presentMessages(
  projection: OrchestrationV2ThreadProjection,
): ReadonlyArray<ThreadConversationMessage> {
  return projection.messages.map((message) => ({
    id: message.id,
    role: message.role,
    text: message.text,
    attachments: message.attachments,
    runId: message.runId,
    streaming: message.streaming,
    createdAt: iso(message.createdAt),
    updatedAt: iso(message.updatedAt),
  }));
}

function planItemTime(projection: OrchestrationV2ThreadProjection, planId: PlanId): string {
  const item = projection.turnItems.findLast(
    (candidate) =>
      (candidate.type === "proposed_plan" || candidate.type === "todo_list") &&
      candidate.planId === planId,
  );
  return iso(item?.updatedAt ?? projection.updatedAt);
}

function presentProposedPlans(
  projection: OrchestrationV2ThreadProjection,
): ReadonlyArray<ThreadProposedPlan> {
  return projection.plans.flatMap((plan) => {
    if (plan.kind !== "proposed_plan") return [];
    const updatedAt = planItemTime(projection, plan.id);
    return [
      {
        id: plan.id,
        runId: plan.runId,
        planMarkdown: plan.markdown,
        status: plan.status,
        implementedAt: plan.status === "completed" ? updatedAt : null,
        implementationThreadId: null,
        createdAt: updatedAt,
        updatedAt,
      } satisfies ThreadProposedPlan,
    ];
  });
}

function presentTodoPlans(
  projection: OrchestrationV2ThreadProjection,
): ReadonlyArray<ThreadTodoPlan> {
  return projection.plans.flatMap((plan) => {
    if (plan.kind !== "todo_list") return [];
    return [
      {
        id: plan.id,
        runId: plan.runId,
        status: plan.status,
        explanation: plan.explanation ?? null,
        steps: plan.steps.map((step) => ({
          id: step.id,
          step: step.text,
          status: step.status === "running" ? "inProgress" : step.status,
        })),
        updatedAt: planItemTime(projection, plan.id),
      } satisfies ThreadTodoPlan,
    ];
  });
}

function presentPendingRequests(projection: OrchestrationV2ThreadProjection): {
  readonly approvals: ReadonlyArray<ThreadPendingApproval>;
  readonly userInputs: ReadonlyArray<ThreadPendingUserInput>;
} {
  const approvals: ThreadPendingApproval[] = [];
  const userInputs: ThreadPendingUserInput[] = [];
  for (const request of projection.runtimeRequests) {
    if (request.status !== "pending") continue;
    const responseCapability = request.responseCapability.type;
    if (request.kind === "user_input") {
      const item = projection.turnItems.findLast(
        (candidate) =>
          candidate.type === "user_input_request" && candidate.requestId === request.id,
      );
      if (item === undefined || item.type !== "user_input_request") continue;
      userInputs.push({
        requestId: request.id,
        createdAt: iso(request.createdAt),
        questions: item.questions.map((question) => ({ ...question, multiSelect: false })),
        responseCapability,
      });
      continue;
    }
    if (request.kind === "auth_refresh" || request.kind === "dynamic_tool_call") continue;
    const item = projection.turnItems.findLast(
      (candidate) => candidate.type === "approval_request" && candidate.requestId === request.id,
    );
    approvals.push({
      requestId: request.id,
      requestKind: request.kind,
      createdAt: iso(request.createdAt),
      ...(item?.type === "approval_request" && item.prompt ? { detail: item.prompt } : {}),
      responseCapability,
    });
  }
  return { approvals, userInputs };
}

function presentCheckpoints(
  projection: OrchestrationV2ThreadProjection,
): ReadonlyArray<ThreadCheckpointSummary> {
  return projection.checkpoints.flatMap((checkpoint) => {
    if (checkpoint.appRunOrdinal === null || checkpoint.runId === null) return [];
    const assistantMessageId =
      projection.messages.findLast(
        (message) => message.runId === checkpoint.runId && message.role === "assistant",
      )?.id ?? null;
    return [
      {
        checkpointId: checkpoint.id,
        scopeId: checkpoint.scopeId,
        runId: checkpoint.runId,
        checkpointTurnCount: checkpoint.appRunOrdinal,
        checkpointRef: checkpoint.ref,
        status: checkpoint.status,
        files: checkpoint.files,
        assistantMessageId,
        completedAt: iso(checkpoint.capturedAt),
      } satisfies ThreadCheckpointSummary,
    ];
  });
}

export function presentThread(
  environmentId: EnvironmentId,
  projection: OrchestrationV2ThreadProjection,
): EnvironmentThread {
  const shell = presentThreadShell(environmentId, {
    ...projection.thread,
    latestRunId:
      projection.runs.reduce<(typeof projection.runs)[number] | null>(
        (latest, candidate) =>
          latest === null || candidate.ordinal > latest.ordinal ? candidate : latest,
        null,
      )?.id ?? null,
    activeRunId:
      projection.runs.findLast(
        (run) => run.status === "starting" || run.status === "running" || run.status === "waiting",
      )?.id ?? null,
    status: presentLatestRun(projection)?.status ?? "idle",
    pendingRuntimeRequest:
      projection.runtimeRequests.findLast((request) => request.status === "pending") ?? null,
    latestVisibleMessage:
      projection.messages.length === 0
        ? null
        : (() => {
            const message = projection.messages.at(-1)!;
            return {
              id: message.id,
              role: message.role,
              text: message.text,
              updatedAt: message.updatedAt,
            };
          })(),
    latestUserMessageAt:
      projection.messages.findLast((message) => message.role === "user")?.updatedAt ?? null,
    hasActionableProposedPlan: projection.plans.some(
      (plan) => plan.kind === "proposed_plan" && plan.status === "active",
    ),
    itemCount: projection.turnItems.length,
    visibleItemCount: projection.visibleTurnItems.length,
  });
  const requests = presentPendingRequests(projection);
  const proposedPlans = presentProposedPlans(projection);
  const checkpoints = presentCheckpoints(projection);
  const runs = presentRuns(projection);
  const capabilities =
    projection.providerSessions.findLast(
      (session) => session.providerInstanceId === projection.thread.providerInstanceId,
    )?.capabilities ?? null;
  const active = runs.some((run) => threadRunStatusIsActive(run.status));
  const mutable = projection.thread.archivedAt === null && projection.thread.deletedAt === null;
  return {
    ...shell,
    latestRun: presentLatestRun(projection),
    runtime: presentRuntime(shell.source, projection),
    hasPendingApprovals: requests.approvals.length > 0,
    hasPendingUserInput: requests.userInputs.length > 0,
    hasActionableProposedPlan: proposedPlans.some((plan) => plan.status === "active"),
    projection,
    runs,
    capabilities,
    availableActions: {
      canSendMessage: mutable,
      canInterrupt: mutable && active && (capabilities?.turns.supportsInterrupt ?? true),
      canRespondToApproval: requests.approvals.some(
        (request) => request.responseCapability === "live",
      ),
      canRespondToUserInput: requests.userInputs.some(
        (request) => request.responseCapability === "live",
      ),
      canRollback: mutable && checkpoints.some((checkpoint) => checkpoint.status === "ready"),
      canArchive: projection.thread.archivedAt === null && projection.thread.deletedAt === null,
      canUnarchive: projection.thread.archivedAt !== null && projection.thread.deletedAt === null,
      canDelete: projection.thread.deletedAt === null,
      canUpdateSettings: mutable,
    },
    messages: presentMessages(projection),
    workEntries: presentWorkEntries(projection),
    proposedPlans,
    todoPlans: presentTodoPlans(projection),
    pendingApprovals: requests.approvals,
    pendingUserInputs: requests.userInputs,
    checkpoints,
  };
}

export function selectEnvironmentThreadShell(
  snapshot: OrchestrationV2ShellSnapshot | null,
  environmentId: EnvironmentId,
  threadId: ThreadId,
): EnvironmentThreadShell | null {
  const thread = snapshot?.threads.find((candidate) => candidate.id === threadId) ?? null;
  return thread ? presentThreadShell(environmentId, thread) : null;
}

export function providerApprovalDecisionIsFinal(_decision: ProviderApprovalDecision): boolean {
  return true;
}
