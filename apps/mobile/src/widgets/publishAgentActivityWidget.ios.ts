import { requireOptionalNativeModule } from "expo";

import { m, type MessageResolver } from "../i18n/messages";
import {
  agentActivityWidgetTimeline,
  type AgentActivityWidgetSource,
} from "./agentActivityWidgetTimeline";

let lastSource: AgentActivityWidgetSource | null = null;

export async function publishAgentActivityWidget(
  source: AgentActivityWidgetSource,
  resolve: MessageResolver = m,
) {
  lastSource = source;
  if (!requireOptionalNativeModule("ExpoWidgets")) return;
  const { default: widget } = await import("./AgentActivityWidget");
  widget.updateTimeline(agentActivityWidgetTimeline(source, Date.now(), resolve));
}

/** Re-renders the last published state, for a UI language switch. */
export async function republishAgentActivityWidget(resolve: MessageResolver) {
  if (lastSource !== null) await publishAgentActivityWidget(lastSource, resolve);
}
