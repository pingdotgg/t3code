/**
 * Roster shape for the Agents panel, kept out of the component so the rules
 * that decide where an agent appears can be tested directly.
 */
import type {
  AgentPanelModel,
  AgentPanelWorkflowGroup,
  RuntimeSubagent,
} from "@t3tools/client-runtime/state/subagentRuntime";
import { isTerminalSubagentStatus } from "@t3tools/client-runtime/state/subagentRuntime";

/**
 * Live = still worth watching. Idle counts as settled: a resting Codex child
 * looks done unless resumed, and parking it under Finished keeps the live
 * sections honest about what is actually running.
 */
export function isLiveAgent(agent: RuntimeSubagent): boolean {
  return !isTerminalSubagentStatus(agent.status) && agent.status !== "idle";
}

/** Flatten phase members in their displayed order, followed by unphased members. */
export function workflowMembers(group: AgentPanelWorkflowGroup): ReadonlyArray<RuntimeSubagent> {
  return [...group.phases.flatMap((phase) => phase.members), ...group.unphasedMembers];
}

/** Give fleet totals and finished grouping the same roster order as the panel. */
export function allPanelAgents(model: AgentPanelModel): ReadonlyArray<RuntimeSubagent> {
  return [...model.workflows.flatMap(workflowMembers), ...model.directAgents];
}

/**
 * Finished agents leave their phase and collect in one section, so the roster
 * spends its height on live work. Order is the roster's own (spawn order),
 * never re-sorted by outcome — a card must not move because it settled.
 */
export function finishedAgents(model: AgentPanelModel): ReadonlyArray<RuntimeSubagent> {
  return allPanelAgents(model).filter((agent) => !isLiveAgent(agent));
}

/**
 * Collapsing a section hides its cards, so anything expanded inside it must
 * close: reopening the section would otherwise restore a state the user could
 * not see themselves leaving behind.
 */
export function expansionsAfterCollapse(
  expanded: ReadonlySet<string>,
  collapsedMembers: ReadonlyArray<RuntimeSubagent>,
): ReadonlySet<string> {
  const next = new Set(expanded);
  for (const member of collapsedMembers) {
    next.delete(member.id);
  }
  return next;
}
