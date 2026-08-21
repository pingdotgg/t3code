// @effect-diagnostics nodeBuiltinImport:off
import * as NodeAssert from "node:assert/strict";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import type * as CodexRpc from "effect-codex-app-server/rpc";
import type * as CodexSchema from "effect-codex-app-server/schema";

import { listAllCodexThreads, type CodexThreadListClient } from "./CodexAppServerConnection.ts";

type CodexThread = CodexSchema.V2ThreadListResponse["data"][number];
type ThreadListParams = CodexRpc.ClientRequestParamsByMethod["thread/list"];

function thread(id: string, updatedAt: number): CodexThread {
  return {
    cliVersion: "1.0.0",
    createdAt: updatedAt - 10,
    cwd: "/workspace/project",
    ephemeral: false,
    id,
    modelProvider: "openai",
    preview: `Preview ${id}`,
    sessionId: `session-${id}`,
    source: "cli",
    status: { type: "notLoaded" },
    turns: [],
    updatedAt,
  };
}

it.effect("lists every Codex thread/list page newest-first and de-duplicates page overlaps", () =>
  Effect.gen(function* () {
    const requests: ThreadListParams[] = [];
    const first = thread("thread-1", 200);
    const second = thread("thread-2", 100);
    const client: CodexThreadListClient = {
      request: (_method, params) =>
        Effect.sync(() => {
          requests.push(params);
          return params.cursor === undefined
            ? { data: [first], nextCursor: "cursor-1" }
            : { data: [first, second], nextCursor: null };
        }),
    };

    const result = yield* listAllCodexThreads(client);

    NodeAssert.deepEqual(
      result.map((entry) => entry.id),
      ["thread-1", "thread-2"],
    );
    NodeAssert.deepEqual(requests, [
      {
        archived: false,
        limit: 100,
        sortKey: "updated_at",
        sortDirection: "desc",
        useStateDbOnly: false,
      },
      {
        archived: false,
        limit: 100,
        sortKey: "updated_at",
        sortDirection: "desc",
        useStateDbOnly: false,
        cursor: "cursor-1",
      },
    ]);
  }),
);

it.effect("stops safely when Codex repeats a thread/list cursor", () =>
  Effect.gen(function* () {
    let requestCount = 0;
    const client: CodexThreadListClient = {
      request: () =>
        Effect.sync(() => {
          requestCount += 1;
          return {
            data: [thread(`thread-${requestCount}`, requestCount)],
            nextCursor: "repeated-cursor",
          };
        }),
    };

    const result = yield* listAllCodexThreads(client);

    NodeAssert.equal(requestCount, 2);
    NodeAssert.deepEqual(
      result.map((entry) => entry.id),
      ["thread-1", "thread-2"],
    );
  }),
);
