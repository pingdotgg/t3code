/**
 * Subagent status helpers shared by web and mobile, and the runtime shape the
 * web agent rows render.
 */
import { groupBy } from "effect/Array";
import * as DateTime from "effect/DateTime";
import type {
  OrchestrationV2Subagent,
  OrchestrationV2SubagentWorkflow,
  OrchestrationV2TurnItem,
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

// Optional-and-undefined, matching the contract's own optionals.
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
  /** The thread this agent owns, when it has one. */
  readonly childThreadId: string | null;
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

export function isLiveSubagentTurnItem(item: OrchestrationV2TurnItem): boolean {
  return item.type === "subagent" && isOrchestrationV2WorkActive(item.status);
}

/** A workflow coordinator with its members grouped by phase, as Lineage renders it. */
export interface SubagentWorkflowGroup {
  readonly workflow: RuntimeSubagent;
  readonly phases: ReadonlyArray<{
    readonly index: number;
    readonly title: string;
    readonly members: ReadonlyArray<RuntimeSubagent>;
    /** done = every member settled (success or error); running = any active. */
    readonly state: "pending" | "running" | "done";
    readonly settledCount: number;
  }>;
  /** Members with no resolvable phase (orphans render under the workflow). */
  readonly unphasedMembers: ReadonlyArray<RuntimeSubagent>;
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

function isoFromEpochMillis(value: number | undefined): string | null {
  return value === undefined ? null : DateTime.formatIso(DateTime.makeUnsafe(value));
}

/**
 * Expands a coordinator's workflow roster into member rows. Members are
 * synthesized from the coordinator's snapshot rather than read from their own
 * subagent entities, so a parent thread's Lineage can show them without
 * loading the coordinator's child thread; their identity is the coordinator id
 * plus the spawn ordinal.
 */
function workflowMembersToRuntime(
  coordinator: RuntimeSubagent,
  workflow: OrchestrationV2SubagentWorkflow,
): ReadonlyArray<RuntimeSubagent> {
  return workflow.agents.map((agent) => {
    // Every member state but queued is already a runtime status.
    const status =
      (agent.state === "queued" || agent.state === "running") &&
      isTerminalSubagentStatus(coordinator.status)
        ? coordinator.status
        : agent.state === "queued"
          ? "pending"
          : agent.state;
    const failed = status === "failed";
    const startedAt = isoFromEpochMillis(agent.startedAt);
    // The provider reports a settled member's duration, not its end instant.
    const completedAt = isTerminalSubagentStatus(status)
      ? agent.startedAt !== undefined && agent.durationMs !== undefined
        ? isoFromEpochMillis(agent.startedAt + agent.durationMs)
        : coordinator.completedAt
      : null;
    return {
      // Members share the run's handles: the transcript directory is what
      // makes their conversation readable, and only the run knows it.
      ...coordinator,
      id: `${coordinator.id}:agent:${agent.index}`,
      kind: "workflow_agent" as const,
      title: agent.label,
      model: agent.model ?? null,
      status,
      // A member the workflow retried counts each attempt as a run.
      activationCount: agent.attempt ?? 1,
      usage: workflowUsage(agent),
      // A member keeps its prompt on `progress` even once settled: that is the
      // question half of its conversation, and the detail view shows both halves.
      progress: agent.prompt ?? null,
      result: failed ? null : (agent.result ?? null),
      error: failed ? (agent.result ?? null) : null,
      parentAgentId: coordinator.id,
      agentIndex: agent.index,
      phaseIndex: agent.phaseIndex ?? null,
      phaseTitle: agent.phaseTitle ?? null,
      attempt: agent.attempt ?? null,
      phases: [],
      childThreadId: agent.childThreadId ?? null,
      recentActivity: [],
      firstSeenAt: isoFromEpochMillis(agent.queuedAt) ?? startedAt ?? coordinator.firstSeenAt,
      startedAt,
      completedAt,
      updatedAt: completedAt ?? startedAt ?? coordinator.firstSeenAt,
    } satisfies RuntimeSubagent;
  });
}

/**
 * Projects subagents and workflow members into the runtime roster.
 */
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
    const firstSeenAt = startedAt ?? updatedAt;
    const { workflow } = subagent;
    const runHandles = workflow?.runHandles ?? null;
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
      runHandles,
      childThreadId: subagent.childThreadId ?? null,
      recentActivity: [],
      firstSeenAt,
      startedAt,
      completedAt: subagent.completedAt === null ? null : DateTime.formatIso(subagent.completedAt),
      updatedAt,
    } satisfies RuntimeSubagent;
    return workflow === undefined
      ? [coordinator]
      : [coordinator, ...workflowMembersToRuntime(coordinator, workflow)];
  });
}

export function deriveWorkflowGroups(
  agents: ReadonlyArray<RuntimeSubagent>,
): ReadonlyArray<SubagentWorkflowGroup> {
  const workflows = agents
    .filter((agent) => agent.kind === "workflow")
    .sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt) || a.id.localeCompare(b.id));
  const members = groupBy(
    agents.filter((agent) => agent.kind !== "workflow" && agent.parentAgentId !== null),
    (agent) => agent.parentAgentId!,
  );

  return workflows.map((workflow) => {
    const workflowMembers = Object.hasOwn(members, workflow.id) ? members[workflow.id]! : [];
    // Union, not either/or: the declared plan lags the members, because the
    // provider only admits a phase once something in it starts. Members seed
    // the map; the declared titles then overwrite whatever they guessed.
    const phaseTitles = new Map<number, string>();
    for (const member of workflowMembers) {
      if (member.phaseIndex === null) continue;
      phaseTitles.set(
        member.phaseIndex,
        member.phaseTitle ?? phaseTitles.get(member.phaseIndex) ?? `Phase ${member.phaseIndex + 1}`,
      );
    }
    for (const phase of workflow.phases) phaseTitles.set(phase.index, phase.title);
    const knownPhases = Array.from(phaseTitles.entries())
      .map(([index, title]) => ({ index, title }))
      .sort((a, b) => a.index - b.index);

    const phases = knownPhases.map((phase) => {
      const phaseMembers = workflowMembers
        .filter((member) => member.phaseIndex === phase.index)
        .sort((a, b) => (a.agentIndex ?? 0) - (b.agentIndex ?? 0));
      const hasActiveMember = phaseMembers.some(
        // Idle members count as active for phase-liveness: a resumable Codex
        // member has not finished the phase.
        (member) => isActiveSubagentStatus(member.status) || member.status === "idle",
      );
      const settledCount = phaseMembers.filter((member) =>
        isTerminalSubagentStatus(member.status),
      ).length;
      const state: "pending" | "running" | "done" =
        phaseMembers.length === 0 ? "pending" : hasActiveMember ? "running" : "done";
      return {
        index: phase.index,
        title: phase.title,
        members: phaseMembers,
        state,
        settledCount,
      };
    });

    const unphasedMembers = workflowMembers
      .filter((member) => member.phaseIndex === null)
      .sort((a, b) => (a.agentIndex ?? 0) - (b.agentIndex ?? 0));

    return { workflow, phases, unphasedMembers };
  });
}
