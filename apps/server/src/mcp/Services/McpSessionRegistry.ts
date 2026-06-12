import type { ProviderInstanceId, ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";

import type { McpInvocationScope } from "./McpInvocationContext.ts";
import type { McpProviderSessionConfig } from "./McpProviderSession.ts";

export interface McpCredentialRequest {
  readonly threadId: ThreadId;
  readonly providerInstanceId: ProviderInstanceId;
}

export interface McpIssuedCredential {
  readonly config: McpProviderSessionConfig;
  readonly expiresAt: number;
}

export interface McpSessionRegistryShape {
  readonly issue: (request: McpCredentialRequest) => Effect.Effect<McpIssuedCredential, never>;
  readonly resolve: (rawToken: string) => Effect.Effect<McpInvocationScope | undefined, never>;
  readonly revokeProviderSession: (providerSessionId: string) => Effect.Effect<void>;
  readonly revokeThread: (threadId: ThreadId) => Effect.Effect<void>;
  readonly revokeAll: Effect.Effect<void>;
}

export class McpSessionRegistry extends Context.Service<
  McpSessionRegistry,
  McpSessionRegistryShape
>()("t3/mcp/Services/McpSessionRegistry") {}
