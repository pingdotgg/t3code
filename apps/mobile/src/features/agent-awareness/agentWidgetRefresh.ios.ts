import type { AgentActivityProps } from "../../widgets/AgentActivity";
import { requireOptionalNativeModule } from "expo";
import { agentActivityTimeline } from "../../widgets/agentActivityTimeline";

const native = requireOptionalNativeModule<{
  observeAgentWidget(props: string, timeline: string): boolean;
  agentWidgetToken(identity: string, url: string | null): string | null;
  configureAgentWidgetRefresh(url: string, token: string): void;
  clearAgentWidgetRefresh(): void;
}>("T3NativeControls");

export function agentWidgetToken(identity: string, relayUrl?: string): string | null {
  return native?.agentWidgetToken?.(identity, relayUrl ? widgetRefreshUrl(relayUrl) : null) ?? null;
}

export function configureAgentWidgetRefresh(relayUrl: string, token: string): void {
  native?.configureAgentWidgetRefresh?.(widgetRefreshUrl(relayUrl), token);
}

export function clearAgentWidgetRefresh(): void {
  native?.clearAgentWidgetRefresh?.();
}

export function observeAgentWidget(props: AgentActivityProps): boolean {
  return (
    native?.observeAgentWidget?.(
      JSON.stringify(props),
      JSON.stringify(
        agentActivityTimeline(props, Date.now()).map(({ date, props }) => ({
          timestamp: date.getTime(),
          props,
        })),
      ),
    ) ?? false
  );
}

function widgetRefreshUrl(relayUrl: string): string {
  return new URL("v1/widget/agent-activity", `${relayUrl.replace(/\/$/, "")}/`).href;
}
