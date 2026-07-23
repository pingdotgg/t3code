import * as NodeAssert from "node:assert/strict";

import { it } from "@effect/vitest";
import { ThreadId } from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";
import { describe } from "vite-plus/test";
import type * as EffectCodexSchema from "effect-codex-app-server/schema";

import {
  handleT3CodexDynamicToolCall,
  makeT3CodexDynamicToolWaitRegistry,
  T3_CODEX_DYNAMIC_TOOLS,
  T3_CODEX_DYNAMIC_TOOL_NAMESPACE,
  T3_CODEX_GITHUB_WAIT_TOOL_NAME,
  T3_CODEX_WAIT_MAX_DURATION_MS,
  T3_CODEX_WAIT_MIN_DURATION_MS,
  T3_CODEX_WAIT_TOOL_NAME,
} from "./CodexDynamicTools.ts";

function waitCall(
  arguments_: unknown,
  overrides: Partial<EffectCodexSchema.DynamicToolCallParams> = {},
): EffectCodexSchema.DynamicToolCallParams {
  return {
    arguments: arguments_,
    callId: "wait-call-1",
    namespace: T3_CODEX_DYNAMIC_TOOL_NAMESPACE,
    threadId: "provider-thread-1",
    tool: T3_CODEX_WAIT_TOOL_NAME,
    turnId: "provider-turn-1",
    ...overrides,
  };
}

function githubWaitCall(arguments_: unknown): EffectCodexSchema.DynamicToolCallParams {
  return waitCall(arguments_, {
    callId: "github-wait-call-1",
    tool: T3_CODEX_GITHUB_WAIT_TOOL_NAME,
  });
}

describe("T3 Codex dynamic tools", () => {
  it("publishes a bounded namespaced wait tool", () => {
    const namespace = T3_CODEX_DYNAMIC_TOOLS[0];
    const wait = namespace?.tools.find((tool) => tool.name === T3_CODEX_WAIT_TOOL_NAME);

    NodeAssert.equal(namespace?.type, "namespace");
    NodeAssert.equal(namespace?.name, T3_CODEX_DYNAMIC_TOOL_NAMESPACE);
    NodeAssert.equal(wait?.type, "function");
    NodeAssert.equal(wait?.name, T3_CODEX_WAIT_TOOL_NAME);
    NodeAssert.deepStrictEqual(wait?.inputSchema, {
      type: "object",
      properties: {
        durationMs: {
          type: "integer",
          minimum: T3_CODEX_WAIT_MIN_DURATION_MS,
          maximum: T3_CODEX_WAIT_MAX_DURATION_MS,
          description: "How long T3 should wait, in milliseconds.",
        },
        reason: {
          type: "string",
          maxLength: 500,
          description: "Optional short explanation of the external work being awaited.",
        },
      },
      required: ["durationMs"],
      additionalProperties: false,
    });
  });

  it.effect("registers a durable GitHub waitpoint and returns without holding the turn open", () =>
    Effect.gen(function* () {
      let registered: unknown;
      const response = yield* handleT3CodexDynamicToolCall(
        githubWaitCall({
          repository: "pingdotgg/t3code",
          pullRequestNumber: 4262,
          condition: "checks_settled",
          timeoutMinutes: 60,
          reason: "Wait for CI before addressing failures.",
        }),
        Effect.never,
        {
          threadId: ThreadId.make("thread-1"),
          cwd: "/tmp/project",
          registerGitHubWaitpoint: (input) =>
            Effect.sync(() => {
              registered = input;
              return { id: "github:thread-1:github-wait-call-1" };
            }),
        },
      );

      NodeAssert.equal(response.success, true);
      NodeAssert.match(
        response.contentItems[0]?.type === "inputText" ? response.contentItems[0].text : "",
        /registered/i,
      );
      NodeAssert.deepStrictEqual(registered, {
        idempotencyKey: "github-wait-call-1",
        threadId: ThreadId.make("thread-1"),
        cwd: "/tmp/project",
        repository: "pingdotgg/t3code",
        pullRequestNumber: 4262,
        condition: "checks_settled",
        timeoutMinutes: 60,
        reason: "Wait for CI before addressing failures.",
      });
    }),
  );

  it.effect("does not complete before the requested duration", () =>
    Effect.gen(function* () {
      const fiber = yield* handleT3CodexDynamicToolCall(
        waitCall({ durationMs: T3_CODEX_WAIT_MIN_DURATION_MS, reason: "CI is running" }),
      ).pipe(Effect.forkChild);

      yield* TestClock.adjust(T3_CODEX_WAIT_MIN_DURATION_MS - 1);
      NodeAssert.equal(fiber.pollUnsafe(), undefined);

      yield* TestClock.adjust(1);
      NodeAssert.deepStrictEqual(yield* Fiber.join(fiber), {
        success: true,
        contentItems: [
          {
            type: "inputText",
            text: `Wait completed after ${T3_CODEX_WAIT_MIN_DURATION_MS} ms.`,
          },
        ],
      });
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("cancels an active wait", () =>
    Effect.gen(function* () {
      const cancelled = yield* Deferred.make<void>();
      const fiber = yield* handleT3CodexDynamicToolCall(
        waitCall({ durationMs: T3_CODEX_WAIT_MAX_DURATION_MS }),
        Deferred.await(cancelled),
      ).pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      yield* Deferred.succeed(cancelled, undefined);

      NodeAssert.deepStrictEqual(yield* Fiber.join(fiber), {
        success: false,
        contentItems: [
          {
            type: "inputText",
            text: "Wait cancelled because the turn was interrupted or the session closed.",
          },
        ],
      });
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("cancels waits by turn and cancels all remaining waits on shutdown", () =>
    Effect.gen(function* () {
      const registry = yield* makeT3CodexDynamicToolWaitRegistry();
      const first = yield* registry
        .handle(
          waitCall(
            { durationMs: T3_CODEX_WAIT_MAX_DURATION_MS },
            { callId: "wait-call-1", turnId: "provider-turn-1" },
          ),
        )
        .pipe(Effect.forkChild);
      const second = yield* registry
        .handle(
          waitCall(
            { durationMs: T3_CODEX_WAIT_MAX_DURATION_MS },
            { callId: "wait-call-2", turnId: "provider-turn-2" },
          ),
        )
        .pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      yield* registry.cancelTurn("provider-turn-1");

      NodeAssert.equal((yield* Fiber.join(first)).success, false);
      NodeAssert.equal(second.pollUnsafe(), undefined);

      yield* registry.cancelAll;
      NodeAssert.equal((yield* Fiber.join(second)).success, false);
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("immediately cancels waits registered after their turn was interrupted", () =>
    Effect.gen(function* () {
      const registry = yield* makeT3CodexDynamicToolWaitRegistry();
      yield* registry.cancelTurn("provider-turn-1");

      const response = yield* registry.handle(
        waitCall({ durationMs: T3_CODEX_WAIT_MAX_DURATION_MS }, { turnId: "provider-turn-1" }),
      );

      NodeAssert.equal(response.success, false);
      NodeAssert.match(
        response.contentItems[0]?.type === "inputText" ? response.contentItems[0].text : "",
        /Wait cancelled/,
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("immediately cancels waits registered after session shutdown", () =>
    Effect.gen(function* () {
      const registry = yield* makeT3CodexDynamicToolWaitRegistry();
      yield* registry.cancelAll;

      const response = yield* registry.handle(
        waitCall({ durationMs: T3_CODEX_WAIT_MAX_DURATION_MS }),
      );

      NodeAssert.equal(response.success, false);
      NodeAssert.match(
        response.contentItems[0]?.type === "inputText" ? response.contentItems[0].text : "",
        /Wait cancelled/,
      );
    }).pipe(Effect.provide(TestClock.layer())),
  );

  it.effect("rejects malformed and out-of-range arguments without sleeping", () =>
    Effect.gen(function* () {
      for (const arguments_ of [
        {},
        { durationMs: T3_CODEX_WAIT_MIN_DURATION_MS - 1 },
        { durationMs: T3_CODEX_WAIT_MAX_DURATION_MS + 1 },
        { durationMs: 1_000.5 },
        { durationMs: "1000" },
      ]) {
        const response = yield* handleT3CodexDynamicToolCall(waitCall(arguments_));
        NodeAssert.equal(response.success, false);
        NodeAssert.match(
          response.contentItems[0]?.type === "inputText" ? response.contentItems[0].text : "",
          /Invalid wait arguments/,
        );
      }
    }),
  );

  it.effect("rejects calls outside the T3 namespace", () =>
    Effect.gen(function* () {
      const response = yield* handleT3CodexDynamicToolCall(
        waitCall({ durationMs: T3_CODEX_WAIT_MIN_DURATION_MS }, { namespace: "other" }),
      );

      NodeAssert.equal(response.success, false);
      NodeAssert.match(
        response.contentItems[0]?.type === "inputText" ? response.contentItems[0].text : "",
        /Unknown T3 Code dynamic tool/,
      );
    }),
  );
});
