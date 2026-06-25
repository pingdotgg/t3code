import type {
  EnvironmentId,
  MessageId,
  OrchestrationProjectShell,
  OrchestrationV2RunStatus,
  OrchestrationV2ShellSnapshot,
  OrchestrationV2ThreadProjection,
  OrchestrationV2ThreadShell,
  PlanId,
  ProjectId,
  ProviderInstanceId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";

export interface EnvironmentProject extends OrchestrationProjectShell {
  readonly environmentId: EnvironmentId;
}

/**
 * A pristine V2 thread projection paired with the environment that produced it.
 *
 * The projection stays nested so the server projection and all structurally
 * shared collections retain their identities. Rich consumers read V2 state
 * directly instead of a second presentation-shaped thread graph.
 */
export interface EnvironmentThread {
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
    status === "preparing" ||
    status === "queued" ||
    status === "starting" ||
    status === "running" ||
    status === "waiting"
  );
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

function shellRuntime(thread: OrchestrationV2ThreadShell): ThreadRuntimeSummary | null {
  if (thread.latestRunId === null && thread.activeProviderThreadId === null) return null;
  return {
    status: thread.status,
    activeRunId: thread.activeRunId,
    providerInstanceId: thread.providerInstanceId,
    providerName: null,
    lastError: null,
    updatedAt: iso(thread.updatedAt),
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
    runtime: shellRuntime(thread),
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

export function selectEnvironmentThreadShell(
  snapshot: OrchestrationV2ShellSnapshot | null,
  environmentId: EnvironmentId,
  threadId: ThreadId,
): EnvironmentThreadShell | null {
  const thread = snapshot?.threads.find((candidate) => candidate.id === threadId) ?? null;
  return thread ? presentThreadShell(environmentId, thread) : null;
}
