import {
  deriveAgentPanelModel,
  formatSubagentModelLabel,
  formatSubagentTokenCount,
  isActiveSubagentStatus,
  type AgentPanelWorkflowGroup,
  type AgentPanelModel,
  type RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import type { OrchestrationThreadActivity } from "@t3tools/contracts";

import { memoizedFoldSubagentActivities } from "../../lib/threadAgentActivity";

const STATUS_LABELS = {
  pending: "Working",
  running: "Working",
  waiting: "Working",
  idle: "Idle · resumable",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Stopped",
  interrupted: "Stopped",
} satisfies Record<RuntimeSubagent["status"], string>;

export function deriveMobileAgentPanelModel(input: {
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly sessionLive: boolean;
}): AgentPanelModel {
  return deriveAgentPanelModel({
    agents: memoizedFoldSubagentActivities(input.activities, {
      sessionLive: input.sessionLive,
    }).agents,
  });
}

export type MobileAgentsListItem =
  | {
      readonly kind: "workflow-header";
      readonly key: string;
      readonly group: AgentPanelWorkflowGroup;
    }
  | {
      readonly kind: "phase-header";
      readonly key: string;
      readonly phase: AgentPanelWorkflowGroup["phases"][number];
    }
  | { readonly kind: "section-header"; readonly key: string; readonly title: string }
  | { readonly kind: "agent"; readonly key: string; readonly agent: RuntimeSubagent }
  | { readonly kind: "spacer"; readonly key: string }
  | { readonly kind: "summary"; readonly key: string; readonly model: AgentPanelModel };

export function buildMobileAgentsListItems(
  model: AgentPanelModel,
): ReadonlyArray<MobileAgentsListItem> {
  const items: MobileAgentsListItem[] = [];
  for (const group of model.workflows) {
    const workflowId = group.workflow.id;
    items.push({ kind: "workflow-header", key: `workflow:${workflowId}`, group });
    items.push({ kind: "agent", key: `agent:${workflowId}`, agent: group.workflow });
    for (const phase of group.phases) {
      items.push({
        kind: "phase-header",
        key: `workflow:${workflowId}:phase:${phase.index}`,
        phase,
      });
      for (const member of phase.members) {
        items.push({ kind: "agent", key: `agent:${member.id}`, agent: member });
      }
    }
    if (group.unphasedMembers.length > 0) {
      items.push({
        kind: "section-header",
        key: `workflow:${workflowId}:other`,
        title: "Other agents",
      });
      for (const member of group.unphasedMembers) {
        items.push({ kind: "agent", key: `agent:${member.id}`, agent: member });
      }
    }
    items.push({ kind: "spacer", key: `workflow:${workflowId}:spacer` });
  }
  if (model.directAgents.length > 0) {
    items.push({ kind: "section-header", key: "direct-header", title: "Direct spawns" });
    for (const agent of model.directAgents) {
      items.push({ kind: "agent", key: `agent:${agent.id}`, agent });
    }
    items.push({ kind: "spacer", key: "direct-spacer" });
  }
  items.push({ kind: "summary", key: "summary", model });
  return items;
}

function formatElapsedSeconds(totalSeconds: number): string {
  const seconds = Math.max(0, Math.floor(totalSeconds));
  const minutes = Math.floor(seconds / 60);
  if (minutes === 0) return `${seconds}s`;
  const hours = Math.floor(minutes / 60);
  if (hours === 0) return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
  return `${hours}h ${String(minutes % 60).padStart(2, "0")}m`;
}

function elapsedBetween(startedAt: string | null, completedAt: string | null, nowMs: number) {
  if (!startedAt) return null;
  const startMs = Date.parse(startedAt);
  const endMs = completedAt ? Date.parse(completedAt) : nowMs;
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return null;
  return formatElapsedSeconds((endMs - startMs) / 1_000);
}

function agentActivityText(agent: RuntimeSubagent): string {
  const activity = isActiveSubagentStatus(agent.status)
    ? (agent.progress ??
      (agent.lastToolName ? `▸ ${agent.lastToolName}` : null) ??
      agent.result ??
      agent.error)
    : (agent.error ??
      agent.result ??
      agent.progress ??
      (agent.lastToolName ? `▸ ${agent.lastToolName}` : null));
  return activity ?? STATUS_LABELS[agent.status];
}

export interface MobileAgentRowModel {
  readonly id: string;
  readonly title: string;
  readonly role: string | null;
  readonly modelLabel: string | null;
  readonly status: RuntimeSubagent["status"];
  readonly statusLabel: string;
  readonly elapsed: string | null;
  readonly activity: string;
  readonly tokenLabel: string;
  readonly toolLabel: string | null;
  readonly activationLabel: string | null;
}

export function deriveMobileAgentRowModel(
  agent: RuntimeSubagent,
  nowMs = Date.now(),
): MobileAgentRowModel {
  const role =
    agent.role?.trim().toLocaleLowerCase() === agent.title.trim().toLocaleLowerCase()
      ? null
      : agent.role;
  return {
    id: agent.id,
    title: agent.title,
    role,
    modelLabel: formatSubagentModelLabel(agent.model, agent.effort),
    status: agent.status,
    statusLabel: STATUS_LABELS[agent.status],
    elapsed: elapsedBetween(
      agent.startedAt,
      agent.status === "idle"
        ? agent.updatedAt
        : isActiveSubagentStatus(agent.status)
          ? null
          : agent.completedAt,
      nowMs,
    ),
    activity: agentActivityText(agent),
    tokenLabel: agent.usage ? `${formatSubagentTokenCount(agent.usage.totalTokens)} tok` : "— tok",
    toolLabel: agent.usage?.toolUses !== undefined ? `${agent.usage.toolUses} tools` : null,
    activationLabel: agent.activationCount > 1 ? `run ${agent.activationCount}` : null,
  };
}

export interface MobileAgentDetailModel extends MobileAgentRowModel {
  readonly result: string | null;
  readonly error: string | null;
  readonly activities: RuntimeSubagent["recentActivity"];
  readonly activityTruncationLabel: string | null;
}

export function findMobileAgent(model: AgentPanelModel, agentId: string): RuntimeSubagent | null {
  for (const group of model.workflows) {
    if (group.workflow.id === agentId) return group.workflow;
    for (const phase of group.phases) {
      const member = phase.members.find((agent) => agent.id === agentId);
      if (member) return member;
    }
    const unphasedMember = group.unphasedMembers.find((agent) => agent.id === agentId);
    if (unphasedMember) return unphasedMember;
  }
  return model.directAgents.find((agent) => agent.id === agentId) ?? null;
}

export function deriveMobileAgentDetailModel(
  agent: RuntimeSubagent,
  nowMs = Date.now(),
): MobileAgentDetailModel {
  const row = deriveMobileAgentRowModel(agent, nowMs);
  return {
    ...row,
    result: agent.result,
    error: agent.error,
    activities: agent.recentActivity,
    activityTruncationLabel: agent.recentActivityTruncated
      ? `Showing the latest ${agent.recentActivity.length} activities; earlier entries were dropped.`
      : null,
  };
}
