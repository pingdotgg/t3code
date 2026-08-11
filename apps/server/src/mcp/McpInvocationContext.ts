import {
  EnvironmentId,
  PreviewAutomationUnavailableError,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";

export type McpCapability = "preview" | "agents";

export interface McpInvocationScope {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly capabilities: ReadonlySet<McpCapability>;
  readonly issuedAt: number;
}

export class McpInvocationContext extends Context.Service<
  McpInvocationContext,
  McpInvocationScope
>()("t3/mcp/McpInvocationContext") {}

export class McpCapabilityUnavailableError extends Schema.TaggedErrorClass<McpCapabilityUnavailableError>()(
  "McpCapabilityUnavailableError",
  {
    capability: Schema.Literals(["preview", "agents"]),
    environmentId: EnvironmentId,
    threadId: ThreadId,
    providerSessionId: Schema.String,
    providerInstanceId: ProviderInstanceId,
  },
) {
  override get message(): string {
    return `MCP credential does not grant the ${this.capability} capability.`;
  }
}

const requirePreviewCapability = Effect.fn("mcp.requirePreviewCapability")(function* () {
  const invocation = yield* McpInvocationContext;
  if (!invocation.capabilities.has("preview")) {
    return yield* new PreviewAutomationUnavailableError({
      capability: "preview",
      environmentId: invocation.environmentId,
      threadId: invocation.threadId,
      providerSessionId: invocation.providerSessionId,
      providerInstanceId: invocation.providerInstanceId,
    });
  }
  return invocation;
});

const requireAgentsCapability = Effect.fn("mcp.requireAgentsCapability")(function* () {
  const invocation = yield* McpInvocationContext;
  if (!invocation.capabilities.has("agents")) {
    return yield* new McpCapabilityUnavailableError({
      capability: "agents",
      environmentId: invocation.environmentId,
      threadId: invocation.threadId,
      providerSessionId: invocation.providerSessionId,
      providerInstanceId: invocation.providerInstanceId,
    });
  }
  return invocation;
});

export function requireMcpCapability(
  capability: "preview",
): ReturnType<typeof requirePreviewCapability>;
export function requireMcpCapability(
  capability: "agents",
): ReturnType<typeof requireAgentsCapability>;
export function requireMcpCapability(capability: McpCapability) {
  return capability === "preview" ? requirePreviewCapability() : requireAgentsCapability();
}
