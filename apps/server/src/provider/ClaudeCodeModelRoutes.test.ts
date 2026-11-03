import { assert, describe, it } from "@effect/vitest";
import { type ModelSelection, ProviderInstanceId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import { makeClaudeCodeModelRoutes } from "./ClaudeCodeModelRoutes.ts";
import {
  BUNDLED_CLAUDE_MODEL_CATALOG,
  resolveClaudeCatalogApiModelId,
} from "./ClaudeModelCatalog.ts";

describe("Claude Code model routes", () => {
  it.effect(
    "a turn that starts before the first probe settles waits and then gets its routes",
    () =>
      Effect.gen(function* () {
        const haiku = {
          instanceId: ProviderInstanceId.make("claudeAgent"),
          model: "claude-haiku-4-5",
        } satisfies ModelSelection;
        const routes = yield* makeClaudeCodeModelRoutes(
          Effect.succeed(BUNDLED_CLAUDE_MODEL_CATALOG),
          () => Effect.succeed("same settings"),
          "/state",
        );
        const early = yield* routes
          .catalogFor("/project")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* routes.record([
          { value: "haiku", resolvedModel: "us.anthropic.claude-haiku-4-5-20251001-v1:0" },
        ]);
        yield* routes.settle;
        assert.strictEqual(
          resolveClaudeCatalogApiModelId(yield* Fiber.join(early), haiku),
          "haiku",
        );

        // A first check that never reaches the probe still releases waiting turns.
        const unprobed = yield* makeClaudeCodeModelRoutes(
          Effect.succeed(BUNDLED_CLAUDE_MODEL_CATALOG),
          () => Effect.succeed("same settings"),
          "/state",
        );
        const waiting = yield* unprobed
          .catalogFor("/project")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* unprobed.settle;
        assert.strictEqual(yield* Fiber.join(waiting), BUNDLED_CLAUDE_MODEL_CATALOG);

        const stuck = yield* makeClaudeCodeModelRoutes(
          Effect.succeed(BUNDLED_CLAUDE_MODEL_CATALOG),
          () => Effect.succeed("same settings"),
          "/state",
        );
        const fallback = yield* stuck
          .catalogFor("/project")
          .pipe(Effect.forkChild({ startImmediately: true }));
        yield* TestClock.adjust("2 minutes");
        assert.strictEqual(yield* Fiber.join(fallback), BUNDLED_CLAUDE_MODEL_CATALOG);
      }),
  );
});
