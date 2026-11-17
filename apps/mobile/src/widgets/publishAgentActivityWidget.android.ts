import { requireOptionalNativeModule } from "expo";
import * as Linking from "expo-linking";

import {
  agentActivityWidgetSnapshot,
  type AgentActivityWidgetSource,
} from "./agentActivityWidgetTimeline";

export async function publishAgentActivityWidget(source: AgentActivityWidgetSource) {
  if (!requireOptionalNativeModule("ExpoWidgets")) return;
  const { default: widget } = await import("./AgentActivityWidget");
  const snapshot = {
    ...agentActivityWidgetSnapshot(source, Date.now()),
    appUrl: Linking.createURL(""),
  };
  widget.updateSnapshot(snapshot);
  // Android lacks timelines; an alarm re-renders the snapshot when unfinished rows go out of date.
  requireOptionalNativeModule<{ schedule: (name: string, deadlines: number[]) => void }>(
    "T3WidgetExpiry",
  )?.schedule("AgentActivity", snapshot.stale ? [snapshot.stale.at] : []);
}
