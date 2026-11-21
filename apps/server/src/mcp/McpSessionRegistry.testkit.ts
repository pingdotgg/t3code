import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as McpSessionRegistry from "./McpSessionRegistry.ts";

export const layer = Layer.succeed(
  McpSessionRegistry.McpSessionRegistry,
  McpSessionRegistry.McpSessionRegistry.of({
    issue: ({ threadId, providerInstanceId, providerSessionId }) =>
      Effect.succeed({
        config: {
          environmentId: EnvironmentId.make("environment:mcp-test"),
          threadId,
          providerSessionId: providerSessionId ?? `mcp-test:${threadId}`,
          credentialId: `mcp-test-cred:${threadId}`,
          providerInstanceId,
          endpoint: "http://127.0.0.1/mcp",
          authorizationHeader: `Bearer mcp-test:${threadId}`,
          browserToolsAvailable: true,
        },
      }),
    resolve: () => Effect.undefined,
    touch: () => Effect.void,
    revokeCredential: () => Effect.void,
    releaseRunBinding: () => Effect.void,
    syncCapabilities: () => Effect.undefined,
    revokeProviderSession: () => Effect.void,
    revokeThread: () => Effect.void,
    revokeAll: Effect.void,
  }),
);
