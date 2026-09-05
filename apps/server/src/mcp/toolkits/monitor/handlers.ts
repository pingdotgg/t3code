import * as Effect from "effect/Effect";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as MonitorSession from "../../MonitorSession.ts";
import { MonitorToolkit } from "./tools.ts";

const invoke = Effect.fn("MonitorToolkit.invoke")(function* (
  operation: "subscribe" | "unsubscribe",
  processId: string,
) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  const sessions = yield* MonitorSession.MonitorSessions;
  if (!scope.capabilities.has("monitor"))
    return yield* new MonitorSession.MonitorCapabilityError({});
  return yield* sessions.invoke(scope.providerSessionId, operation, processId);
});

export const MonitorToolkitHandlersLive = MonitorToolkit.toLayer({
  monitor_subscribe: ({ processId }) => invoke("subscribe", processId),
  monitor_unsubscribe: ({ processId }) => invoke("unsubscribe", processId),
});
