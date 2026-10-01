import type { LiveActivity } from "expo-widgets";
import type { AgentActivityProps } from "../../widgets/AgentActivity";

export function getAgentLiveActivities(): Array<LiveActivity<AgentActivityProps>> {
  return [];
}

export function startAgentLiveActivity(
  _props: AgentActivityProps,
  _staleDate?: Date,
): LiveActivity<AgentActivityProps> | null {
  return null;
}
