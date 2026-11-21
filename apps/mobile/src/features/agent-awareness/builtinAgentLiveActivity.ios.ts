import AgentActivity, { type AgentActivityProps } from "../../widgets/AgentActivity";

export function dismissEndedAgentLiveActivities() {
  AgentActivity.dismissEnded();
}

export function builtinGetAgentLiveActivities() {
  return AgentActivity.getInstances();
}

export function builtinStartAgentLiveActivity(props: AgentActivityProps, staleDate?: Date) {
  return AgentActivity.start(props, undefined, staleDate);
}
