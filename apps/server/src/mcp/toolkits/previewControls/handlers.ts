import * as Effect from "effect/Effect";
import * as Preview from "../../../preview/Manager.ts";
import { requireThreadMcpCapability } from "../../McpInvocationContext.ts";
import { unavailable } from "../../threadAccess.ts";
import { PreviewControlsToolkit } from "./tools.ts";

const access = Effect.gen(function* () {
  // The preview capability already reflects the calling project's access setting.
  const scope = yield* requireThreadMcpCapability("preview");
  return { scope, manager: yield* Preview.PreviewManager };
});
export const layer = PreviewControlsToolkit.toLayer({
  t3_preview_list: (input) =>
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
  t3_preview_close: (input) =>
    Effect.gen(function* () {
      const { scope, manager } = yield* access;
      yield* manager
        .close({ threadId: scope.thread.threadId, tabId: input.tabId })
        .pipe(Effect.mapError(unavailable));
      return {};
    }),
});
