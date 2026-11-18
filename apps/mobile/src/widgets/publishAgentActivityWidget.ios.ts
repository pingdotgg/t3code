import { observeAgentWidget } from "../features/agent-awareness/agentWidgetRefresh.ios";
import { m, type MessageResolver } from "../i18n/messages";
import type { AgentActivityProps } from "./AgentActivity";
import { agentActivityText } from "./agentActivityWidgetTimeline";

let last: AgentActivityProps | null = null;

export function publishAgentActivityWidget(
  props: AgentActivityProps,
  resolve: MessageResolver = m,
): boolean {
  const published = observeAgentWidget({
    ...props,
    text: agentActivityText(Math.max(props.activeCount ?? 0, props.activities.length), resolve),
  });
  if (published) last = props;
  return published;
}

/** Keeps the observation's original expiry when the UI language changes. */
export async function republishAgentActivityWidget(resolve: MessageResolver) {
  if (last !== null) publishAgentActivityWidget(last, resolve);
}
