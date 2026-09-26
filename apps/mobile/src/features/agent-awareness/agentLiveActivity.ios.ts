import AgentActivity, { type AgentActivityProps } from "../../widgets/AgentActivity";

/** Dismisses ended T3 cards still visible on the Lock Screen, preserving active and stale cards. */
export function dismissEndedAgentLiveActivities(): Promise<void> {
  return AgentActivity.dismissEndedInstances();
}

/** Returns active and stale T3 cards; ended cards require the separate native dismissal pass. */
export function getAgentLiveActivities() {
  return AgentActivity.getInstances();
}

/** Starts a T3 card while the app is foregrounded so its update token can be registered. */
export function startAgentLiveActivity(props: AgentActivityProps) {
  return AgentActivity.start(props);
}
