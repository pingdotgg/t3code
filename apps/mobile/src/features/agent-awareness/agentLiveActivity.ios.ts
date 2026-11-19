import { addPushToStartTokenListener } from "expo-widgets";
import AgentActivity, { type AgentActivityProps } from "../../widgets/AgentActivity";

export function dismissEndedAgentLiveActivities() {
  AgentActivity.dismissEnded();
}

export function getAgentLiveActivities() {
  return AgentActivity.getInstances();
}

export function startAgentLiveActivity(props: AgentActivityProps, staleDate?: Date) {
  return AgentActivity.start(props, undefined, staleDate);
}

// Binaries built before expo-widgets exposed push-to-start throw here.
export function observeAgentLiveActivityPushToStartToken(listener: (token: string) => void) {
  return addPushToStartTokenListener((event) => listener(event.activityPushToStartToken));
}
