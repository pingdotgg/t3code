import * as NodeAssert from "node:assert/strict";

import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { describe, it } from "@effect/vitest";
import { TurnId } from "@t3tools/contracts";
import type * as CodexRpc from "effect-codex-app-server/rpc";
import type * as EffectCodexSchema from "effect-codex-app-server/schema";

import {
  findActiveCodexTurnId,
  resolveCodexInterruptTurnId,
  shouldReplaceActiveCodexTurnCandidate,
} from "./CodexSessionRuntime.ts";

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
  it.effect("requests turns when resolving an interrupt without a projected turn id", () => {
    let requestedParams: CodexRpc.ClientRequestParamsByMethod["thread/read"] | undefined;
    let readThreadCallCount = 0;

    return Effect.gen(function* () {
      const turnId = yield* resolveCodexInterruptTurnId({
        providerThreadId: "provider-thread-1",
        requestedTurnId: undefined,
        readSessionActiveTurnId: Effect.succeed(undefined),
        readThread: (params) => {
          readThreadCallCount += 1;
          requestedParams = params;
          return Effect.succeed(
            makeThreadReadResponse([
              { id: "turn-active", status: "inProgress", startedAt: 10, items: [] },
            ]),
          );
        },
      });

      NodeAssert.deepStrictEqual(requestedParams, {
        threadId: "provider-thread-1",
        includeTurns: true,
      });
      NodeAssert.equal(readThreadCallCount, 1);
      NodeAssert.equal(turnId, "turn-active");
    });
  });

  it.effect("does not revive a stale projected turn after a successful empty read", () =>
    Effect.gen(function* () {
      const turnId = yield* resolveCodexInterruptTurnId({
        providerThreadId: "provider-thread-1",
        requestedTurnId: undefined,
        readSessionActiveTurnId: Effect.succeed(TurnId.make("turn-stale")),
        readThread: () => Effect.succeed(makeThreadReadResponse([])),
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
        readThread: () => Effect.fail("lookup failed"),
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
        readThread: () =>
          Effect.gen(function* () {
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
        readThread: () =>
          Effect.gen(function* () {
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
