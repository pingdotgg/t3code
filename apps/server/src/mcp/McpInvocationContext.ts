import {
  FileUploadCapabilityUnavailableError,
  type EnvironmentId,
  PreviewAutomationUnavailableError,
  type ProviderInstanceId,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";

export type McpCapability = "preview" | "file-upload";

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

export function requireMcpCapability(
  capability: "preview",
): Effect.Effect<McpInvocationScope, PreviewAutomationUnavailableError, McpInvocationContext>;
export function requireMcpCapability(
  capability: "file-upload",
): Effect.Effect<McpInvocationScope, FileUploadCapabilityUnavailableError, McpInvocationContext>;
export function requireMcpCapability(
  capability: McpCapability,
): Effect.Effect<
  McpInvocationScope,
  PreviewAutomationUnavailableError | FileUploadCapabilityUnavailableError,
  McpInvocationContext
> {
  return Effect.gen(function* () {
    const invocation = yield* McpInvocationContext;
    if (!invocation.capabilities.has(capability)) {
      if (capability === "file-upload") {
        return yield* new FileUploadCapabilityUnavailableError({
          environmentId: invocation.environmentId,
          threadId: invocation.threadId,
          providerSessionId: invocation.providerSessionId,
          providerInstanceId: invocation.providerInstanceId,
        });
      }
      return yield* new PreviewAutomationUnavailableError({
        capability,
        environmentId: invocation.environmentId,
        threadId: invocation.threadId,
        providerSessionId: invocation.providerSessionId,
        providerInstanceId: invocation.providerInstanceId,
      });
    }
    return invocation;
  });
}
