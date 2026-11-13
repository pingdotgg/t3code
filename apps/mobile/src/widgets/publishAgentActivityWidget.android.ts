import { requireOptionalNativeModule } from "expo";
import * as Linking from "expo-linking";

import {
  agentActivityWidgetSnapshot,
  type AgentActivityWidgetSource,
} from "./agentActivityWidgetTimeline";

let tapUrl: string | undefined;
let listening = false;

export async function publishAgentActivityWidget(source: AgentActivityWidgetSource) {
  if (!requireOptionalNativeModule("ExpoWidgets")) return;
  const [{ default: widget }, { addUserInteractionListener }] = await Promise.all([
    import("./AgentActivityWidget"),
    import("expo-widgets"),
  ]);
  const snapshot = agentActivityWidgetSnapshot(source, Date.now());
  const deepLink = snapshot.activities[0]?.deepLink;
  tapUrl = Linking.createURL(deepLink?.startsWith("/") ? deepLink.slice(1) : "");
  if (!listening) {
    // expo-widgets lacks Android widgetURL. Button events need a live JS runtime to open the app.
    listening = true;
    addUserInteractionListener((event) => {
      if (event.source === "AgentActivity" && tapUrl) void Linking.openURL(tapUrl);
    });
  }
  widget.updateSnapshot(snapshot);
  // Android lacks timelines; an alarm re-renders the snapshot when unfinished rows go out of date.
  requireOptionalNativeModule<{ schedule: (name: string, deadlines: number[]) => void }>(
    "T3WidgetExpiry",
  )?.schedule("AgentActivity", snapshot.stale ? [snapshot.stale.at] : []);
}
