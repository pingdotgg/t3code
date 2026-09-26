import * as NodeAssert from "node:assert/strict";

import { it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import type * as CodexClient from "effect-codex-app-server/client";
import * as CodexErrors from "effect-codex-app-server/errors";
import type * as CodexSchema from "effect-codex-app-server/schema";

import { makeCodexMcpStartup } from "./CodexMcpStartup.ts";

type Client = CodexClient.CodexAppServerClient["Service"];
type Update = CodexSchema.V2McpServerStatusUpdatedNotification;
type Page = CodexSchema.V2ListMcpServerStatusResponse;

const server = (
  name: string,
  runtimeStatus: Page["data"][number]["runtimeStatus"] = "starting",
) => ({
  name,
  runtimeStatus,
  authStatus: "unsupported" as const,
  tools: {},
  resources: [],
  resourceTemplates: [],
});

const makePeer = Effect.fnUntraced(function* (
  pages: ReadonlyArray<Page>,
  reload: Effect.Effect<unknown, CodexErrors.CodexAppServerError> = Effect.succeed({}),
) {
  const listed = yield* Deferred.make<void>();
  let handler: (update: Update) => Effect.Effect<void, CodexErrors.CodexAppServerError> = () =>
    Effect.die("Startup handler was not registered");
  let pageIndex = 0;
  const requests: Array<{ method: string; params: unknown }> = [];
  const client = {
    request: ((method, params) => {
      requests.push({ method, params });
      if (method === "config/mcpServer/reload") return reload;
      NodeAssert.equal(method, "mcpServerStatus/list");
      const page = pages[pageIndex++ % pages.length]!;
      return Effect.succeed(page).pipe(
        Effect.tap(() => (page.nextCursor ? Effect.void : Deferred.succeed(listed, undefined))),
      );
    }) as Client["request"],
    handleServerNotification: ((method, onUpdate) =>
      Effect.sync(() => {
        NodeAssert.equal(method, "mcpServer/startupStatus/updated");
        handler = onUpdate as typeof handler;
      })) as Client["handleServerNotification"],
  };
  const refresh = yield* makeCodexMcpStartup(client);
  return { refresh, listed, requests, emit: (update: Update) => handler(update) };
});

it.effect("waits for every paginated server, ignoring stale snapshots and other threads", () =>
  Effect.gen(function* () {
    const peer = yield* makePeer([
      { data: [server("fast", "connected")], nextCursor: "page-2" },
      { data: [server("slow", "connected"), server("off", "disabled")] },
    ]);
    const turn = yield* peer.refresh("root").pipe(Effect.forkChild);
    yield* Deferred.await(peer.listed);
    yield* peer.emit({ threadId: "root", name: "fast", status: "ready" });
    yield* peer.emit({ threadId: "child", name: "slow", status: "ready" });
    yield* peer.emit({ name: "slow", status: "ready" });
    yield* TestClock.adjust("20 seconds");
    NodeAssert.equal(turn.pollUnsafe(), undefined);
    yield* peer.emit({ threadId: "root", name: "slow", status: "cancelled" });
    yield* TestClock.adjust("1 second");
    NodeAssert.equal(turn.pollUnsafe(), undefined);
    yield* peer.emit({ threadId: "root", name: "slow", status: "ready" });
    yield* Fiber.join(turn);
    NodeAssert.deepStrictEqual(
      peer.requests.slice(1).map((entry) => entry.params),
      [
        { threadId: "root", detail: "toolsAndAuthOnly" },
        { threadId: "root", detail: "toolsAndAuthOnly", cursor: "page-2" },
      ],
    );
  }),
);

it.effect("a failed server does not block the remaining ready servers", () =>
  Effect.gen(function* () {
    const peer = yield* makePeer([{ data: [server("failed"), server("ready")] }]);
    const turn = yield* peer.refresh("root").pipe(Effect.forkChild);
    yield* Deferred.await(peer.listed);
    yield* peer.emit({ threadId: "root", name: "failed", status: "failed" });
    yield* peer.emit({ threadId: "root", name: "ready", status: "ready" });
    yield* Fiber.join(turn);
  }),
);

for (const status of ["starting", "cancelled"] as const) {
  it.effect(`continues after 30 seconds when a server remains ${status}`, () =>
    Effect.gen(function* () {
      const peer = yield* makePeer([{ data: [server("slow")] }]);
      const turn = yield* peer.refresh("root").pipe(Effect.forkChild);
      yield* Deferred.await(peer.listed);
      yield* peer.emit({ threadId: "root", name: "slow", status });
      yield* TestClock.adjust("29 seconds");
      NodeAssert.equal(turn.pollUnsafe(), undefined);
      yield* TestClock.adjust("1 second");
      yield* Fiber.join(turn);
    }),
  );
}

it.effect("does not reuse readiness from a previous turn", () =>
  Effect.gen(function* () {
    const peer = yield* makePeer([{ data: [server("tools", "connected")] }]);
    const first = yield* peer.refresh("root").pipe(Effect.forkChild);
    yield* Deferred.await(peer.listed);
    yield* peer.emit({ threadId: "root", name: "tools", status: "ready" });
    yield* Fiber.join(first);
    const second = yield* peer.refresh("root").pipe(Effect.forkChild);
    yield* TestClock.adjust("1 second");
    NodeAssert.equal(second.pollUnsafe(), undefined);
    yield* peer.emit({ threadId: "root", name: "tools", status: "ready" });
    yield* Fiber.join(second);
  }),
);

it.effect("proceeds immediately when there are no enabled servers", () =>
  Effect.gen(function* () {
    const peer = yield* makePeer([{ data: [server("off", "disabled")] }]);
    yield* peer.refresh("root");
  }),
);

it.effect("continues when the reload fails", () =>
  Effect.gen(function* () {
    const peer = yield* makePeer(
      [],
      Effect.fail(CodexErrors.CodexAppServerRequestError.methodNotFound("config/mcpServer/reload")),
    );
    yield* peer.refresh("root");
    NodeAssert.equal(peer.requests.length, 1);
  }),
);

it.effect("bounds a stuck reload request as well as startup notifications", () =>
  Effect.gen(function* () {
    const peer = yield* makePeer([], Effect.never);
    const turn = yield* peer.refresh("root").pipe(Effect.forkChild);
    yield* TestClock.adjust("30 seconds");
    yield* Fiber.join(turn);
    NodeAssert.equal(peer.requests.length, 1);
  }),
);
