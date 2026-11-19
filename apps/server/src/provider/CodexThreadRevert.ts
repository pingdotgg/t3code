import type * as CodexSchema from "effect-codex-app-server/schema";
import type * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as Effect from "effect/Effect";

export const revertCodexThread = Effect.fn("revertCodexThread")(function* (
  client: Pick<CodexClient.CodexAppServerClient["Service"], "request">,
  threadId: string,
  boundary: number | { readonly afterTurnId: string },
) {
  let remaining = typeof boundary === "number" ? boundary : undefined;
  const afterTurnId = typeof boundary === "number" ? undefined : boundary.afterTurnId;
  let beforeTurnId: string | undefined;
  let cursor: string | null = null;
  const visited = new Set<string | null>();
  let found = afterTurnId === undefined;
  scan: while (remaining === undefined || remaining > 0) {
    if (visited.has(cursor)) {
      return yield* CodexErrors.CodexAppServerRequestError.internalError(
        "Thread history pagination repeated a cursor.",
        undefined,
        { method: "thread/turns/list", operation: "decode-payload" },
      );
    }
    visited.add(cursor);
    const page: CodexSchema.V2ThreadTurnsListResponse = yield* client.request("thread/turns/list", {
      threadId,
      cursor,
      limit: remaining === undefined ? 32 : Math.min(remaining, 100),
      sortDirection: "desc",
      itemsView: afterTurnId === undefined ? "summary" : "notLoaded",
    });
    for (const turn of page.data) {
      if (turn.id === afterTurnId) {
        found = true;
        break scan;
      }
      beforeTurnId = turn.id;
      if (remaining !== undefined && --remaining === 0) break scan;
    }
    cursor = page.nextCursor ?? null;
    if (cursor === null) break;
  }
  if (!found) {
    return yield* CodexErrors.CodexAppServerRequestError.internalError(
      `Checkpoint turn ${afterTurnId} is missing from the native Codex history.`,
      undefined,
      { method: "thread/turns/list", operation: "decode-payload" },
    );
  }
  return beforeTurnId === undefined
    ? yield* client.request("thread/read", { threadId, includeTurns: false })
    : yield* client.request("thread/revert", { threadId, beforeTurnId });
});
