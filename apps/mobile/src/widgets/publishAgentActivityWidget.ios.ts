import { requireOptionalNativeModule } from "expo";

import {
  agentActivityWidgetTimeline,
  type AgentActivityWidgetSource,
} from "./agentActivityWidgetTimeline";

export async function publishAgentActivityWidget(source: AgentActivityWidgetSource) {
  if (!requireOptionalNativeModule("ExpoWidgets")) return;
  const { default: widget } = await import("./AgentActivityWidget");
  widget.updateTimeline(agentActivityWidgetTimeline(source, Date.now()));
}
