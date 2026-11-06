import type { AgentActivityProps } from "../../widgets/AgentActivity";
import { requireOptionalNativeModule } from "expo";
import { agentActivityTimeline } from "../../widgets/agentActivityTimeline";

const native = requireOptionalNativeModule<{
  observeAgentWidget(props: string, timeline: string): boolean;
  agentWidgetToken(identity: string): string | null;
  configureAgentWidgetRefresh(url: string, token: string): void;
  clearAgentWidgetRefresh(): void;
}>("T3NativeControls");

export function agentWidgetToken(identity: string): string | null {
  return native?.agentWidgetToken?.(identity) ?? null;
}

export function configureAgentWidgetRefresh(relayUrl: string, token: string): void {
  native?.configureAgentWidgetRefresh?.(
    new URL("v1/widget/agent-activity", `${relayUrl.replace(/\/$/, "")}/`).href,
    token,
  );
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
