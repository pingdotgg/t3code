/**
 * Subagent status helpers shared by web and mobile, and the runtime shape the
 * web agent rows render.
 */
import * as DateTime from "effect/DateTime";
import type {
  OrchestrationV2Subagent,
  OrchestrationV2SubagentWorkflow,
  OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import { isOrchestrationV2WorkActive } from "@t3tools/contracts";

export type RuntimeSubagentStatus =
  | "pending"
  | "running"
  | "waiting"
  | "idle"
  | "completed"
  | "failed"
  | "cancelled"
  | "interrupted";

export interface SubagentUsage {
  readonly totalTokens: number;
  readonly inputTokens?: number;
  readonly cachedInputTokens?: number;
  readonly outputTokens?: number;
  readonly reasoningOutputTokens?: number;
  readonly toolUses?: number;
  readonly durationMs?: number;
}

export interface SubagentActivityEntry {
  readonly at: string;
  readonly summary: string;
}

export interface SubagentWorkflowPhase {
  readonly index: number;
  readonly title: string;
}

export interface SubagentRunHandles {
  readonly runId?: string | undefined;
  readonly scriptPath?: string | undefined;
  readonly transcriptDir?: string | undefined;
  readonly sessionUrl?: string | undefined;
}

export interface RuntimeSubagent {
  readonly id: string;
  readonly kind: "subagent" | "subagent_batch" | "workflow" | "workflow_agent";
  readonly title: string;
  readonly role: string | null;
  readonly model: string | null;
  readonly effort: string | null;
  readonly status: RuntimeSubagentStatus;
  readonly activationCount: number;
  readonly usage: SubagentUsage | null;
  readonly progress: string | null;
  readonly lastToolName: string | null;
  readonly result: string | null;
  readonly error: string | null;
  readonly outputFile: string | null;
  readonly parentAgentId: string | null;
  readonly agentIndex: number | null;
  readonly phaseIndex: number | null;
  readonly phaseTitle: string | null;
  readonly attempt: number | null;
  readonly workflowName: string | null;
  readonly phases: ReadonlyArray<SubagentWorkflowPhase>;
  readonly runHandles: SubagentRunHandles | null;
  readonly childThreadId?: string | null;
  readonly recentActivity: ReadonlyArray<SubagentActivityEntry>;
  /** First retained observation, used as the roster's stable display order. */
  readonly firstSeenAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly updatedAt: string;
}

const TERMINAL_STATUSES: ReadonlySet<RuntimeSubagentStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

export function isTerminalSubagentStatus(status: RuntimeSubagentStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** Active = the user may still need to care while it runs. Idle is settled-ish
 * but resumable; waiting counts as active because it needs the user. */
export function isActiveSubagentStatus(status: RuntimeSubagentStatus): boolean {
  return isOrchestrationV2WorkActive(status);
}

function workflowUsage(source: {
  readonly totalTokens?: number | undefined;
  readonly toolCalls?: number | undefined;
  readonly durationMs?: number | undefined;
}): SubagentUsage | null {
  if (source.totalTokens === undefined) return null;
  return {
    totalTokens: source.totalTokens,
    ...(source.toolCalls === undefined ? {} : { toolUses: source.toolCalls }),
    ...(source.durationMs === undefined ? {} : { durationMs: source.durationMs }),
  };
}

function workflowMemberRows(
  coordinator: RuntimeSubagent,
  workflow: OrchestrationV2SubagentWorkflow,
): ReadonlyArray<RuntimeSubagent> {
  const iso = (value: number | undefined) =>
    value === undefined || value > 8.64e15 ? null : DateTime.formatIso(DateTime.makeUnsafe(value));
  return workflow.agents.map((member) => {
    const status =
      (member.state === "queued" || member.state === "running") &&
      isTerminalSubagentStatus(coordinator.status)
        ? coordinator.status
        : member.state === "queued"
          ? "pending"
          : member.state;
    const startedAt = iso(member.startedAt);
    const completedAt = isTerminalSubagentStatus(status)
      ? ((member.startedAt !== undefined && member.durationMs !== undefined
          ? iso(member.startedAt + member.durationMs)
          : null) ??
        (member.state === "queued" || member.state === "running" ? coordinator.completedAt : null))
      : null;
    return {
      ...coordinator,
      id: `${coordinator.id}:agent:${member.index}`,
      kind: "workflow_agent",
      title: member.label,
      model: member.model ?? null,
      status,
      activationCount: member.attempt ?? 1,
      usage: workflowUsage(member),
      progress: member.prompt ?? null,
      lastToolName: member.lastToolName ?? null,
      result: member.result ?? null,
      error: status === "failed" ? (member.result ?? null) : null,
      parentAgentId: coordinator.id,
      agentIndex: member.index,
      phaseIndex: member.phaseIndex ?? null,
      phaseTitle: member.phaseTitle ?? null,
      attempt: member.attempt ?? null,
      phases: [],
      childThreadId: member.childThreadId ?? null,
      firstSeenAt: iso(member.queuedAt) ?? startedAt ?? coordinator.firstSeenAt,
      startedAt,
      completedAt,
    } satisfies RuntimeSubagent;
  });
}

/** Projects ordinary subagents and expands each workflow coordinator's retained roster. */
export function projectedSubagentsToRuntime(
  subagents: ReadonlyArray<{
    readonly id: string;
    readonly title: string | null;
    readonly prompt: string;
    readonly model: string | null;
    readonly status: OrchestrationV2Subagent["status"];
    readonly progress?: string | undefined;
    readonly childThreadId?: string | null | undefined;
    readonly workflow?: OrchestrationV2SubagentWorkflow | undefined;
    readonly result: string | null;
    readonly startedAt: DateTime.Utc | null;
    readonly completedAt: DateTime.Utc | null;
    readonly updatedAt: DateTime.Utc;
  }>,
): ReadonlyArray<RuntimeSubagent> {
  return subagents.flatMap((subagent) => {
    const updatedAt = DateTime.formatIso(subagent.updatedAt);
    const startedAt = subagent.startedAt === null ? null : DateTime.formatIso(subagent.startedAt);
    const { workflow } = subagent;
    const coordinator = {
      id: subagent.id,
      kind: workflow === undefined ? "subagent" : "workflow",
      title:
        subagent.title ??
        (subagent.prompt.length > 80 ? `${subagent.prompt.slice(0, 77)}...` : subagent.prompt),
      role: null,
      model: subagent.model,
      effort: null,
      status: subagent.status,
      activationCount: 1,
      usage: workflow === undefined ? null : workflowUsage(workflow),
      progress: subagent.progress ?? null,
      lastToolName: null,
      result: subagent.result,
      error: subagent.status === "failed" ? (subagent.result ?? null) : null,
      outputFile: null,
      parentAgentId: null,
      agentIndex: null,
      phaseIndex: null,
      phaseTitle: null,
      attempt: null,
      workflowName: workflow?.name ?? null,
      phases: workflow?.phases ?? [],
      runHandles: workflow?.runHandles ?? null,
      childThreadId: subagent.childThreadId ?? null,
      recentActivity: [],
      firstSeenAt: startedAt ?? updatedAt,
      startedAt,
      completedAt: subagent.completedAt === null ? null : DateTime.formatIso(subagent.completedAt),
      updatedAt,
    } satisfies RuntimeSubagent;
    return workflow === undefined
      ? [coordinator]
      : [coordinator, ...workflowMemberRows(coordinator, workflow)];
  });
}

/**
 * A delegated task settles with its first run, but the parent can keep sending
 * the child follow-ups. While the child thread has a live run, the row's timer
 * and hover card follow that run instead of the settled task.
 */
export function liveSubagent<Agent extends RuntimeSubagent>(
  agent: Agent | undefined,
  childThread: OrchestrationV2ThreadShell | null | undefined,
): Agent | undefined {
  const liveStatus = childThread?.activityRunStatus;
  if (!agent || !liveStatus) return agent;
  const startedAt = childThread.activityRunStartedAt;
  return {
    ...agent,
    status: liveStatus === "running" || liveStatus === "waiting" ? liveStatus : "pending",
    startedAt: startedAt ? DateTime.formatIso(startedAt) : null,
    completedAt: null,
    // The settled task's output belongs to its first run, not this one.
    progress: null,
    result: null,
    error: null,
  };
}
