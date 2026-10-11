import * as Effect from "effect/Effect";
import * as Preview from "../../../preview/Manager.ts";
import { requireThreadMcpCapability } from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { unavailable } from "../../threadAccess.ts";
import { PreviewControlsToolkit } from "./tools.ts";
import * as PreviewAutomationBroker from "../../PreviewAutomationBroker.ts";

const access = Effect.gen(function* () {
  // The preview capability already reflects the calling project's access setting.
  const scope = yield* requireThreadMcpCapability("preview");
  return { scope, manager: yield* Preview.PreviewManager };
});
export const layer = McpToolAccess.toLayer(PreviewControlsToolkit, {
  t3_preview_list: McpToolAccess.readsAsCaller((input) =>
    Effect.gen(function* () {
      const { scope, manager } = yield* access;
      const result = yield* manager.list({ threadId: scope.thread.threadId });
      const start = input.cursor ?? 0;
      const end = start + (input.limit ?? 20);
      return {
        ...result,
        sessions: result.sessions.slice(start, end),
        nextCursor: end < result.sessions.length ? end : null,
      };
    }),
  ),
  t3_preview_close: McpToolAccess.actsAsCaller((input) =>
    Effect.gen(function* () {
      const { scope, manager } = yield* access;
      const { sessions } = yield* manager.list({ threadId: scope.thread.threadId });
      if (
        sessions.some((session) => session.tabId === input.tabId && session.runtime === "server")
      ) {
        const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;
        yield* broker
          .invoke({ scope, operation: "close", input: {}, tabId: input.tabId })
          .pipe(Effect.mapError(unavailable));
        return {};
      }
      yield* manager
        .close({ threadId: scope.thread.threadId, tabId: input.tabId })
        .pipe(Effect.mapError(unavailable));
      return {};
    }),
  ),
});
