import {
  PREVIEW_MCP_LIST_DEFAULT_LIMIT,
  PreviewAutomationUnavailableError,
  PreviewMcpInvalidCursorError,
  PreviewSessionLookupError,
  PreviewTabId,
  type PreviewMcpCloseInput,
  type PreviewMcpCloseResult,
  type PreviewMcpError,
  type PreviewMcpListInput,
  type PreviewMcpListResult,
  type ThreadId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as PreviewManager from "../preview/Manager.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";

const encodeCursor = (threadId: ThreadId, tabId: PreviewTabId): string =>
  Buffer.from(`${threadId}\u0000${tabId}`, "utf8").toString("base64url");

const isPreviewTabId = Schema.is(PreviewTabId);

const decodeCursor = Effect.fn("PreviewMcpService.decodeCursor")(function* (
  threadId: ThreadId,
  cursor: string,
) {
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const separator = decoded.indexOf("\u0000");
  const cursorThreadId = decoded.slice(0, separator);
  const tabId = decoded.slice(separator + 1);
  if (
    separator <= 0 ||
    cursorThreadId !== threadId ||
    !isPreviewTabId(tabId) ||
    encodeCursor(threadId, tabId) !== cursor
  ) {
    return yield* new PreviewMcpInvalidCursorError({ cursorLength: cursor.length });
  }
  return tabId;
});

export class PreviewMcpService extends Context.Service<
  PreviewMcpService,
  {
    readonly list: (
      scope: McpInvocationScope,
      input: PreviewMcpListInput,
    ) => Effect.Effect<PreviewMcpListResult, PreviewMcpError>;
    readonly close: (
      scope: McpInvocationScope,
      input: PreviewMcpCloseInput,
    ) => Effect.Effect<PreviewMcpCloseResult, PreviewMcpError>;
  }
>()("t3/mcp/PreviewMcpService") {}

export const make = Effect.gen(function* PreviewMcpServiceMake() {
  const manager = yield* PreviewManager.PreviewManager;
  const broker = yield* PreviewAutomationBroker.PreviewAutomationBroker;

  const requirePreviewScope = Effect.fn("PreviewMcpService.requirePreviewScope")(function* (
    scope: McpInvocationScope,
  ) {
    if (!scope.capabilities.has("preview")) {
      return yield* new PreviewAutomationUnavailableError({
        capability: "preview",
        environmentId: scope.environmentId,
        threadId: scope.threadId,
        providerSessionId: scope.providerSessionId,
        providerInstanceId: scope.providerInstanceId,
      });
    }
    return scope;
  });

  const list: PreviewMcpService["Service"]["list"] = Effect.fn("PreviewMcpService.list")(
    function* (inputScope, input) {
      const scope = yield* requirePreviewScope(inputScope);
      const boundary = input.cursor ? yield* decodeCursor(scope.threadId, input.cursor) : undefined;
      const limit = input.limit ?? PREVIEW_MCP_LIST_DEFAULT_LIMIT;
      const state = yield* manager.list({ threadId: scope.threadId });
      const candidates = state.sessions
        .toSorted((left, right) => left.tabId.localeCompare(right.tabId))
        .filter((session) => boundary === undefined || session.tabId > boundary)
        .slice(0, limit + 1);
      const sessions = candidates.slice(0, limit);
      const hasMore = candidates.length > limit;
      const last = sessions.at(-1);
      return {
        sessions,
        nextCursor: hasMore && last ? encodeCursor(scope.threadId, last.tabId) : null,
        serverEpoch: state.serverEpoch,
        revision: state.revision,
      };
    },
  );

  const close: PreviewMcpService["Service"]["close"] = Effect.fn("PreviewMcpService.close")(
    function* (inputScope, input) {
      const scope = yield* requirePreviewScope(inputScope);
      const closed = yield* manager.closeExact({ threadId: scope.threadId, tabId: input.tabId });
      if (!closed) {
        return yield* new PreviewSessionLookupError({
          threadId: scope.threadId,
          tabId: input.tabId,
        });
      }
      yield* broker.forgetClosedTab(scope, input.tabId);
      return { tabId: input.tabId, closed: true };
    },
  );

  return PreviewMcpService.of({ list, close });
}).pipe(Effect.withSpan("PreviewMcpService.make"));

export const layer = Layer.effect(PreviewMcpService, make);
