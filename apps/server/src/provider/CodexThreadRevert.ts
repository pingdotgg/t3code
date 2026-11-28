import type * as CodexSchema from "effect-codex-app-server/schema";
import type * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import * as Effect from "effect/Effect";

type CodexRevertClient = Pick<CodexClient.CodexAppServerClient["Service"], "request">;

const repeatedCursorError = () =>
  CodexErrors.CodexAppServerRequestError.internalError(
    "Thread history pagination repeated a cursor.",
    undefined,
    { method: "thread/turns/list", operation: "decode-payload" },
  );

export const revertCodexThread = Effect.fn("revertCodexThread")(function* (
  client: CodexRevertClient,
  threadId: string,
  numTurns: number,
) {
  let remaining = numTurns;
  let beforeTurnId: string | undefined;
  let cursor: string | null = null;
  const visited = new Set<string | null>();
  while (remaining > 0) {
    if (visited.has(cursor)) {
      return yield* repeatedCursorError();
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
 * Reverts every turn newer than `keptTurnId` in the live thread. Unlike a turn count, this is
 * safe to retry: once the kept turn is the newest, nothing more is reverted.
 */
export const revertCodexThreadAfterTurn = Effect.fn("revertCodexThreadAfterTurn")(function* (
  client: CodexRevertClient,
  threadId: string,
  keptTurnId: string,
  expectedRevertedTurns: number,
) {
  let oldestRevertedTurnId: string | undefined;
  let cursor: string | null = null;
  const visited = new Set<string | null>();
  while (true) {
    if (visited.has(cursor)) {
      return yield* repeatedCursorError();
    }
    visited.add(cursor);
    const page: CodexSchema.V2ThreadTurnsListResponse = yield* client.request("thread/turns/list", {
      threadId,
      cursor,
      limit: Math.min(expectedRevertedTurns + 1, 100),
      sortDirection: "desc",
      itemsView: "summary",
    });
    for (const turn of page.data) {
      if (turn.id === keptTurnId) {
        return oldestRevertedTurnId === undefined
          ? yield* client.request("thread/read", { threadId, includeTurns: false })
          : yield* client.request("thread/revert", {
              threadId,
              beforeTurnId: oldestRevertedTurnId,
            });
      }
      oldestRevertedTurnId = turn.id;
    }
    cursor = page.nextCursor ?? null;
    if (cursor === null) {
      return yield* CodexErrors.CodexAppServerRequestError.internalError(
        `Turn ${keptTurnId} is not in Codex thread ${threadId}.`,
        undefined,
        { method: "thread/turns/list", operation: "decode-payload" },
      );
    }
  }
});

/** Rewind from the oldest recorded T3 turn still present in Codex's history. */
export const revertCodexThreadFromKnownTurns = Effect.fn("revertCodexThreadFromKnownTurns")(
  function* (client: CodexRevertClient, threadId: string, nativeTurnIds: ReadonlyArray<string>) {
    const remaining = new Set(nativeTurnIds);
    let beforeTurnId: string | undefined;
    let cursor: string | null = null;
    const visited = new Set<string | null>();
    while (remaining.size > 0) {
      if (visited.has(cursor)) return yield* repeatedCursorError();
      visited.add(cursor);
      const page: CodexSchema.V2ThreadTurnsListResponse = yield* client.request(
        "thread/turns/list",
        {
          threadId,
          cursor,
          limit: 100,
          sortDirection: "desc",
          itemsView: "summary",
        },
      );
      for (const turn of page.data) {
        if (remaining.delete(turn.id)) beforeTurnId = turn.id;
      }
      cursor = page.nextCursor ?? null;
      if (cursor === null) break;
    }

    return beforeTurnId === undefined
      ? yield* client.request("thread/read", { threadId, includeTurns: false })
      : yield* client.request("thread/revert", { threadId, beforeTurnId });
  },
);
