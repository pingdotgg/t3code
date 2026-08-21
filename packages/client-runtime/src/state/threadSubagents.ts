import * as DateTime from "effect/DateTime";
import type {
  OrchestrationV2Subagent,
  OrchestrationV2SubagentUsage,
  OrchestrationV2WorkflowPhase,
} from "@t3tools/contracts";

export type AgentPanelSubagentStatus = OrchestrationV2Subagent["status"];

export interface AgentPanelRunHandles {
  readonly runId?: string;
  readonly scriptPath?: string;
  readonly transcriptDir?: string;
  readonly sessionUrl?: string;
}

/** The V2 subagent fields used by the web presentation layer. */
export interface AgentPanelSubagent {
  readonly id: string;
  readonly kind: OrchestrationV2Subagent["kind"];
  readonly title: string;
  readonly role: string;
  readonly model: string | null;
  readonly status: AgentPanelSubagentStatus;
  readonly activationCount: number;
  readonly usage: OrchestrationV2SubagentUsage | null;
  readonly progress: string | null;
  readonly result: string | null;
  readonly parentAgentId: string | null;
  readonly agentIndex: number | null;
  readonly phaseIndex: number | null;
  readonly phaseTitle: string | null;
  readonly attempt: number | null;
  readonly workflowName: string | null;
  readonly phases: ReadonlyArray<OrchestrationV2WorkflowPhase>;
  readonly runHandles: AgentPanelRunHandles | null;
  /** First V2 observation, used as the roster's stable display order. */
  readonly firstSeenAt: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly updatedAt: string;
}

export interface AgentPanelWorkflowGroup {
  readonly workflow: AgentPanelSubagent;
  readonly phases: ReadonlyArray<{
    readonly index: number;
    readonly title: string;
    readonly members: ReadonlyArray<AgentPanelSubagent>;
    /** done = every member settled (success or error); running = any active. */
    readonly state: "pending" | "running" | "done";
    readonly activeCount: number;
    readonly settledCount: number;
  }>;
  /** Members with no resolvable phase render under the workflow. */
  readonly unphasedMembers: ReadonlyArray<AgentPanelSubagent>;
}

export interface AgentPanelModel {
  readonly workflows: ReadonlyArray<AgentPanelWorkflowGroup>;
  readonly directAgents: ReadonlyArray<AgentPanelSubagent>;
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

const TERMINAL_STATUSES: ReadonlySet<AgentPanelSubagentStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
  "interrupted",
]);

function isTerminalStatus(status: AgentPanelSubagentStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

function isActiveStatus(status: AgentPanelSubagentStatus): boolean {
  return status === "pending" || status === "running" || status === "waiting";
}

function parentAgentId(
  subagent: OrchestrationV2Subagent,
  subagentById: ReadonlyMap<string, OrchestrationV2Subagent>,
  parentIdByChildThreadId: ReadonlyMap<string, string>,
): string | null {
  const workflowParentId = subagent.workflowMembership?.workflowSubagentId;
  if (workflowParentId !== undefined) {
    return workflowParentId;
  }
  if (subagentById.has(subagent.parentNodeId)) {
    return subagent.parentNodeId;
  }
  return parentIdByChildThreadId.get(subagent.threadId) ?? null;
}

function toPanelSubagent(
  subagent: OrchestrationV2Subagent,
  subagentById: ReadonlyMap<string, OrchestrationV2Subagent>,
  parentIdByChildThreadId: ReadonlyMap<string, string>,
): AgentPanelSubagent {
  const updatedAt = DateTime.formatIso(subagent.updatedAt);
  const startedAt = subagent.startedAt === null ? null : DateTime.formatIso(subagent.startedAt);
  const membership = subagent.workflowMembership;
  const coordinator =
    membership === null ? undefined : subagentById.get(membership.workflowSubagentId);
  const phaseTitle =
    membership?.phaseIndex === null || membership?.phaseIndex === undefined
      ? null
      : (coordinator?.workflow?.phases.find((phase) => phase.index === membership.phaseIndex)
          ?.title ?? null);
  const workflow = subagent.workflow;
  const runHandles =
    workflow !== null &&
    (workflow.runId !== undefined ||
      workflow.scriptPath !== undefined ||
      workflow.transcriptDir !== undefined ||
      workflow.sessionUrl !== undefined)
      ? {
          ...(workflow.runId === undefined ? {} : { runId: workflow.runId }),
          ...(workflow.scriptPath === undefined ? {} : { scriptPath: workflow.scriptPath }),
          ...(workflow.transcriptDir === undefined
            ? {}
            : { transcriptDir: workflow.transcriptDir }),
          ...(workflow.sessionUrl === undefined ? {} : { sessionUrl: workflow.sessionUrl }),
        }
      : null;
  const latestActivity = subagent.recentActivity.at(-1);
  const resolvedParentAgentId = parentAgentId(subagent, subagentById, parentIdByChildThreadId);

  return {
    id: subagent.id,
    kind: subagent.kind,
    title:
      subagent.title ??
      (subagent.prompt.length > 80 ? `${subagent.prompt.slice(0, 77)}...` : subagent.prompt),
    role: subagent.role.name,
    model: subagent.model,
    status: subagent.status,
    activationCount: subagent.activationCount,
    usage: subagent.usage,
    progress: subagent.progress ?? latestActivity?.summary ?? null,
    result: subagent.result,
    parentAgentId: resolvedParentAgentId,
    agentIndex: membership?.agentIndex ?? null,
    phaseIndex: membership?.phaseIndex ?? null,
    phaseTitle,
    attempt: membership?.attempt ?? null,
    workflowName: workflow?.name ?? null,
    phases: workflow?.phases ?? [],
    runHandles,
    firstSeenAt:
      startedAt ??
      (subagent.recentActivity[0] === undefined
        ? updatedAt
        : DateTime.formatIso(subagent.recentActivity[0].at)),
    startedAt,
    completedAt: subagent.completedAt === null ? null : DateTime.formatIso(subagent.completedAt),
    updatedAt,
  };
}

export function emptyAgentPanelModel(): AgentPanelModel {
  return EMPTY_PANEL_MODEL;
}

/** Derive the web panel model directly from the Orchestrator V2 projection. */
export function deriveAgentPanelModel(
  subagents: ReadonlyArray<OrchestrationV2Subagent>,
): AgentPanelModel {
  if (subagents.length === 0) {
    return EMPTY_PANEL_MODEL;
  }

  const subagentById = new Map(subagents.map((subagent) => [subagent.id, subagent]));
  const parentIdByChildThreadId = new Map(
    subagents.flatMap((subagent) =>
      subagent.childThreadId === null ? [] : [[subagent.childThreadId, subagent.id] as const],
    ),
  );
  const source = subagents.map((subagent) =>
    toPanelSubagent(subagent, subagentById, parentIdByChildThreadId),
  );
  const workflows = source
    .filter((agent) => agent.kind === "workflow")
    .slice()
    .sort((a, b) => a.firstSeenAt.localeCompare(b.firstSeenAt) || a.id.localeCompare(b.id));
  const workflowIds = new Set(workflows.map((workflow) => workflow.id));
  const members = new Map<string, AgentPanelSubagent[]>();
  const directCandidates: AgentPanelSubagent[] = [];

  for (const agent of source) {
    if (agent.kind === "workflow") {
      continue;
    }
    if (agent.parentAgentId !== null && workflowIds.has(agent.parentAgentId)) {
      const list = members.get(agent.parentAgentId) ?? [];
      list.push(agent);
      members.set(agent.parentAgentId, list);
    } else {
      directCandidates.push(agent);
    }
  }

  const compareFirstSeen = (a: AgentPanelSubagent, b: AgentPanelSubagent) =>
    a.firstSeenAt.localeCompare(b.firstSeenAt) || a.id.localeCompare(b.id);
  const directById = new Map(directCandidates.map((agent) => [agent.id, agent]));
  const directChildren = new Map<string, AgentPanelSubagent[]>();
  const directRoots: AgentPanelSubagent[] = [];
  for (const agent of directCandidates) {
    if (agent.parentAgentId !== null && directById.has(agent.parentAgentId)) {
      const children = directChildren.get(agent.parentAgentId) ?? [];
      children.push(agent);
      directChildren.set(agent.parentAgentId, children);
    } else {
      directRoots.push(agent);
    }
  }
  directRoots.sort(compareFirstSeen);
  for (const children of directChildren.values()) {
    children.sort(compareFirstSeen);
  }
  const directAgents: AgentPanelSubagent[] = [];
  const visited = new Set<string>();
  const appendAgentTree = (agent: AgentPanelSubagent) => {
    if (visited.has(agent.id)) return;
    visited.add(agent.id);
    directAgents.push(agent);
    for (const child of directChildren.get(agent.id) ?? []) {
      appendAgentTree(child);
    }
  };
  for (const root of directRoots) appendAgentTree(root);
  // Malformed cycles stay visible rather than disappearing from the panel.
  for (const agent of directCandidates.slice().sort(compareFirstSeen)) appendAgentTree(agent);

  const workflowGroups: AgentPanelWorkflowGroup[] = workflows.map((workflow) => {
    const workflowMembers = members.get(workflow.id) ?? [];
    const knownPhases =
      workflow.phases.length > 0
        ? workflow.phases
        : (() => {
            const derived = new Map<number, string>();
            for (const member of workflowMembers) {
              if (member.phaseIndex !== null && !derived.has(member.phaseIndex)) {
                derived.set(
                  member.phaseIndex,
                  member.phaseTitle ?? `Phase ${member.phaseIndex + 1}`,
                );
              }
            }
            return Array.from(derived.entries())
              .map(([index, title]) => ({ index, title }))
              .slice()
              .sort((a, b) => a.index - b.index);
          })();

    const knownPhaseIndices = new Set(knownPhases.map((phase) => phase.index));
    const phases = knownPhases.map((phase) => {
      const phaseMembers = workflowMembers
        .filter((member) => member.phaseIndex === phase.index)
        .slice()
        .sort((a, b) => (a.agentIndex ?? 0) - (b.agentIndex ?? 0));
      const activeCount = phaseMembers.filter(
        (member) => isActiveStatus(member.status) || member.status === "idle",
      ).length;
      const settledCount = phaseMembers.filter((member) => isTerminalStatus(member.status)).length;
      const state: "pending" | "running" | "done" =
        phaseMembers.length === 0
          ? isTerminalStatus(workflow.status)
            ? "done"
            : "pending"
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
    // A workflow coordinator is a container when it has members. Counting it
    // would inflate the live-agent total and may double-count provider usage.
    if (agent.kind === "workflow" && (members.get(agent.id) ?? []).length > 0) continue;
    if (agent.status === "running" || agent.status === "pending") runningCount += 1;
    else if (agent.status === "waiting") waitingCount += 1;
    else if (agent.status === "idle") idleCount += 1;
    else settledCount += 1;
    totalTokens += agent.usage?.totalTokens ?? 0;
  }

  return {
    workflows: workflowGroups,
    directAgents,
    runningCount,
    waitingCount,
    idleCount,
    settledCount,
    totalTokens,
    hasAgents: true,
    liveCount: runningCount + waitingCount,
  };
}

export function formatSubagentModelLabel(model: string | null): string | null {
  if (!model) {
    return null;
  }
  return model
    .replace(/^claude-/, "")
    .replace(/-\d{8}$/, "")
    .replace(/-latest$/, "");
}

export function formatSubagentTokenCount(totalTokens: number): string {
  if (totalTokens < 1000) {
    return `${totalTokens}`;
  }
  if (totalTokens < 1_000_000) {
    const value = totalTokens / 1000;
    return `${value >= 100 ? Math.round(value) : value.toFixed(1)}k`;
  }
  return `${(totalTokens / 1_000_000).toFixed(1)}M`;
}
