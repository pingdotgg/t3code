import type * as CodexSchema from "effect-codex-app-server/schema";
import type * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as Effect from "effect/Effect";

export const revertCodexThread = Effect.fn("revertCodexThread")(function* (
  client: Pick<CodexClient.CodexAppServerClient["Service"], "request">,
  threadId: string,
  numTurns: number,
) {
  let remaining = numTurns;
  let beforeTurnId: string | undefined;
  let cursor: string | null = null;
  const visited = new Set<string | null>();
  while (remaining > 0) {
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
      limit: Math.min(remaining, 100),
      sortDirection: "desc",
      itemsView: "summary",
    });
    for (const turn of page.data) {
      beforeTurnId = turn.id;
      if (--remaining === 0) break;
    }
    cursor = page.nextCursor ?? null;
    if (cursor === null) break;
  }
  return beforeTurnId === undefined
    ? yield* client.request("thread/read", { threadId, includeTurns: false })
    : yield* client.request("thread/revert", { threadId, beforeTurnId });
});

/**
 * Reverts the thread before the oldest of `laterTurnIds` that it still has,
 * never looking past the newest of `keptTurnIds`. It reads the history each
 * time, so repeating it after a revert that already happened, or whose
 * response was lost, removes nothing instead of earlier turns.
 */
export const revertCodexThreadAfter = Effect.fn("revertCodexThreadAfter")(function* (
  client: Pick<CodexClient.CodexAppServerClient["Service"], "request">,
  threadId: string,
  boundary: {
    readonly laterTurnIds: ReadonlySet<string>;
    readonly keptTurnIds: ReadonlySet<string>;
  },
) {
  let unseen = boundary.laterTurnIds.size;
  let beforeTurnId: string | undefined;
  let cursor: string | null = null;
  const visited = new Set<string | null>();
  scan: while (unseen > 0) {
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
      // The later turns, newest first, usually fill the first page; on a
      // repeat it starts with a kept turn instead.
      limit: cursor === null ? Math.min(unseen, 100) : 100,
      sortDirection: "desc",
      itemsView: "summary",
    });
    for (const turn of page.data) {
      if (boundary.keptTurnIds.has(turn.id)) break scan;
      if (!boundary.laterTurnIds.has(turn.id)) continue;
      beforeTurnId = turn.id;
      if (--unseen === 0) break scan;
    }
    cursor = page.nextCursor ?? null;
    if (cursor === null) break;
  }
  return beforeTurnId === undefined
    ? yield* client.request("thread/read", { threadId, includeTurns: false })
    : yield* client.request("thread/revert", { threadId, beforeTurnId });
});
