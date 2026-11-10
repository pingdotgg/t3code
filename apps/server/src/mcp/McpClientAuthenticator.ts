import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { HttpServerRequest } from "effect/http";
import type * as McpInvocationContext from "./McpInvocationContext.ts";

export class McpClientAuthenticator extends Context.Service<
  McpClientAuthenticator,
  {
    readonly authenticate: (
      request: HttpServerRequest.HttpServerRequest,
    ) => Effect.Effect<McpInvocationContext.McpInvocationScope | undefined>;
  }
>()("t3/mcp/McpClientAuthenticator") {}
