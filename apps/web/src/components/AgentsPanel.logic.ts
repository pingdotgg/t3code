import type {
  AgentPanelModel,
  AgentPanelWorkflowGroup,
  RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { isActiveSubagentStatus } from "@t3tools/client-runtime/state/subagentRuntime";

/** Flatten phase members in their displayed order, followed by unphased members. */
export function workflowMembers(group: AgentPanelWorkflowGroup): ReadonlyArray<RuntimeSubagent> {
  return [...group.phases.flatMap((phase) => phase.members), ...group.unphasedMembers];
}

/** Count a memberless coordinator as an agent; coordinators with children remain containers. */
function workflowAgents(group: AgentPanelWorkflowGroup): ReadonlyArray<RuntimeSubagent> {
  const members = workflowMembers(group);
  return members.length === 0 ? [group.workflow] : members;
}

/** Return every visible agent once, preserving workflow and spawn order. */
export function allPanelAgents(model: AgentPanelModel): ReadonlyArray<RuntimeSubagent> {
  return [...model.workflows.flatMap(workflowAgents), ...model.directAgents];
}

/** Keep a live coordinator visible before its first child and between sequential phases. */
export function workflowIsVisible(group: AgentPanelWorkflowGroup): boolean {
  return (
    isActiveSubagentStatus(group.workflow.status) ||
    workflowMembers(group).some((agent) => isActiveSubagentStatus(agent.status))
  );
}
