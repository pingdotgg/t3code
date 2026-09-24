import * as NodeAssert from "node:assert/strict";

import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { describe, it } from "@effect/vitest";
import { TurnId } from "@t3tools/contracts";
import type * as CodexRpc from "effect-codex-app-server/rpc";
import type * as EffectCodexSchema from "effect-codex-app-server/schema";

import { readCodexThreadWithTurns } from "./CodexSessionRuntime.ts";

import {
  findActiveCodexTurnId,
  resolveCodexInterruptTurnId,
  shouldReplaceActiveCodexTurnCandidate,
} from "./CodexInterruptResolution.ts";

function makeThreadReadResponse(
  turns: EffectCodexSchema.V2ThreadReadResponse["thread"]["turns"],
): EffectCodexSchema.V2ThreadReadResponse {
  return {
    thread: {
      cliVersion: "0.0.0-test",
      createdAt: 1,
      cwd: "/tmp/project",
      ephemeral: false,
      id: "provider-thread-1",
      modelProvider: "openai",
      preview: "test thread",
      sessionId: "session-1",
      source: "appServer",
      status: { type: "active", activeFlags: [] },
      turns,
      updatedAt: 2,
    },
  };
}

describe("findActiveCodexTurnId", () => {
  it("selects the most recently started in-progress turn", () => {
    const snapshot = makeThreadReadResponse([
      { id: "turn-active-new", status: "inProgress", startedAt: 30, items: [] },
      { id: "turn-completed", status: "completed", startedAt: 20, items: [] },
      { id: "turn-active-old", status: "inProgress", startedAt: 10, items: [] },
    ]);

    NodeAssert.equal(findActiveCodexTurnId(snapshot), "turn-active-new");
  });

  it("selects a later in-progress turn without a start timestamp", () => {
    const snapshot = makeThreadReadResponse([
      { id: "turn-active-old", status: "inProgress", startedAt: 10, items: [] },
      { id: "turn-active-new", status: "inProgress", items: [] },
    ]);

    NodeAssert.equal(findActiveCodexTurnId(snapshot), "turn-active-new");
  });

  it("selects a later timestamped turn after one without a timestamp", () => {
    const snapshot = makeThreadReadResponse([
      { id: "turn-active-old", status: "inProgress", items: [] },
      { id: "turn-active-new", status: "inProgress", startedAt: 10, items: [] },
    ]);

    NodeAssert.equal(findActiveCodexTurnId(snapshot), "turn-active-new");
  });

  it("returns undefined when no turn is active", () => {
    const response = makeThreadReadResponse([]);
    NodeAssert.equal(findActiveCodexTurnId(response), undefined);
  });
});

describe("resolveCodexInterruptTurnId", () => {
  it.effect("uses the live reader when no explicit turn is requested", () =>
    Effect.gen(function* () {
      const turnId = yield* resolveCodexInterruptTurnId({
        providerThreadId: "provider-thread-1",
        requestedTurnId: undefined,
        readSessionActiveTurnId: Effect.succeed(undefined),
        readThread: Effect.succeed(
          makeThreadReadResponse([
            { id: "turn-active", status: "inProgress", startedAt: 10, items: [] },
          ]),
        ),
      });
      NodeAssert.equal(turnId, "turn-active");
    }),
  );

  it.effect("does not read or fall back for an explicitly selected child turn", () =>
    Effect.gen(function* () {
      const turnId = yield* resolveCodexInterruptTurnId({
        providerThreadId: "provider-child",
        requestedTurnId: TurnId.make("child-turn"),
        readSessionActiveTurnId: Effect.die("Unexpected root fallback"),
        readThread: Effect.die("Unexpected root lookup"),
      });
      NodeAssert.equal(turnId, "child-turn");
    }),
  );

  it.effect("does not revive a stale projected turn after a successful empty read", () =>
    Effect.gen(function* () {
      const turnId = yield* resolveCodexInterruptTurnId({
        providerThreadId: "provider-thread-1",
        requestedTurnId: undefined,
        readSessionActiveTurnId: Effect.succeed(TurnId.make("turn-stale")),
        readThread: Effect.succeed(makeThreadReadResponse([])),
      });

      NodeAssert.equal(turnId, undefined);
    }),
  );

  it.effect("falls back to the projected turn when the live lookup fails", () =>
    Effect.gen(function* () {
      const projectedTurnId = TurnId.make("turn-projected");
      const turnId = yield* resolveCodexInterruptTurnId({
        providerThreadId: "provider-thread-1",
        requestedTurnId: undefined,
        readSessionActiveTurnId: Effect.succeed(projectedTurnId),
        readThread: Effect.fail("lookup failed"),
      });

      NodeAssert.equal(turnId, projectedTurnId);
    }),
  );

  it.effect("falls back to the projected turn when the live lookup dies", () =>
    Effect.gen(function* () {
      const projectedTurnId = TurnId.make("turn-projected");
      const turnId = yield* resolveCodexInterruptTurnId({
        providerThreadId: "provider-thread-1",
        requestedTurnId: undefined,
        readSessionActiveTurnId: Effect.succeed(projectedTurnId),
        readThread: Effect.die("lookup defect"),
      });

      NodeAssert.equal(turnId, projectedTurnId);
    }),
  );

  it.effect("bounds the live lookup and falls back to the projected turn on timeout", () =>
    Effect.gen(function* () {
      const projectedTurnId = TurnId.make("turn-projected");
      const lookupStarted = yield* Deferred.make<void>();
      const resolution = yield* resolveCodexInterruptTurnId({
        providerThreadId: "provider-thread-1",
        requestedTurnId: undefined,
        readSessionActiveTurnId: Effect.succeed(projectedTurnId),
        readThread: Effect.gen(function* () {
          yield* Deferred.succeed(lookupStarted, undefined);
          return yield* Effect.never;
        }),
      }).pipe(Effect.forkScoped);

      yield* Deferred.await(lookupStarted);
      yield* TestClock.adjust("2 seconds");
      NodeAssert.equal(yield* Fiber.join(resolution), projectedTurnId);
    }),
  );

  it.effect("reads the projected fallback after a live lookup times out", () =>
    Effect.gen(function* () {
      let projectedTurnId = TurnId.make("turn-old");
      const lookupStarted = yield* Deferred.make<void>();
      const resolution = yield* resolveCodexInterruptTurnId({
        providerThreadId: "provider-thread-1",
        requestedTurnId: undefined,
        readSessionActiveTurnId: Effect.sync(() => projectedTurnId),
        readThread: Effect.gen(function* () {
          yield* Deferred.succeed(lookupStarted, undefined);
          return yield* Effect.never;
        }),
      }).pipe(Effect.forkScoped);

      yield* Deferred.await(lookupStarted);
      // Mutate after the live lookup starts to verify that the fallback is
      // evaluated lazily after the timeout instead of captured up front.
      projectedTurnId = TurnId.make("turn-current");
      yield* TestClock.adjust("2 seconds");
      NodeAssert.equal(yield* Fiber.join(resolution), projectedTurnId);
    }),
  );
});

describe("shouldReplaceActiveCodexTurnCandidate", () => {
  it("selects the first candidate", () => {
    NodeAssert.equal(shouldReplaceActiveCodexTurnCandidate({ startedAt: 10 }, undefined), true);
  });

  it("orders timestamped turns by start time and lets a later equal entry win", () => {
    NodeAssert.equal(
      shouldReplaceActiveCodexTurnCandidate({ startedAt: 20 }, { startedAt: 10 }),
      true,
    );
    NodeAssert.equal(
      shouldReplaceActiveCodexTurnCandidate({ startedAt: 10 }, { startedAt: 20 }),
      false,
    );
    NodeAssert.equal(
      shouldReplaceActiveCodexTurnCandidate({ startedAt: 10 }, { startedAt: 10 }),
      true,
    );
  });

  it("lets the later provider entry win when either timestamp is absent", () => {
    for (const [candidate, selected] of [
      [{}, { startedAt: 10 }],
      [{ startedAt: null }, { startedAt: 10 }],
      [{ startedAt: 10 }, {}],
      [{ startedAt: 10 }, { startedAt: null }],
    ] as const) {
      NodeAssert.equal(shouldReplaceActiveCodexTurnCandidate(candidate, selected), true);
    }
  });
});

describe("paginated Codex interrupt resolution", () => {
  const threadId = "provider-thread-1";
  const staleTurnId = TurnId.make("turn-stale");

  function resolveWithClient(client: Parameters<typeof readCodexThreadWithTurns>[0]) {
    return resolveCodexInterruptTurnId({
      providerThreadId: threadId,
      requestedTurnId: undefined,
      readSessionActiveTurnId: Effect.succeed(staleTurnId),
      readThread: readCodexThreadWithTurns(client, threadId),
    });
  }

  it.effect("keeps the legacy includeTurns read for older provider threads", () =>
    Effect.gen(function* () {
      const result = yield* resolveWithClient({
        raw: {
          request: (method, params) => {
            NodeAssert.equal(method, "thread/read");
            NodeAssert.deepEqual(params, { threadId, includeTurns: false });
            return Effect.succeed({ thread: {} });
          },
        },
        request: <M extends CodexRpc.ClientRequestMethod>(
          method: M,
          params: CodexRpc.ClientRequestParamsByMethod[M],
        ) => {
          NodeAssert.equal(method, "thread/read");
          NodeAssert.deepEqual(params, { threadId, includeTurns: true });
          return Effect.succeed(
            makeThreadReadResponse([
              { id: "legacy-active", status: "inProgress", startedAt: 10, items: [] },
            ]) as CodexRpc.ClientRequestResponsesByMethod[M],
          );
        },
      });
      NodeAssert.equal(result, "legacy-active");
    }),
  );

  for (const [firstStartedAt, secondStartedAt, expected] of [
    [30, 10, "first-active"],
    [10, 30, "second-active"],
    [30, undefined, "second-active"],
    [undefined, 10, "second-active"],
    [30, 30, "second-active"],
  ] as const) {
    it.effect(
      `preserves active-turn ordering across pages: ${firstStartedAt}, ${secondStartedAt}`,
      () =>
        Effect.gen(function* () {
          let pageCount = 0;
          const result = yield* resolveWithClient({
            request: () => Effect.die("Paginated threads must not use the legacy turns read"),
            raw: {
              request: (method, params) =>
                Effect.sync(() => {
                  if (method === "thread/read") {
                    NodeAssert.deepEqual(params, { threadId, includeTurns: false });
                    return { thread: { historyMode: "paginated" } };
                  }
                  NodeAssert.equal(method, "thread/turns/list");
                  NodeAssert.deepEqual(params, {
                    threadId,
                    cursor: pageCount === 0 ? null : "next",
                    limit: 100,
                    sortDirection: "asc",
                    itemsView: "full",
                  });
                  pageCount += 1;
                  return pageCount === 1
                    ? {
                        data: [
                          { id: "completed", status: "completed", startedAt: 100, items: [] },
                          {
                            id: "first-active",
                            status: "inProgress",
                            ...(firstStartedAt === undefined ? {} : { startedAt: firstStartedAt }),
                            items: [],
                          },
                        ],
                        nextCursor: "next",
                      }
                    : {
                        data: [
                          {
                            id: "second-active",
                            status: "inProgress",
                            ...(secondStartedAt === undefined
                              ? {}
                              : { startedAt: secondStartedAt }),
                            items: [],
                          },
                        ],
                        nextCursor: null,
                      };
                }),
            },
          });
          NodeAssert.equal(result, expected);
          NodeAssert.equal(pageCount, 2);
        }),
    );
  }

  it.effect("does not revive a stale cached turn after completed or empty pages", () =>
    Effect.gen(function* () {
      let pageCount = 0;
      const result = yield* resolveWithClient({
        request: () => Effect.die("Unexpected legacy read"),
        raw: {
          request: (method) =>
            Effect.sync(() => {
              if (method === "thread/read") return { thread: { historyMode: "paginated" } };
              pageCount += 1;
              return pageCount === 1
                ? {
                    data: [{ id: "completed", status: "completed", items: [] }],
                    nextCursor: "next",
                  }
                : { data: [], nextCursor: null };
            }),
        },
      });
      NodeAssert.equal(result, undefined);
      NodeAssert.equal(pageCount, 2);
    }),
  );

  for (const invalidPage of [
    { data: [{ id: "bad-status", status: "unknown", items: [] }], nextCursor: null },
    {
      data: [{ id: "bad-timestamp", status: "inProgress", startedAt: "bad", items: [] }],
      nextCursor: null,
    },
  ]) {
    it.effect("falls back when a page cannot be decoded", () =>
      Effect.gen(function* () {
        const result = yield* resolveWithClient({
          request: () => Effect.die("Unexpected legacy read"),
          raw: {
            request: (method) =>
              Effect.succeed(
                method === "thread/read" ? { thread: { historyMode: "paginated" } } : invalidPage,
              ),
          },
        });
        NodeAssert.equal(result, staleTurnId);
      }),
    );
  }

  it.effect("falls back without requesting a pagination cursor twice", () =>
    Effect.gen(function* () {
      let pageCount = 0;
      const result = yield* resolveWithClient({
        request: () => Effect.die("Unexpected legacy read"),
        raw: {
          request: (method) =>
            Effect.sync(() => {
              if (method === "thread/read") return { thread: { historyMode: "paginated" } };
              pageCount += 1;
              NodeAssert.ok(pageCount <= 2);
              return { data: [], nextCursor: "next" };
            }),
        },
      });
      NodeAssert.equal(result, staleTurnId);
      NodeAssert.equal(pageCount, 2);
    }),
  );

  it.effect(
    "bounds metadata and all pages with one deadline and reads the fallback afterward",
    () =>
      Effect.gen(function* () {
        const metadataStarted = yield* Deferred.make<void>();
        const lastPageStarted = yield* Deferred.make<void>();
        let projectedTurnId = staleTurnId;
        let pageCount = 0;
        const client: Parameters<typeof readCodexThreadWithTurns>[0] = {
          request: () => Effect.die("Unexpected legacy read"),
          raw: {
            request: (method) =>
              Effect.gen(function* () {
                if (method === "thread/read") {
                  yield* Deferred.succeed(metadataStarted, undefined);
                  yield* Effect.sleep("500 millis");
                  return { thread: { historyMode: "paginated" } };
                }
                pageCount += 1;
                if (pageCount === 1) {
                  yield* Effect.sleep("1 second");
                  return { data: [], nextCursor: "next" };
                }
                yield* Deferred.succeed(lastPageStarted, undefined);
                return yield* Effect.never;
              }),
          },
        };
        const resolution = yield* resolveCodexInterruptTurnId({
          providerThreadId: threadId,
          requestedTurnId: undefined,
          readSessionActiveTurnId: Effect.sync(() => projectedTurnId),
          readThread: readCodexThreadWithTurns(client, threadId),
        }).pipe(Effect.forkScoped);
        yield* Deferred.await(metadataStarted);
        yield* TestClock.adjust("1500 millis");
        yield* Deferred.await(lastPageStarted);
        projectedTurnId = TurnId.make("turn-current");
        yield* TestClock.adjust("500 millis");
        NodeAssert.equal(yield* Fiber.join(resolution), projectedTurnId);
        NodeAssert.equal(pageCount, 2);
      }),
  );
});
