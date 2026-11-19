import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Queue from "effect/Queue";
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

// Trimmed from Kimi Code 2.6.1's wire.jsonl: a background task finished mid-turn, so Kimi
// steered its notice in, ended the prompt's turn, and ran the notice as its own next turn.
const steeredTurn =
  [
    {
      type: "prompt.steered",
      agentId: "main",
      activePromptId: "msg_prompt",
      promptIds: ["task:bash-1:completed"],
      messageId: "task:bash-1:completed",
      content: [{ type: "text", text: '<notification id="task:bash-1:completed">' }],
    },
    { type: "turn.ended", agentId: "main", turnId: 0, reason: "completed" },
    { type: "prompt.completed", agentId: "main", promptId: "msg_prompt", reason: "completed" },
    {
      type: "turn.prompt",
      agentId: "main",
      input: [{ type: "text", text: '<notification id="task:bash-1:completed">' }],
    },
  ]
    .map((record) => JSON.stringify(record))
    .join("\n") + "\n";

it.layer(NodeServices.layer)("makeKimiPromptOutcomeWatch", (it) => {
  // regression: #36163 Kimi answers session/prompt with end_turn while it keeps working
  it.effect.each([
    {
      case: "the prompt's turn handed off to a steered turn",
      before: completedTurn(0),
      appended: steeredTurn,
      polls: 1,
      settles: false,
    },
    // Sent while that steered turn runs: Kimi queues it and answers at once, writing nothing.
    {
      case: "the prompt was only queued behind Kimi's own turn",
      before: steeredTurn,
      appended: "",
      polls: 41,
      settles: false,
    },
    // Its own turn ends only after the reply; this prompt's turn has not started.
    {
      case: "Kimi's own turn ends after a queued prompt is answered",
      before: steeredTurn,
      appended: completedTurn(1),
      polls: 41,
      settles: false,
    },
    // Slash commands such as /compact answer without starting a turn.
    {
      case: "a slash command answers with no turn",
      before: completedTurn(0),
      appended: "",
      polls: 41,
      settles: true,
    },
  ])(
    "settles as completed: $settles when $case",
    ({ before, appended, polls: pollCount, settles }) =>
      Effect.gen(function* () {
        const fileSystem = yield* FileSystem.FileSystem;
        const path = yield* Path.Path;
        const home = yield* fileSystem.makeTempDirectoryScoped();
        const agentDirectory = path.join(
          home,
          "sessions",
          "wd_proj_1",
          SESSION_ID,
          "agents",
          "main",
        );
        yield* fileSystem.makeDirectory(agentDirectory, { recursive: true });
        const wire = path.join(agentDirectory, "wire.jsonl");
        yield* fileSystem.writeFileString(wire, before);
        const polls = yield* Queue.unbounded<void>();
        const watch = yield* makeKimiPromptOutcomeWatch(home).pipe(
          Effect.provideService(FileSystem.FileSystem, {
            ...fileSystem,
            open: (path, options) =>
              Effect.addFinalizer(() => Queue.offer(polls, undefined)).pipe(
                Effect.andThen(fileSystem.open(path, options)),
              ),
          }),
        );

        const check = yield* watch(SESSION_ID);
        // The watch reads the log once to learn whether Kimi's own turn is still open.
        yield* Queue.take(polls);
        yield* fileSystem.writeFileString(wire, appended, { flag: "a" });
        const outcome = yield* check(endTurn).pipe(Effect.forkChild);
        for (let poll = 1; poll < pollCount; poll++) {
          yield* Queue.take(polls);
          yield* TestClock.adjust("50 millis");
        }
        assert.strictEqual((yield* Fiber.join(outcome)) === undefined, settles);
      }),
  );

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
      // Signals once a poll has closed the log, so the check is already waiting for its next poll.
      const polls = yield* Queue.unbounded<void>();
      const watch = yield* makeKimiPromptOutcomeWatch(home).pipe(
        Effect.provideService(FileSystem.FileSystem, {
          ...fileSystem,
          open: (path, options) =>
            Effect.addFinalizer(() => Queue.offer(polls, undefined)).pipe(
              Effect.andThen(fileSystem.open(path, options)),
            ),
        }),
      );

      const completed = yield* watch(SESSION_ID);
      yield* Queue.take(polls);
      yield* append(completedTurn(1));
      assert.isUndefined(yield* completed(endTurn));
      yield* Queue.take(polls);

      // Kimi answers the prompt before `turn.ended` reaches disk.
      const failed = yield* watch(SESSION_ID);
      yield* Queue.take(polls);
      yield* append(failedTurn(2).slice(0, 40));
      const pending = yield* failed(endTurn).pipe(Effect.forkChild);
      yield* Queue.take(polls);
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
