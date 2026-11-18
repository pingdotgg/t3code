import type { MessageResolver } from "../i18n/messages";
import type { AgentActivityWidgetSource } from "./agentActivityWidgetTimeline";

export async function publishAgentActivityWidget(
  _source: AgentActivityWidgetSource,
  _resolve?: MessageResolver,
) {}

export async function republishAgentActivityWidget(_resolve: MessageResolver) {}
