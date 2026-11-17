import { requireOptionalNativeModule } from "expo";

import { m, type MessageResolver } from "../i18n/messages";
import {
  agentActivityWidgetTimeline,
  type AgentActivityWidgetSource,
} from "./agentActivityWidgetTimeline";

let last: { readonly source: AgentActivityWidgetSource; readonly publishedAt: number } | null =
  null;

export async function publishAgentActivityWidget(
  source: AgentActivityWidgetSource,
  resolve: MessageResolver = m,
) {
  const publishedAt = Date.now();
  last = { source, publishedAt };
  await updateTimeline(source, publishedAt, resolve);
}

/** Re-renders the last published state for a UI language switch, keeping its stale deadline. */
export async function republishAgentActivityWidget(resolve: MessageResolver) {
  if (last !== null) await updateTimeline(last.source, last.publishedAt, resolve);
}

async function updateTimeline(
  source: AgentActivityWidgetSource,
  publishedAt: number,
  resolve: MessageResolver,
) {
  if (!requireOptionalNativeModule("ExpoWidgets")) return;
  const { default: widget } = await import("./AgentActivityWidget");
  widget.updateTimeline(agentActivityWidgetTimeline(source, publishedAt, resolve));
}
