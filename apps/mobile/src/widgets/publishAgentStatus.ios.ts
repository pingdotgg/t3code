import { requireOptionalNativeModule } from "expo";

import { agentStatusTimeline, type AgentStatusSnapshot } from "./agentStatusSnapshot";

// Loading the module stores the widget's layout; reloading then shows the
// "Open T3 Code" state until an environment connects and the first snapshot lands.
const widget = requireOptionalNativeModule("ExpoWidgets")
  ? import("./AgentStatus")
      .then(({ default: agentStatus }) => {
        agentStatus.reload();
        return agentStatus;
      })
      .catch((error: unknown) => {
        console.warn("Could not load agent status widget", error);
        return null;
      })
  : null;

export async function publishAgentStatus(snapshot: AgentStatusSnapshot) {
  (await widget)?.updateTimeline(agentStatusTimeline(snapshot));
}
