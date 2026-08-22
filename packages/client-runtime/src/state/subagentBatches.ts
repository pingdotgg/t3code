import type { RuntimeSubagent, RuntimeSubagentStatus } from "./subagentRuntime.ts";

const ROSTER_LIMIT = 100;

/** Active = the user may still need to care while it runs. Idle is settled-ish
 * but resumable; waiting counts as active because it needs the user. */
export function isActiveSubagentStatus(status: RuntimeSubagentStatus): boolean {
  return status === "pending" || status === "running" || status === "waiting";
}

export interface SubagentBatchCount {
  readonly totalCount: number;
  readonly workingCount: number;
  readonly failedCount: number;
  readonly stoppedCount: number;
  readonly idleCount: number;
  readonly completedCount: number;
}

export interface FoldedSubagentActivitiesWithBatchCounts {
  readonly agents: ReadonlyArray<RuntimeSubagent>;
  readonly agentTaskIds: ReadonlySet<string>;
  readonly batchKeyByActivityId: ReadonlyMap<string, string>;
  readonly batchCounts: ReadonlyMap<string, SubagentBatchCount>;
}

export interface FoldSubagentActivitiesOptions {
  readonly sessionLive?: boolean;
}

export interface DerivedSubagentBatchCounts {
  readonly batchKeyByActivityId: ReadonlyMap<string, string>;
  readonly batchCounts: ReadonlyMap<string, SubagentBatchCount>;
}

interface SubagentBatchAgent {
  readonly id: string;
  readonly kind: "subagent" | "workflow" | "workflow_agent";
  readonly parentAgentId: string | null;
  readonly activations: ReadonlyArray<{
    readonly turnId: string | null;
    readonly status: RuntimeSubagentStatus;
  }>;
}

function batchKey(agent: SubagentBatchAgent, turnId: string | null): string {
  if (agent.kind === "workflow") {
    return `wf:${agent.id}`;
  }
  if (agent.kind === "workflow_agent") {
    const workflowMarker = agent.id.indexOf(":wf:");
    const workflowId =
      agent.parentAgentId ?? (workflowMarker === -1 ? agent.id : agent.id.slice(0, workflowMarker));
    return `wf:${workflowId}`;
  }
  return turnId ? `direct:${turnId}` : `direct:task:${agent.id}`;
}

export function deriveSubagentBatchCounts<Agent extends SubagentBatchAgent>(
  agents: Iterable<Agent>,
  activityActivations: ReadonlyMap<string, readonly [Agent, number]>,
): DerivedSubagentBatchCounts {
  const batchKeyByActivityId = new Map<string, string>();
  const statusesByBatch = new Map<string, Map<string, RuntimeSubagentStatus>>();
  for (const agent of agents) {
    for (const [activationIndex, activation] of agent.activations.entries()) {
      const key = batchKey(agent, activation.turnId);
      const statuses = statusesByBatch.get(key) ?? new Map<string, RuntimeSubagentStatus>();
      statusesByBatch.set(key, statuses);
      if (agent.kind !== "workflow") {
        statuses.set(
          agent.kind === "workflow_agent" ? agent.id : `${agent.id}:${activationIndex}`,
          activation.status,
        );
      }
    }
  }

  for (const [activityId, [agent, activationIndex]] of activityActivations) {
    const activation = agent.activations[activationIndex];
    if (activation) {
      batchKeyByActivityId.set(activityId, batchKey(agent, activation.turnId));
    }
  }

  const batchCounts = new Map<string, SubagentBatchCount>();
  for (const [key, statuses] of statusesByBatch) {
    const count = {
      totalCount: 0,
      workingCount: 0,
      failedCount: 0,
      stoppedCount: 0,
      idleCount: 0,
      completedCount: 0,
    };
    for (const status of statuses.values()) {
      count.totalCount += 1;
      if (isActiveSubagentStatus(status)) {
        count.workingCount += 1;
      }
      if (status === "failed") count.failedCount += 1;
      if (status === "cancelled" || status === "interrupted") count.stoppedCount += 1;
      if (status === "idle") count.idleCount += 1;
      if (status === "completed") count.completedCount += 1;
    }
    batchCounts.set(key, count);
  }
  return { batchKeyByActivityId, batchCounts };
}

export function capSubagentRoster(
  agents: ReadonlyArray<RuntimeSubagent>,
): ReadonlyArray<RuntimeSubagent> {
  if (agents.length <= ROSTER_LIMIT) return agents;
  // Prefer live, then waiting/idle, then newest settled.
  const rank = (agent: RuntimeSubagent): number =>
    isActiveSubagentStatus(agent.status) ? 0 : agent.status === "idle" ? 1 : 2;
  return agents
    .slice()
    .sort((a, b) => rank(a) - rank(b) || b.updatedAt.localeCompare(a.updatedAt))
    .slice(0, ROSTER_LIMIT);
}
