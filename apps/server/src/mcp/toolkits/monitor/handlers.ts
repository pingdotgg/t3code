import * as Effect from "effect/Effect";
import { McpInvocationContext } from "../../McpInvocationContext.ts";
import { invokeMonitorSession, MonitorUnavailableError } from "../../MonitorSession.ts";
import { MonitorToolkit } from "./tools.ts";

const invoke = Effect.fn("MonitorToolkit.invoke")(function* (
  operation: "subscribe" | "unsubscribe",
  processId: string,
) {
  const scope = yield* McpInvocationContext;
  if (!scope.capabilities.has("monitor"))
    return yield* new MonitorUnavailableError({
      message: "Monitoring is unavailable for this provider session.",
    });
  return yield* invokeMonitorSession(scope.providerSessionId, operation, processId);
});

export const MonitorToolkitHandlersLive = MonitorToolkit.toLayer({
  monitor_subscribe: ({ processId }) => invoke("subscribe", processId),
  monitor_unsubscribe: ({ processId }) => invoke("unsubscribe", processId),
});
