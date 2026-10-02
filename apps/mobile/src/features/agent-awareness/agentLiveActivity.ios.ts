import { observeAgentWidget } from "./agentWidgetRefresh.ios";
import AgentActivity, {
  AgentActivityWidget,
  type AgentActivityProps,
} from "../../widgets/AgentActivity";
import { agentActivityTimeline } from "../../widgets/agentActivityTimeline";

export function publishAgentActivityWidget(props: AgentActivityProps): boolean {
  try {
    observeAgentWidget(props);
    AgentActivityWidget.updateTimeline(agentActivityTimeline(props, Date.now()));
    return true;
  } catch {
    // Personal-team builds have no widget extension.
    return false;
  }
}

export function getAgentLiveActivities() {
  return AgentActivity.getInstances();
}

export function startAgentLiveActivity(props: AgentActivityProps, staleDate?: Date) {
  return AgentActivity.start(props, undefined, staleDate);
}
