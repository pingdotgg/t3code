import { getNativeWidgetServices } from "../../widgets/NativeWidgetServices";
import type { AgentActivityProps } from "../../widgets/AgentActivity";

export { dismissEndedAgentLiveActivities } from "./builtinAgentLiveActivity";

export function getAgentLiveActivities() {
  return getNativeWidgetServices().getAgentLiveActivities();
}

export function startAgentLiveActivity(props: AgentActivityProps, staleDate?: Date) {
  return getNativeWidgetServices().startAgentLiveActivity(props, staleDate);
}
