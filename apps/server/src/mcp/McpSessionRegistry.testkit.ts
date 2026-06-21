import { EnvironmentId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { McpSessionRegistry } from "./McpSessionRegistry.ts";

export const layer = Layer.succeed(
  McpSessionRegistry,
  McpSessionRegistry.of({
    issue: ({ threadId, providerInstanceId }) =>
      Effect.succeed({
        config: {
          environmentId: EnvironmentId.make("environment:mcp-test"),
          threadId,
          providerSessionId: `mcp-test:${threadId}`,
          providerInstanceId,
          endpoint: "http://127.0.0.1/mcp",
          authorizationHeader: `Bearer mcp-test:${threadId}`,
        },
      }),
    resolve: () => Effect.succeed(undefined),
    revokeProviderSession: () => Effect.void,
    revokeThread: () => Effect.void,
    revokeAll: Effect.succeed(undefined),
  }),
);
