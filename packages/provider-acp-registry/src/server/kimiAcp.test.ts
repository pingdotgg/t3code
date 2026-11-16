import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as TestClock from "effect/testing/TestClock";

import { makeKimiPromptOutcomeWatch } from "./kimiAcp.ts";

const SESSION_ID = "session_06abd65a-ab8c-4f7a-a504-9b105fc7cd0d";
const endTurn = { stopReason: "end_turn" } as const;
// Records trimmed from Kimi Code 2.5.3's wire.jsonl after the follow-up model request failed.
const failedTurn = (turnId: number) =>
  JSON.stringify({
    type: "turn.ended",
    agentId: "main",
    turnId,
    reason: "failed",
    error: {
      code: "provider.overloaded",
      message: "upstream overloaded",
      name: "APIProviderOverloadedError",
      details: { statusCode: 500 },
      retryable: true,
    },
    durationMs: 138873,
    time: 1794813146537,
  }) + "\n";
const completedTurn = (turnId: number) =>
  JSON.stringify({ type: "turn.ended", agentId: "main", turnId, reason: "completed" }) + "\n";

it.layer(NodeServices.layer)("makeKimiPromptOutcomeWatch", (it) => {
  it.effect("fails only the turn this prompt ended, once Kimi writes its outcome", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* fileSystem.makeTempDirectoryScoped();
      const agentDirectory = path.join(home, "sessions", "wd_proj_1", SESSION_ID, "agents", "main");
      yield* fileSystem.makeDirectory(agentDirectory, { recursive: true });
      const wire = path.join(agentDirectory, "wire.jsonl");
      // An earlier turn's failure is history, not this prompt's outcome.
      yield* fileSystem.writeFileString(wire, failedTurn(0));
      const append = (text: string) => fileSystem.writeFileString(wire, text, { flag: "a" });
      const watch = yield* makeKimiPromptOutcomeWatch(home);

      const completed = yield* watch(SESSION_ID);
      yield* append(completedTurn(1));
      assert.isUndefined(yield* completed(endTurn));

      // Kimi answers the prompt before `turn.ended` reaches disk.
      const failed = yield* watch(SESSION_ID);
      const pending = yield* failed(endTurn).pipe(Effect.forkChild);
      yield* append(failedTurn(2).slice(0, 40));
      yield* TestClock.adjust("50 millis");
      yield* append(failedTurn(2).slice(40));
      yield* TestClock.adjust("50 millis");
      assert.deepStrictEqual(yield* Fiber.join(pending), {
        class: "provider_error",
        message: "upstream overloaded",
        code: "provider.overloaded",
        retryable: true,
      });
    }),
  );
});
