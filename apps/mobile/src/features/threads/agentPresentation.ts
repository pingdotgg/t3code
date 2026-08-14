import {
  deriveAgentPanelModel,
  formatSubagentModelLabel,
  formatSubagentTokenCount,
  type AgentPanelModel,
  type RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import type { OrchestrationThreadActivity } from "@t3tools/contracts";

import { memoizedFoldSubagentActivities } from "../../lib/threadActivity";

const STATUS_LABELS: Record<RuntimeSubagent["status"], string> = {
  pending: "Working",
  running: "Working",
  waiting: "Working",
  idle: "Idle · resumable",
  completed: "Completed",
  failed: "Failed",
  cancelled: "Stopped",
  interrupted: "Stopped",
};

export function deriveMobileAgentPanelModel(input: {
  readonly activities: ReadonlyArray<OrchestrationThreadActivity>;
  readonly sessionLive: boolean;
}): AgentPanelModel {
  return deriveAgentPanelModel({
    agents: memoizedFoldSubagentActivities(input.activities, {
      sessionLive: input.sessionLive,
      rosterLimit: null,
    }).agents,
  });
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
  const live =
    agent.status === "running" || agent.status === "pending" || agent.status === "waiting";
  const activity = live
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
  const live =
    agent.status === "running" || agent.status === "pending" || agent.status === "waiting";
  return {
    id: agent.id,
    title: agent.title,
    role,
    modelLabel: formatSubagentModelLabel(agent.model, agent.effort),
    status: agent.status,
    statusLabel: STATUS_LABELS[agent.status],
    elapsed: elapsedBetween(agent.startedAt, live ? null : agent.completedAt, nowMs),
    activity: agentActivityText(agent),
    tokenLabel: agent.usage ? `${formatSubagentTokenCount(agent.usage.totalTokens)} tok` : "— tok",
    toolLabel: agent.usage?.toolUses !== undefined ? `${agent.usage.toolUses} tools` : null,
    activationLabel: agent.activationCount > 1 ? `run ${agent.activationCount}` : null,
  };
}

export interface MobileAgentDetailActivity {
  readonly key: string;
  readonly at: string;
  readonly summary: string;
}

export interface MobileAgentDetailModel extends MobileAgentRowModel {
  readonly result: string | null;
  readonly error: string | null;
  readonly activities: ReadonlyArray<MobileAgentDetailActivity>;
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
  const activities = agent.recentActivity.map((entry) => ({
    key: `activity:${entry.id}`,
    at: entry.at,
    summary: entry.summary,
  }));
  return {
    ...row,
    result: agent.result,
    error: agent.error,
    activities,
    activityTruncationLabel: agent.recentActivityTruncated
      ? `Showing the latest ${activities.length} activities; earlier entries were dropped.`
      : null,
  };
}
