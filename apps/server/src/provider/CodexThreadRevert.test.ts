import { assert, it } from "@effect/vitest";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexReplay from "effect-codex-app-server/replay";
import * as Effect from "effect/Effect";

import {
  revertCodexThread,
  revertCodexThreadAfterTurn,
  revertCodexThreadFromKnownTurns,
} from "./CodexThreadRevert.ts";

const page = (
  id: number,
  cursor: string | null,
  limit: number,
  turns: string[],
  nextCursor: string | null,
) => [
  {
    type: "expect_outbound" as const,
    frame: {
      id,
      method: "thread/turns/list",
      params: {
        threadId: "thread",
        cursor,
        limit,
        sortDirection: "desc",
        itemsView: "summary",
      },
    },
  },
  {
    type: "emit_inbound" as const,
    frame: {
      id,
      result: {
        data: turns.map((id) => ({ id, items: [], status: "completed", error: null })),
        nextCursor,
      },
    },
  },
];

it.effect("finds the revert boundary across pages of newest-first turns", () =>
  Effect.gen(function* () {
    const client = yield* CodexClient.CodexAppServerClient;
    const result = yield* revertCodexThread(client, "thread", 3).pipe(Effect.flip);
    assert.equal(result.message, "boundary reached");
  }).pipe(
    Effect.provide(
      CodexReplay.layerReplay({
        provider: "codex",
        protocol: "codex.app-server",
        version: "test",
        scenario: "revert-pages",
        entries: [
          ...page(1, null, 3, ["newest", "middle"], "older"),
          ...page(2, "older", 1, ["boundary"], null),
          {
            type: "expect_outbound",
            frame: {
              id: 3,
              method: "thread/revert",
              params: { threadId: "thread", beforeTurnId: "boundary" },
            },
          },
          {
            type: "emit_inbound",
            frame: { id: 3, error: { code: -32603, message: "boundary reached" } },
          },
        ],
      }),
    ),
  ),
);

it.effect("rejects repeated cursors instead of looping or reverting incomplete history", () =>
  Effect.gen(function* () {
    const client = yield* CodexClient.CodexAppServerClient;
    const result = yield* revertCodexThread(client, "thread", 3).pipe(Effect.flip);
    assert.equal(result.message, "Thread history pagination repeated a cursor.");
  }).pipe(
    Effect.provide(
      CodexReplay.layerReplay({
        provider: "codex",
        protocol: "codex.app-server",
        version: "test",
        scenario: "revert-loop",
        entries: [...page(1, null, 3, ["newest"], "again"), ...page(2, "again", 2, [], "again")],
      }),
    ),
  ),
);

it.effect("reverts from the turn just newer than the kept turn across pages", () =>
  Effect.gen(function* () {
    const client = yield* CodexClient.CodexAppServerClient;
    const result = yield* revertCodexThreadAfterTurn(client, "thread", "kept", 1).pipe(Effect.flip);
    assert.equal(result.message, "boundary reached");
  }).pipe(
    Effect.provide(
      CodexReplay.layerReplay({
        provider: "codex",
        protocol: "codex.app-server",
        version: "test",
        scenario: "revert-after-turn-pages",
        entries: [
          ...page(1, null, 2, ["newest", "unrecorded"], "older"),
          ...page(2, "older", 2, ["kept", "oldest"], null),
          {
            type: "expect_outbound",
            frame: {
              id: 3,
              method: "thread/revert",
              params: { threadId: "thread", beforeTurnId: "unrecorded" },
            },
          },
          {
            type: "emit_inbound",
            frame: { id: 3, error: { code: -32603, message: "boundary reached" } },
          },
        ],
      }),
    ),
  ),
);

it.effect("fails instead of reverting when the kept turn is not in the thread", () =>
  Effect.gen(function* () {
    const client = yield* CodexClient.CodexAppServerClient;
    const result = yield* revertCodexThreadAfterTurn(client, "thread", "kept", 1).pipe(Effect.flip);
    assert.equal(result.message, "Turn kept is not in Codex thread thread.");
  }).pipe(
    Effect.provide(
      CodexReplay.layerReplay({
        provider: "codex",
        protocol: "codex.app-server",
        version: "test",
        scenario: "revert-after-missing-turn",
        entries: page(1, null, 2, ["newest", "older"], null),
      }),
    ),
  ),
);

it.effect("rewinds from the oldest known turn across pages and keeps older turns on retry", () =>
  Effect.gen(function* () {
    const client = yield* CodexClient.CodexAppServerClient;
    const rewind = revertCodexThreadFromKnownTurns(client, "thread", ["first-t3", "second-t3"]);
    assert.equal((yield* rewind.pipe(Effect.flip)).message, "reverted");
    assert.equal((yield* rewind.pipe(Effect.flip)).message, "read only");
  }).pipe(
    Effect.provide(
      CodexReplay.layerReplay({
        provider: "codex",
        protocol: "codex.app-server",
        version: "test",
        scenario: "revert-known-turns-pages",
        entries: [
          ...page(1, null, 100, ["second-t3"], "first"),
          ...page(2, "first", 100, ["first-t3"], "prefix"),
          {
            type: "expect_outbound",
            frame: {
              id: 3,
              method: "thread/revert",
              params: { threadId: "thread", beforeTurnId: "first-t3" },
            },
          },
          { type: "emit_inbound", frame: { id: 3, error: { code: -32603, message: "reverted" } } },
          ...page(4, null, 100, ["newer-kept"], "older-kept"),
          ...page(5, "older-kept", 100, ["older-kept"], null),
          {
            type: "expect_outbound",
            frame: {
              id: 6,
              method: "thread/read",
              params: { threadId: "thread", includeTurns: false },
            },
          },
          { type: "emit_inbound", frame: { id: 6, error: { code: -32603, message: "read only" } } },
        ],
      }),
    ),
  ),
);
