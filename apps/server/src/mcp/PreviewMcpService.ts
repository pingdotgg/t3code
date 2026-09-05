import {
  PREVIEW_MCP_NAV_DIAGNOSTIC_MAX_LENGTH,
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
  type PreviewMcpSessionSnapshot,
  type PreviewSessionSnapshot,
  type ThreadId,
} from "@t3tools/contracts";
import * as NodeCrypto from "node:crypto";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";

import * as PreviewManager from "../preview/Manager.ts";
import type { McpInvocationScope } from "./McpInvocationContext.ts";
import * as PreviewAutomationBroker from "./PreviewAutomationBroker.ts";

const cursorThreadScope = (threadId: ThreadId): string =>
  NodeCrypto.createHash("sha256").update(threadId).digest("base64url");

const encodeCursor = (threadId: ThreadId, tabId: PreviewTabId): string =>
  Buffer.from(`v1\u0000${cursorThreadScope(threadId)}\u0000${tabId}`, "utf8").toString("base64url");

const compareTabIds = (left: PreviewTabId, right: PreviewTabId): number =>
  left < right ? -1 : left > right ? 1 : 0;

const isPreviewTabId = Schema.is(PreviewTabId);

const decodeCursor = Effect.fn("PreviewMcpService.decodeCursor")(function* (
  threadId: ThreadId,
  cursor: string,
) {
  const decoded = Buffer.from(cursor, "base64url").toString("utf8");
  const [version, scopeHash, tabId, ...rest] = decoded.split("\u0000");
  if (
    version !== "v1" ||
    scopeHash !== cursorThreadScope(threadId) ||
    rest.length > 0 ||
    !isPreviewTabId(tabId) ||
    encodeCursor(threadId, tabId) !== cursor
  ) {
    return yield* new PreviewMcpInvalidCursorError({ cursorLength: cursor.length });
  }
  return tabId;
});

const projectSession = (session: PreviewSessionSnapshot): PreviewMcpSessionSnapshot => {
  if (session.navStatus._tag !== "LoadFailed") {
    return { ...session, navStatus: session.navStatus };
  }
  const descriptionTruncated =
    session.navStatus.description.length > PREVIEW_MCP_NAV_DIAGNOSTIC_MAX_LENGTH;
  return {
    ...session,
    navStatus: {
      ...session.navStatus,
      description: descriptionTruncated
        ? session.navStatus.description.slice(0, PREVIEW_MCP_NAV_DIAGNOSTIC_MAX_LENGTH)
        : session.navStatus.description,
      descriptionTruncated,
    },
  };
};

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
        .toSorted((left, right) => compareTabIds(left.tabId, right.tabId))
        .filter((session) => boundary === undefined || compareTabIds(session.tabId, boundary) > 0)
        .slice(0, limit + 1);
      const sessions = candidates.slice(0, limit).map(projectSession);
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
      return yield* Effect.uninterruptible(
        Effect.gen(function* () {
          const closed = yield* manager.closeExact({
            threadId: scope.threadId,
            tabId: input.tabId,
          });
          if (!closed) {
            return yield* new PreviewSessionLookupError({
              threadId: scope.threadId,
              tabId: input.tabId,
            });
          }
          yield* broker.forgetClosedTab(scope, input.tabId);
          return { tabId: input.tabId, closed: true } as const;
        }),
      );
    },
  );

  return PreviewMcpService.of({ list, close });
}).pipe(Effect.withSpan("PreviewMcpService.make"));

export const layer = Layer.effect(PreviewMcpService, make);
