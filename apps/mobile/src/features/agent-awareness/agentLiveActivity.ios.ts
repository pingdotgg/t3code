import AgentActivity, {
  publishAgentActivityWidget,
  type AgentActivityProps,
} from "../../widgets/AgentActivity";

export { publishAgentActivityWidget };

export function getAgentLiveActivities() {
  return AgentActivity.getInstances();
}

export function startAgentLiveActivity(props: AgentActivityProps) {
  return AgentActivity.start(props);
}
