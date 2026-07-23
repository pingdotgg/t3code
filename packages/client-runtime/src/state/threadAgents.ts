/**
 * Derivation helpers for the thread agent roster.
 *
 * The server ships the full per-thread roster latest-wins in the payload of
 * `agent.snapshot` activities (see `@t3tools/contracts` ThreadAgentsActivityPayload).
 * Mirrors the `context-window.updated` pattern: select the newest roster
 * (highest revision), decode tolerantly, skip rows that fail to decode.
 */
import {
  THREAD_AGENT_TERMINAL_STATUSES,
  THREAD_AGENTS_ACTIVITY_KIND,
  ThreadAgentSnapshot,
  type OrchestrationThreadActivity,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

const decodeAgent = Schema.decodeUnknownOption(ThreadAgentSnapshot);

interface RosterCandidate {
  readonly payload: { readonly agents: ReadonlyArray<unknown> };
  readonly revision: number;
}

function peekRoster(payload: unknown): RosterCandidate | undefined {
  if (payload === null || typeof payload !== "object") {
    return undefined;
  }
  const record = payload as { agents?: unknown; revision?: unknown };
  if (!Array.isArray(record.agents)) {
    return undefined;
  }
  return {
    payload: record as RosterCandidate["payload"],
    // Missing revision ranks lowest (-1), mirroring server hydration: a
    // revision-less legacy roster never beats a revisioned one, and among
    // equals the later list position wins.
    revision:
      typeof record.revision === "number" && Number.isInteger(record.revision)
        ? record.revision
        : -1,
  };
}

export function deriveLatestAgentSnapshot(
  activities: ReadonlyArray<OrchestrationThreadActivity>,
): ReadonlyArray<ThreadAgentSnapshot> {
  // Two passes so only ONE roster is schema-decoded per recompute: rosters
  // can dominate the 500-row activity window in busy sessions, and this runs
  // inside a useMemo that re-fires on every activities change. Winner =
  // highest revision, later list position breaking ties.
  let best: RosterCandidate | undefined;
  for (const activity of activities) {
    if (activity.kind !== THREAD_AGENTS_ACTIVITY_KIND) {
      continue;
    }
    const candidate = peekRoster(activity.payload);
    if (candidate && (!best || candidate.revision >= best.revision)) {
      best = candidate;
    }
  }
  if (!best) {
    return [];
  }
  // The winning roster is authoritative: rows decode per-element (one bad row
  // is skipped, the rest kept), and a fully undecodable roster yields an
  // empty panel rather than resurrecting an older snapshot.
  const decoded: ThreadAgentSnapshot[] = [];
  for (const candidate of best.payload.agents) {
    const result = decodeAgent(candidate);
    if (result._tag === "Some") {
      decoded.push(result.value);
    }
  }
  return decoded;
}

export function isTerminalAgentStatus(status: ThreadAgentSnapshot["status"]): boolean {
  return THREAD_AGENT_TERMINAL_STATUSES.has(status);
}

export interface AgentPanelGroup {
  /** The workflow snapshot this group belongs to, or null for direct spawns. */
  readonly workflow: ThreadAgentSnapshot | null;
  /** Phase sections in declared order; agents without a phase land in `rest`. */
  readonly phases: ReadonlyArray<AgentPanelPhase>;
  readonly rest: ReadonlyArray<ThreadAgentSnapshot>;
}

export interface AgentPanelPhase {
  readonly index: number;
  readonly title: string;
  readonly status: "pending" | "running" | "done";
  readonly agents: ReadonlyArray<ThreadAgentSnapshot>;
}

export interface AgentPanelState {
  readonly groups: ReadonlyArray<AgentPanelGroup>;
  readonly runningCount: number;
  readonly waitingCount: number;
  readonly settledCount: number;
  readonly totalTokens: number;
}

function isSettledAgentStatus(status: ThreadAgentSnapshot["status"]): boolean {
  // idle counts as settled for phase/summary purposes: the run finished even
  // though the agent identity could be resumed.
  return status === "idle" || isTerminalAgentStatus(status);
}

function phaseStatus(agents: ReadonlyArray<ThreadAgentSnapshot>): "pending" | "running" | "done" {
  if (agents.length === 0) return "pending";
  if (agents.every((agent) => isSettledAgentStatus(agent.status))) return "done";
  return "running";
}

export function deriveAgentPanelState(agents: ReadonlyArray<ThreadAgentSnapshot>): AgentPanelState {
  const workflows = agents.filter((agent) => agent.kind === "workflow");
  const byParent = new Map<string, ThreadAgentSnapshot[]>();
  const direct: ThreadAgentSnapshot[] = [];
  for (const agent of agents) {
    if (agent.kind === "workflow") continue;
    if (agent.parentAgentId) {
      const list = byParent.get(agent.parentAgentId) ?? [];
      list.push(agent);
      byParent.set(agent.parentAgentId, list);
    } else {
      direct.push(agent);
    }
  }

  const groups: AgentPanelGroup[] = [];
  for (const workflow of workflows) {
    const members = byParent.get(workflow.agentId) ?? [];
    byParent.delete(workflow.agentId);
    const declaredPhases = workflow.phases ?? [];
    const phases: AgentPanelPhase[] = declaredPhases.map((phase) => {
      const phaseAgents = members.filter((agent) => agent.phaseIndex === phase.index);
      return {
        index: phase.index,
        title: phase.title,
        status: phaseStatus(phaseAgents),
        agents: phaseAgents,
      };
    });
    const inDeclaredPhase = new Set(
      phases.flatMap((phase) => phase.agents.map((agent) => agent.agentId)),
    );
    groups.push({
      workflow,
      phases,
      rest: members.filter((agent) => !inDeclaredPhase.has(agent.agentId)),
    });
  }
  // Orphaned parent groups (parent never materialized) fold into direct spawns.
  for (const list of byParent.values()) {
    direct.push(...list);
  }
  if (direct.length > 0) {
    groups.push({ workflow: null, phases: [], rest: direct });
  }

  // Workflow container rows are grouping chrome, not workers: they are
  // excluded from worker counts, and a container's own usage only counts when
  // it has no member rows to avoid double-counting the same tokens.
  const workflowsWithMembers = new Set(
    agents.flatMap((agent) =>
      agent.kind !== "workflow" && agent.parentAgentId ? [agent.parentAgentId] : [],
    ),
  );
  let runningCount = 0;
  let waitingCount = 0;
  let settledCount = 0;
  let totalTokens = 0;
  for (const agent of agents) {
    const isContainer = agent.kind === "workflow";
    if (!isContainer) {
      if (agent.status === "running" || agent.status === "pending") runningCount += 1;
      else if (agent.status === "waiting") waitingCount += 1;
      else settledCount += 1; // idle + terminal
    }
    if (!isContainer || !workflowsWithMembers.has(agent.agentId)) {
      totalTokens += agent.usage?.totalTokens ?? 0;
    }
  }

  return { groups, runningCount, waitingCount, settledCount, totalTokens };
}

export function formatAgentTokenCount(totalTokens: number): string {
  if (totalTokens >= 1_000_000) {
    return `${(totalTokens / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
  }
  if (totalTokens >= 1_000) {
    return `${(totalTokens / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  }
  return `${totalTokens}`;
}
