import * as Context from "effect/Context";
import * as Fiber from "effect/Fiber";
import * as Schema from "effect/Schema";
import { McpSchema, Tool, Toolkit } from "effect/unstable/ai";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as MonitorSession from "../../MonitorSession.ts";

// MCP's discovery predicate is synchronous; read the authenticated request
// context from its current fiber rather than trusting client-supplied metadata.
const monitoringEnabled = () => {
  const fiber = Fiber.getCurrent();
  return (
    fiber !== undefined &&
    (Context.getOrUndefined(
      fiber.context,
      McpInvocationContext.McpInvocationContext,
    )?.capabilities.has("monitor") ??
      false)
  );
};

const parameters = Schema.Struct({
  processId: Schema.String.annotate({
    description: "The monitorId returned by monitor_start.",
  }),
});
const success = Schema.Struct({ processId: Schema.String, subscribed: Schema.Boolean });

export const MonitorStartTool = Tool.make("monitor_start", {
  description:
    "Start a background command that wakes a new agent turn when it emits a complete output line, exits, or fails to launch. Use this when asked to wait, watch, monitor, or notify later, including timers, instead of sleeping or polling in the current turn. Returns immediately; finish your turn after scheduling.",
  parameters: Schema.Struct({
    command: Schema.NonEmptyArray(Schema.String).annotate({
      description:
        "Executable and arguments. For Bash commands, use ['bash', '-c', 'sleep 30; echo done'].",
    }),
  }),
  success: Schema.Struct({ monitorId: Schema.String, status: Schema.Literal("scheduled") }),
  failure: MonitorSession.MonitorError,
  dependencies: [McpInvocationContext.McpInvocationContext, MonitorSession.MonitorSessions],
})
  .annotate(Tool.Title, "Monitor background process")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false)
  .annotate(Tool.OpenWorld, true)
  .annotate(McpSchema.EnabledWhen, monitoringEnabled);

export const MonitorUnsubscribeTool = Tool.make("monitor_unsubscribe", {
  description:
    "Unsubscribe from the background process selected by processId and discard its pending wakes. The process continues running.",
  parameters,
  success,
  failure: MonitorSession.MonitorError,
  dependencies: [McpInvocationContext.McpInvocationContext, MonitorSession.MonitorSessions],
})
  .annotate(Tool.Title, "Unsubscribe from background process")
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(McpSchema.EnabledWhen, monitoringEnabled);

export const MonitorToolkit = Toolkit.make(MonitorStartTool, MonitorUnsubscribeTool);
