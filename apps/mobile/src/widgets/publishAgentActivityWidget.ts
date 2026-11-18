import type { MessageResolver } from "../i18n/messages";
import type { AgentActivityProps } from "./AgentActivity";

export function publishAgentActivityWidget(
  _props: AgentActivityProps,
  _resolve?: MessageResolver,
): boolean {
  return false;
}

export async function republishAgentActivityWidget(_resolve: MessageResolver) {}
