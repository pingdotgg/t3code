import type { AgentActivityProps } from "../../widgets/AgentActivity";
import { requireOptionalNativeModule } from "expo";

const native = requireOptionalNativeModule<{
  observeAgentWidget(props: string): void;
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

export function observeAgentWidget(props: AgentActivityProps): void {
  native?.observeAgentWidget?.(JSON.stringify(props));
}
