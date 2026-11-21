import type { LiveActivity } from "expo-widgets";
import type { AgentActivityProps } from "../../widgets/AgentActivity";

export function dismissEndedAgentLiveActivities(): void {}

export function builtinGetAgentLiveActivities(): Array<LiveActivity<AgentActivityProps>> {
  return [];
}

export function builtinStartAgentLiveActivity(
  _props: AgentActivityProps,
  _staleDate?: Date,
): LiveActivity<AgentActivityProps> | null {
  return null;
}
