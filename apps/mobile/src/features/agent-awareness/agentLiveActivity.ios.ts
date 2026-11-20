import type { AgentActivityProps } from "../../widgets/AgentActivity";
import AgentActivity from "../../widgets/pseudocode/WorkLiveActivity";
import { widgetAppScheme } from "../../widgets/pseudocode/widgetAppScheme";

export function dismissEndedAgentLiveActivities() {
  AgentActivity.dismissEnded();
}

export function getAgentLiveActivities() {
  return AgentActivity.getInstances();
}

export function startAgentLiveActivity(props: AgentActivityProps, staleDate?: Date) {
  return AgentActivity.start({ ...props, appScheme: widgetAppScheme() }, undefined, staleDate);
}
