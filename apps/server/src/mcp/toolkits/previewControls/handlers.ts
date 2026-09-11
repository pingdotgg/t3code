import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Preview from "../../../preview/Manager.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import { requireMcpCapability } from "../../McpInvocationContext.ts";
import { unavailable } from "../../threadAccess.ts";
import { PreviewControlsToolkit } from "./tools.ts";

const access = Effect.gen(function* () {
  const scope = yield* requireMcpCapability("preview");
  const settings = yield* ServerSettings.ServerSettingsService;
  const current = yield* settings.getSettings.pipe(Effect.mapError(unavailable));
  if (!current.enableAgentBrowserAccess)
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "Agent browser access is disabled.",
    });
  return { scope, manager: yield* Preview.PreviewManager };
});
export const PreviewControlsHandlersLive = PreviewControlsToolkit.toLayer({
  t3_preview_list: (input) =>
    Effect.gen(function* () {
      const { scope, manager } = yield* access;
      const result = yield* manager.list({ threadId: scope.threadId });
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
        .close({ threadId: scope.threadId, tabId: input.tabId })
        .pipe(Effect.mapError(unavailable));
      return {};
    }),
});
