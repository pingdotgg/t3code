import type { LiveActivity } from "expo-widgets";
import type { AgentActivityProps } from "../../widgets/AgentActivity";

/** Resolves without native work on platforms that do not support iOS Live Activities. */
export function dismissEndedAgentLiveActivities(): Promise<void> {
  return Promise.resolve();
}

/** Returns no cards on platforms without iOS Live Activity support. */
export function getAgentLiveActivities(): Array<LiveActivity<AgentActivityProps>> {
  return [];
}

/** Returns null without creating a card on platforms without iOS Live Activity support. */
export function startAgentLiveActivity(
  _props: AgentActivityProps,
): LiveActivity<AgentActivityProps> | null {
  return null;
}
