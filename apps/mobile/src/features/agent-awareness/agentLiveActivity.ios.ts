import { observeAgentWidget } from "./agentWidgetRefresh.ios";
import AgentActivity, { type AgentActivityProps } from "../../widgets/AgentActivity";

export function publishAgentActivityWidget(props: AgentActivityProps): boolean {
  try {
    return observeAgentWidget(props);
  } catch {
    // Personal-team builds have no widget extension.
    return false;
  }
}

export function dismissEndedAgentLiveActivities() {
  AgentActivity.dismissEnded();
}

export function getAgentLiveActivities() {
  return AgentActivity.getInstances();
}

export function startAgentLiveActivity(props: AgentActivityProps, staleDate?: Date) {
  return AgentActivity.start(props, undefined, staleDate);
}
