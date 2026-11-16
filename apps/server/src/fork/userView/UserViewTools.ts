import {
  OrchestratorMcpFailure,
  THREAD_USER_VIEW_TOOL_NAME,
  ThreadUserViewInput,
  ThreadUserViewResult,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import { Tool, Toolkit } from "effect/ai";

import * as McpInvocationContext from "../../mcp/McpInvocationContext.ts";
import * as McpToolAccess from "../../mcp/McpToolAccess.ts";
import { UserView } from "./UserView.ts";
import { selectionOf } from "./userViewText.ts";

const UserViewTool = Tool.make(THREAD_USER_VIEW_TOOL_NAME, {
  description:
    "Read a thread word for word as the user's screen shows it in Chat mode: the latest main-list messages, or with subThread, a sub-thread and the main-list messages before it. Omit threadId for your own thread. To hand this text to another agent unchanged, give it the result's Pinned line (and any Earlier line), not a copy.",
  parameters: ThreadUserViewInput,
  success: ThreadUserViewResult,
  failure: OrchestratorMcpFailure,
  dependencies: [McpInvocationContext.McpInvocationContext, UserView],
})
  .annotate(Tool.Title, "Read a thread as the user sees it")
  .annotate(Tool.Readonly, true)
  .annotate(Tool.Destructive, false)
  .annotate(Tool.Idempotent, true)
  .annotate(Tool.OpenWorld, false);

export const UserViewToolkit = Toolkit.make(UserViewTool);

const view = Effect.fn("UserViewTools.view")(function* (
  input: Omit<ThreadUserViewInput, "environmentId">,
) {
  const scope = yield* McpInvocationContext.McpInvocationContext;
  if (!scope.capabilities.has("orchestration"))
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This MCP credential does not grant orchestration capabilities.",
    });
  const threadId =
    input.threadId ??
    (yield* McpInvocationContext.requireThreadScope(scope, "Reading your own thread")).thread
      .threadId;
  const text = yield* (yield* UserView)
    .read({
      threadId,
      environmentId: scope.environmentId,
      selection: selectionOf(input),
      expect: input.expect,
    })
    .pipe(
      Effect.mapError(
        (error) =>
          new OrchestratorMcpFailure(
            error._tag === "UserViewRefused"
              ? { code: "invalid_request", message: `Refused: ${error.reason}` }
              : { code: "orchestration_error", message: error.message },
          ),
      ),
    );
  return { text };
});

export const layerHandlers = McpToolAccess.toLayer(UserViewToolkit, {
  [THREAD_USER_VIEW_TOOL_NAME]: McpToolAccess.either(
    (input) => input.threadId !== undefined,
    McpToolAccess.reads(view),
    McpToolAccess.readsAsCaller(view),
  ),
});
