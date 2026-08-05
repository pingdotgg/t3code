import type {
  OrchestrationV2Subagent,
  OrchestrationV2SubagentActivation,
} from "@t3tools/contracts";

export interface OrchestrationV2SubagentPhaseGroup {
  readonly index: number;
  readonly title: string;
  readonly status: "pending" | "running" | "done";
  readonly agents: ReadonlyArray<OrchestrationV2Subagent>;
}

export interface OrchestrationV2SubagentGroup {
  readonly workflow: OrchestrationV2Subagent | null;
  readonly phases: ReadonlyArray<OrchestrationV2SubagentPhaseGroup>;
  readonly agents: ReadonlyArray<OrchestrationV2Subagent>;
}

export interface OrchestrationV2SubagentPanelState {
  readonly groups: ReadonlyArray<OrchestrationV2SubagentGroup>;
  readonly activationsBySubagentId: ReadonlyMap<
    string,
    ReadonlyArray<OrchestrationV2SubagentActivation>
  >;
  readonly activeCount: number;
  readonly waitingCount: number;
  readonly settledCount: number;
  readonly totalTokens: number | null;
}

export const isSettledOrchestrationV2Subagent = (agent: OrchestrationV2Subagent) =>
  agent.status === "idle" ||
  agent.status === "completed" ||
  agent.status === "failed" ||
  agent.status === "cancelled" ||
  agent.status === "interrupted";

// An empty phase is pending only while the workflow can still populate it; a
// settled coordinator will never spawn its members, so the phase is done.
const phaseStatus = (agents: ReadonlyArray<OrchestrationV2Subagent>, workflowSettled: boolean) =>
  agents.length === 0
    ? workflowSettled
      ? ("done" as const)
      : ("pending" as const)
    : agents.every(isSettledOrchestrationV2Subagent)
      ? ("done" as const)
      : agents.every((agent) => agent.status === "pending")
        ? ("pending" as const)
        : ("running" as const);

export function deriveOrchestrationV2SubagentPanelState(input: {
  readonly subagents: ReadonlyArray<OrchestrationV2Subagent>;
  readonly activations: ReadonlyArray<OrchestrationV2SubagentActivation>;
}): OrchestrationV2SubagentPanelState {
  const activationsBySubagentId = new Map<string, OrchestrationV2SubagentActivation[]>();
  for (const activation of input.activations) {
    const current = activationsBySubagentId.get(activation.subagentId) ?? [];
    current.push(activation);
    activationsBySubagentId.set(activation.subagentId, current);
  }
  for (const activations of activationsBySubagentId.values()) {
    activations.sort((left, right) => left.ordinal - right.ordinal);
  }

  const workflows = input.subagents.filter((agent) => agent.kind === "workflow");
  const membersByWorkflow = new Map<string, OrchestrationV2Subagent[]>();
  const direct: OrchestrationV2Subagent[] = [];
  for (const agent of input.subagents) {
    if (agent.kind === "workflow") continue;
    const workflowId = agent.workflowMembership?.workflowSubagentId;
    if (workflowId === undefined) {
      direct.push(agent);
      continue;
    }
    const members = membersByWorkflow.get(workflowId) ?? [];
    members.push(agent);
    membersByWorkflow.set(workflowId, members);
  }

  const groups: OrchestrationV2SubagentGroup[] = workflows.map((workflow) => {
    const members = membersByWorkflow.get(workflow.id) ?? [];
    membersByWorkflow.delete(workflow.id);
    const phases = (workflow.workflow?.phases ?? []).map((phase) => {
      // .sort() on filter's fresh array, not .toSorted(): Hermes lacks the
      // ES2023 change-by-copy methods and this module is mobile-reachable.
      const agents = members
        .filter((agent) => agent.workflowMembership?.phaseIndex === phase.index)
        .sort(
          (left, right) =>
            (left.workflowMembership?.agentIndex ?? 0) -
            (right.workflowMembership?.agentIndex ?? 0),
        );
      return {
        ...phase,
        status: phaseStatus(agents, isSettledOrchestrationV2Subagent(workflow)),
        agents,
      };
    });
    const phasedIds = new Set(phases.flatMap((phase) => phase.agents.map((agent) => agent.id)));
    return {
      workflow,
      phases,
      agents: members.filter((agent) => !phasedIds.has(agent.id)),
    };
  });
  for (const orphaned of membersByWorkflow.values()) direct.push(...orphaned);
  if (direct.length > 0) groups.push({ workflow: null, phases: [], agents: direct });

  const workers = input.subagents.filter((agent) => agent.kind !== "workflow");
  const memberTotalsByWorkflow = new Map<string, number>();
  for (const agent of workers) {
    const workflowId = agent.workflowMembership?.workflowSubagentId;
    if (workflowId === undefined) continue;
    memberTotalsByWorkflow.set(
      workflowId,
      (memberTotalsByWorkflow.get(workflowId) ?? 0) + (agent.usage?.totalTokens ?? 0),
    );
  }
  const workflowIdsWithReportedUsage = new Set(
    workflows.flatMap((workflow) => (workflow.usage === null ? [] : [workflow.id])),
  );
  const reportedUsage = input.subagents.flatMap((agent) => {
    if (agent.usage === null) return [];
    const workflowId = agent.workflowMembership?.workflowSubagentId;
    return workflowId !== undefined && workflowIdsWithReportedUsage.has(workflowId)
      ? []
      : [agent.usage.totalTokens];
  });
  // Count the workers, plus any coordinator whose members are not carrying
  // the work right now. A coordinator with an active member is represented by
  // it and would double-count — but between phases (all members settled,
  // coordinator still running) and before the first member spawns, the
  // coordinator is the only live row, and omitting it reported "0 active"
  // while a workflow was visibly running. A settled coordinator with members
  // stays excluded: they represent its final state.
  const workflowsWithActiveMembers = new Set(
    workers.flatMap((agent) =>
      agent.workflowMembership !== null &&
      (agent.status === "pending" || agent.status === "running" || agent.status === "waiting")
        ? [agent.workflowMembership.workflowSubagentId]
        : [],
    ),
  );
  const counted = input.subagents.filter((agent) => {
    if (agent.kind !== "workflow") return true;
    if (workflowsWithActiveMembers.has(agent.id)) return false;
    return !memberTotalsByWorkflow.has(agent.id) || !isSettledOrchestrationV2Subagent(agent);
  });
  return {
    groups,
    activationsBySubagentId,
    activeCount: counted.filter((agent) => agent.status === "pending" || agent.status === "running")
      .length,
    waitingCount: counted.filter((agent) => agent.status === "waiting").length,
    settledCount: counted.filter(isSettledOrchestrationV2Subagent).length,
    totalTokens:
      reportedUsage.length === 0
        ? null
        : reportedUsage.reduce((total, tokens) => total + tokens, 0),
  };
}

export interface OrchestrationV2WorkflowRunCardState {
  readonly coordinator: OrchestrationV2Subagent;
  readonly phases: ReadonlyArray<OrchestrationV2SubagentPhaseGroup>;
  /** Members that claim no declared phase — rendered after the phased ones
   * rather than dropped, so a provider that omits phase indices still shows
   * every agent. */
  readonly unphasedAgents: ReadonlyArray<OrchestrationV2Subagent>;
  readonly memberCount: number;
  readonly settledMemberCount: number;
  readonly failedMemberCount: number;
  readonly totalTokens: number | null;
}

/**
 * The inline run card for one workflow coordinator. Returns null unless
 * `coordinatorId` names a workflow-kind subagent, so callers can probe any
 * subagent turn item with it.
 */
export function deriveOrchestrationV2WorkflowRunCard(input: {
  readonly coordinatorId: OrchestrationV2Subagent["id"];
  readonly subagents: ReadonlyArray<OrchestrationV2Subagent>;
}): OrchestrationV2WorkflowRunCardState | null {
  const coordinator = input.subagents.find(
    (agent) => agent.id === input.coordinatorId && agent.kind === "workflow",
  );
  if (coordinator === undefined) return null;
  const members = input.subagents
    .filter(
      (agent) =>
        agent.kind !== "workflow" &&
        agent.workflowMembership?.workflowSubagentId === coordinator.id,
    )
    .sort(
      (left, right) =>
        (left.workflowMembership?.agentIndex ?? 0) - (right.workflowMembership?.agentIndex ?? 0),
    );
  const phases = (coordinator.workflow?.phases ?? []).map((phase) => {
    const agents = members.filter((agent) => agent.workflowMembership?.phaseIndex === phase.index);
    return {
      ...phase,
      status: phaseStatus(agents, isSettledOrchestrationV2Subagent(coordinator)),
      agents,
    };
  });
  const phasedIds = new Set(phases.flatMap((phase) => phase.agents.map((agent) => agent.id)));
  // The coordinator's usage already covers its members (the panel derivation
  // relies on the same invariant); fall back to the member sum only when the
  // provider reported no coordinator total at all.
  const memberUsage = members.flatMap((agent) =>
    agent.usage === null ? [] : [agent.usage.totalTokens],
  );
  return {
    coordinator,
    phases,
    unphasedAgents: members.filter((agent) => !phasedIds.has(agent.id)),
    memberCount: members.length,
    settledMemberCount: members.filter(isSettledOrchestrationV2Subagent).length,
    failedMemberCount: members.filter((agent) => agent.status === "failed").length,
    totalTokens:
      coordinator.usage?.totalTokens ??
      (memberUsage.length === 0 ? null : memberUsage.reduce((total, tokens) => total + tokens, 0)),
  };
}

/**
 * Ids of workflow members whose coordinator is present as a workflow-kind
 * subagent. The timeline hides these rows — the coordinator's run card
 * already renders them — while members orphaned by a missing coordinator
 * keep their own row rather than disappearing.
 */
export function orchestrationV2WorkflowMemberIds(
  subagents: ReadonlyArray<OrchestrationV2Subagent>,
): ReadonlySet<OrchestrationV2Subagent["id"]> {
  const coordinatorIds = new Set(
    subagents.flatMap((agent) => (agent.kind === "workflow" ? [agent.id] : [])),
  );
  return new Set(
    subagents.flatMap((agent) =>
      agent.kind !== "workflow" &&
      agent.workflowMembership !== null &&
      coordinatorIds.has(agent.workflowMembership.workflowSubagentId)
        ? [agent.id]
        : [],
    ),
  );
}

export const formatSubagentTokenCount = (totalTokens: number) =>
  totalTokens >= 999_500
    ? `${(totalTokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`
    : totalTokens >= 1_000
      ? `${(totalTokens / 1_000).toFixed(1).replace(/\.0$/, "")}k`
      : String(totalTokens);
