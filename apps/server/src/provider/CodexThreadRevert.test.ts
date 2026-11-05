import { assert, it } from "@effect/vitest";
import * as CodexClient from "effect-codex-app-server/client";
import * as CodexReplay from "effect-codex-app-server/replay";
import * as Effect from "effect/Effect";

import { revertCodexThread, revertCodexThreadAfter } from "./CodexThreadRevert.ts";

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
    Effect.scoped,
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
    Effect.scoped,
  ),
);

const settles = (id: number, method: "thread/revert" | "thread/read", params: object) => [
  { type: "expect_outbound" as const, frame: { id, method, params } },
  {
    type: "emit_inbound" as const,
    frame: { id, error: { code: -32603, message: `${method} ${JSON.stringify(params)}` } },
  },
];

const revertAfter = (
  scenario: string,
  boundary: { readonly later: string[]; readonly kept: string[] },
  entries: ReadonlyArray<CodexReplay.CodexAppServerReplayEntry>,
) =>
  Effect.gen(function* () {
    const client = yield* CodexClient.CodexAppServerClient;
    const error = yield* revertCodexThreadAfter(client, "thread", {
      laterTurnIds: new Set(boundary.later),
      keptTurnIds: new Set(boundary.kept),
    }).pipe(Effect.flip);
    return error.message;
  }).pipe(
    Effect.provide(
      CodexReplay.layerReplay({
        provider: "codex",
        protocol: "codex.app-server",
        version: "test",
        scenario,
        entries,
      }),
    ),
    Effect.scoped,
  );

it.effect("reverts before the oldest later turn it finds", () =>
  Effect.gen(function* () {
    const message = yield* revertAfter(
      "revert-after",
      { later: ["t3", "t4"], kept: ["t1", "t2"] },
      [
        ...page(1, null, 2, ["t4", "t3"], "older"),
        ...settles(2, "thread/revert", { threadId: "thread", beforeTurnId: "t3" }),
      ],
    );
    assert.equal(message, 'thread/revert {"threadId":"thread","beforeTurnId":"t3"}');
  }),
);

it.effect("removes nothing once the later turns are gone", () =>
  Effect.gen(function* () {
    const message = yield* revertAfter(
      "revert-after-repeat",
      { later: ["t3", "t4"], kept: ["t1", "t2"] },
      [
        ...page(1, null, 2, ["t2", "t1"], "older"),
        ...settles(2, "thread/read", { threadId: "thread", includeTurns: false }),
      ],
    );
    assert.equal(message, 'thread/read {"threadId":"thread","includeTurns":false}');
  }),
);

it.effect("never cuts past a kept turn", () =>
  Effect.gen(function* () {
    const message = yield* revertAfter("revert-after-kept", { later: ["t3", "t4"], kept: ["t2"] }, [
      ...page(1, null, 2, ["t4", "t2"], "older"),
      ...settles(2, "thread/revert", { threadId: "thread", beforeTurnId: "t4" }),
    ]);
    assert.equal(message, 'thread/revert {"threadId":"thread","beforeTurnId":"t4"}');
  }),
);

it.effect("pages through turns it doesn't know before removing nothing", () =>
  Effect.gen(function* () {
    const message = yield* revertAfter("revert-after-inherited", { later: ["own"], kept: [] }, [
      ...page(1, null, 1, ["inherited-2"], "more"),
      ...page(2, "more", 100, ["inherited-1"], null),
      ...settles(3, "thread/read", { threadId: "thread", includeTurns: false }),
    ]);
    assert.equal(message, 'thread/read {"threadId":"thread","includeTurns":false}');
  }),
);
