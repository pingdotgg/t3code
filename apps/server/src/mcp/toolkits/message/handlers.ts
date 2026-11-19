import * as McpProviderSessions from "@t3tools/provider-core/server/McpProviderSessions";
import { SEND_TO_USER_TOOL_NAME } from "@t3tools/shared/toolOutput";
import * as Effect from "effect/Effect";

import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { MessageToolkit } from "./tools.ts";

const handlers = {
  send_to_user: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const { thread } = yield* McpInvocationContext.requireThreadScope(
        scope,
        SEND_TO_USER_TOOL_NAME,
      );
      const mcpSessions = yield* McpProviderSessions.McpProviderSessions;
      yield* mcpSessions.recordSentMessage(thread.threadId, input.message);
      return {
        sentMessage: input.message,
        message: "Shown to the user. Don't repeat it.",
      };
    }),
  ),
} satisfies McpToolAccess.Handlers<typeof MessageToolkit.tools>;

export const layer = McpToolAccess.toLayer(MessageToolkit, handlers);
