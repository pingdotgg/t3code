import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import * as McpToolExposure from "../../McpToolExposure.ts";
import { ToolSearchToolkit } from "./tools.ts";

export const layer = McpToolAccess.toLayer(ToolSearchToolkit, {
  tool_search: McpToolAccess.readsAsCaller(({ query }) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext.pipe(
        Effect.flatMap((current) =>
          McpInvocationContext.requireThreadScope(current, "tool_search"),
        ),
      );
      const exposure = yield* McpToolExposure.McpToolExposure;
      return {
        tools: yield* exposure.search(scope.thread.providerSessionId, query, {
          mode: scope.toolExposure,
        }),
      };
    }),
  ),
});
