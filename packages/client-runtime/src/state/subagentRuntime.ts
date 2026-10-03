/**
 * Subagent status helpers shared by web and mobile, and the runtime shape the
 * web agent rows render.
 */
import * as DateTime from "effect/DateTime";
import type { OrchestrationV2Subagent, OrchestrationV2SubagentWorkflow } from "@t3tools/contracts";

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

/**
 * Workflow rows share the coordinator and member roster.
 */
export interface AgentPanelWorkflowGroup {
  readonly workflow: RuntimeSubagent;
  readonly phases: ReadonlyArray<{
    readonly index: number;
    readonly title: string;
    readonly members: ReadonlyArray<RuntimeSubagent>;
    /** done = every member settled (success or error); running = any active. */
    readonly state: "pending" | "running" | "done";
    readonly activeCount: number;
    readonly settledCount: number;
  }>;
  /** Members with no resolvable phase (orphans render under the workflow). */
  readonly unphasedMembers: ReadonlyArray<RuntimeSubagent>;
}

export interface AgentPanelModel {
  readonly workflows: ReadonlyArray<AgentPanelWorkflowGroup>;
  readonly directAgents: ReadonlyArray<RuntimeSubagent>;
  readonly runningCount: number;
  readonly waitingCount: number;
  readonly idleCount: number;
  readonly settledCount: number;
  readonly totalTokens: number;
  readonly hasAgents: boolean;
  readonly liveCount: number;
}

const EMPTY_PANEL_MODEL: AgentPanelModel = {
  workflows: [],
  directAgents: [],
  runningCount: 0,
  waitingCount: 0,
  idleCount: 0,
  settledCount: 0,
  totalTokens: 0,
  hasAgents: false,
  liveCount: 0,
};

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
 * Expands a coordinator's nested workflow roster into member rows so the panel
 * renders one group per run. Members are synthesized rather than projected: the
 * provider reports them as a replaced snapshot with no durable entity of their
 * own, so their identity is the run id plus the spawn ordinal.
 */
function workflowMembersToRuntime(input: {
  readonly coordinatorId: string;
  readonly coordinatorStatus: RuntimeSubagent["status"];
  readonly coordinatorCompletedAt: string | null;
  readonly workflow: OrchestrationV2SubagentWorkflow;
  readonly runHandles: SubagentRunHandles | null;
  readonly fallbackSeenAt: string;
}): ReadonlyArray<RuntimeSubagent> {
  const workflowName = input.workflow.name ?? null;
  return input.workflow.agents.map((agent) => {
    // Every member state but queued is already a runtime status.
    const status =
      (agent.state === "queued" || agent.state === "running") &&
      isTerminalSubagentStatus(input.coordinatorStatus)
        ? input.coordinatorStatus
        : agent.state === "queued"
          ? "pending"
          : agent.state;
    const failed = status === "failed";
    const startedAt = isoFromEpochMillis(agent.startedAt);
    // The provider reports a settled member's duration, not its end instant.
    const completedAt = isTerminalSubagentStatus(status)
      ? agent.startedAt !== undefined && agent.durationMs !== undefined
        ? isoFromEpochMillis(agent.startedAt + agent.durationMs)
        : input.coordinatorCompletedAt
      : null;
    return {
      id: `${input.coordinatorId}:agent:${agent.index}`,
      kind: "workflow_agent" as const,
      title: agent.label,
      role: null,
      model: agent.model ?? null,
      effort: null,
      status,
      // Surfaces the panel's "run N" badge for a member the workflow retried.
      activationCount: agent.attempt ?? 1,
      usage: workflowUsage(agent),
      // A member keeps its prompt on `progress` even once settled: that is the
      // question half of its conversation, and the detail view shows both halves.
      progress: agent.prompt ?? null,
      lastToolName: null,
      result: failed ? null : (agent.result ?? null),
      error: failed ? (agent.result ?? null) : null,
      outputFile: null,
      parentAgentId: input.coordinatorId,
      agentIndex: agent.index,
      phaseIndex: agent.phaseIndex ?? null,
      phaseTitle: agent.phaseTitle ?? null,
      attempt: agent.attempt ?? null,
      workflowName,
      phases: [],
      // Members share the run's handles: the transcript directory is what
      // makes their conversation readable, and only the run knows it.
      runHandles: input.runHandles,
      childThreadId: agent.childThreadId ?? null,
      recentActivity: [],
      firstSeenAt: isoFromEpochMillis(agent.queuedAt) ?? startedAt ?? input.fallbackSeenAt,
      startedAt,
      completedAt,
      updatedAt: completedAt ?? startedAt ?? input.fallbackSeenAt,
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
      : [
          coordinator,
          ...workflowMembersToRuntime({
            coordinatorId: subagent.id,
            coordinatorStatus: coordinator.status,
            coordinatorCompletedAt: coordinator.completedAt,
            workflow,
            runHandles,
            fallbackSeenAt: firstSeenAt,
          }),
        ];
  });
}

/**
 * Source-neutral view model. When the orchestration-v2 subagent projection
 * exists for the thread, pass it as v2Projection and it wins outright — the
 * two sources are never merged (duplicate-agents failure mode). Until v2
 * lands, callers pass null and the native fold output is used.
 */
export function deriveAgentPanelModel({
  agents,
  v2Projection,
}: {
  readonly agents: ReadonlyArray<RuntimeSubagent>;
  readonly v2Projection?: ReadonlyArray<RuntimeSubagent> | null;
}): AgentPanelModel {
  const source = v2Projection ?? agents;
  if (source.length === 0) {
    return EMPTY_PANEL_MODEL;
  }

  const workflows = source
    .filter((agent) => agent.kind === "workflow")
    .slice()
    .sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt) || a.id.localeCompare(b.id));
  const workflowIds = new Set(workflows.map((workflow) => workflow.id));
  const members = new Map<string, RuntimeSubagent[]>();
  const direct: RuntimeSubagent[] = [];

  for (const agent of source) {
    if (agent.kind === "workflow") {
      continue;
    }
    if (agent.parentAgentId !== null && workflowIds.has(agent.parentAgentId)) {
      const list = members.get(agent.parentAgentId) ?? [];
      list.push(agent);
      members.set(agent.parentAgentId, list);
    } else {
      // Orphaned members (coordinator aged out) fall back to the direct list.
      direct.push(agent);
    }
  }

  const workflowGroups: AgentPanelWorkflowGroup[] = workflows.map((workflow) => {
    const workflowMembers = members.get(workflow.id) ?? [];
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

    const knownPhaseIndices = new Set(knownPhases.map((phase) => phase.index));
    const phases = knownPhases.map((phase) => {
      const phaseMembers = workflowMembers
        .filter((member) => member.phaseIndex === phase.index)
        .slice()
        .sort((a, b) => (a.agentIndex ?? 0) - (b.agentIndex ?? 0));
      const activeCount = phaseMembers.filter(
        // Idle members count as active for phase-liveness: a resumable Codex
        // member has not finished the phase.
        (member) => isActiveSubagentStatus(member.status) || member.status === "idle",
      ).length;
      const settledCount = phaseMembers.filter((member) =>
        isTerminalSubagentStatus(member.status),
      ).length;
      const state: "pending" | "running" | "done" =
        phaseMembers.length === 0
          ? "pending"
          : activeCount > 0
            ? "running"
            : settledCount === phaseMembers.length
              ? "done"
              : "pending";
      return {
        index: phase.index,
        title: phase.title,
        members: phaseMembers,
        state,
        activeCount,
        settledCount,
      };
    });

    // Unknown phase indices land here too — a member must never vanish just
    // because its phase row was lost (review finding).
    const unphasedMembers = workflowMembers
      .filter((member) => member.phaseIndex === null || !knownPhaseIndices.has(member.phaseIndex))
      .slice()
      .sort((a, b) => (a.agentIndex ?? 0) - (b.agentIndex ?? 0));

    return { workflow, phases, unphasedMembers };
  });

  let runningCount = 0;
  let waitingCount = 0;
  let idleCount = 0;
  let settledCount = 0;
  let totalTokens = 0;
  for (const agent of source) {
    // A workflow coordinator with members is a container for those members, not
    // work of its own: it reports running for the whole run and aggregates their
    // usage upstream in some providers. Counting it would report one more agent
    // working than there are, and double count tokens.
    if (agent.kind === "workflow" && (members.get(agent.id) ?? []).length > 0) continue;
    if (agent.status === "running" || agent.status === "pending") runningCount += 1;
    else if (agent.status === "waiting") waitingCount += 1;
    else if (agent.status === "idle") idleCount += 1;
    else settledCount += 1;
    totalTokens += agent.usage?.totalTokens ?? 0;
  }

  return {
    workflows: workflowGroups,
    // Updates and the >100-agent retention ranking must never reshuffle rows
    // that remain visible.
    directAgents: direct
      .slice()
      .sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt) || a.id.localeCompare(b.id)),
    runningCount,
    waitingCount,
    idleCount,
    settledCount,
    totalTokens,
    hasAgents: true,
    liveCount: runningCount + waitingCount,
  };
}
