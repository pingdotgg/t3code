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

const records = (...items: ReadonlyArray<object>) =>
  items.map((record) => JSON.stringify(record)).join("\n") + "\n";
const replyText = (text: string) =>
  records({
    type: "context.append_loop_event",
    agentId: "main",
    event: { type: "content.part", part: { type: "text", text } },
  });
const turnPrompt = (text: string) =>
  records({ type: "turn.prompt", agentId: "main", input: [{ type: "text", text }] });

// Trimmed from Kimi Code 2.6.1's wire.jsonl: a background task finished mid-turn, so Kimi
// steered its notice in, ended the prompt's turn, and ran the notice as its own next turn.
const steeredTurn =
  records(
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
  ) + turnPrompt('<notification id="task:bash-1:completed">');
const notStopped = Effect.succeed(false);

const makeWire = Effect.fn("makeWire")(function* (before: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const home = yield* fileSystem.makeTempDirectoryScoped();
  const agentDirectory = path.join(home, "sessions", "wd_proj_1", SESSION_ID, "agents", "main");
  yield* fileSystem.makeDirectory(agentDirectory, { recursive: true });
  const wire = path.join(agentDirectory, "wire.jsonl");
  yield* fileSystem.writeFileString(wire, before);
  // Signals once a read has closed the log, so the check is already waiting for its next read.
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
  const append = (text: string) => fileSystem.writeFileString(wire, text, { flag: "a" });
  const nextPoll = (interval: "50 millis" | "250 millis") =>
    TestClock.adjust(interval).pipe(Effect.andThen(Queue.take(polls)));
  return { check, append, polls, nextPoll };
});

it.layer(NodeServices.layer)("makeKimiPromptOutcomeWatch", (it) => {
  // regression: #36163 Kimi answers session/prompt with end_turn while it keeps working
  it.effect("follows a steered hand-off until Kimi is idle and returns its reply", () =>
    Effect.gen(function* () {
      const { check, append, polls, nextPoll } = yield* makeWire(completedTurn(0));
      yield* append(steeredTurn + replyText("FINAL: all steps done") + completedTurn(1));
      const outcome = yield* check(endTurn, notStopped).pipe(Effect.forkChild);
      yield* Queue.take(polls);
      yield* nextPoll("250 millis");
      yield* nextPoll("250 millis");
      assert.deepStrictEqual(yield* Fiber.join(outcome), {
        hiddenReply: "FINAL: all steps done",
      });
    }),
  );

  // Sent while that steered turn runs: Kimi queues it and answers at once, writing nothing.
  it.effect(
    "waits out Kimi's own turn for a prompt it only queued, and returns only its reply",
    () =>
      Effect.gen(function* () {
        const { check, append, nextPoll } = yield* makeWire(steeredTurn);
        const outcome = yield* check(endTurn, notStopped).pipe(Effect.forkChild);
        yield* nextPoll("250 millis");
        yield* nextPoll("250 millis");
        yield* nextPoll("250 millis");
        yield* append(replyText("FINAL: all steps done") + completedTurn(1));
        // The queued prompt's own turn can start well after Kimi's turn ends.
        yield* nextPoll("250 millis");
        yield* nextPoll("250 millis");
        yield* nextPoll("250 millis");
        yield* append(
          turnPrompt("Reply with the single word PONG.") + replyText("PONG") + completedTurn(2),
        );
        yield* nextPoll("250 millis");
        yield* nextPoll("250 millis");
        yield* nextPoll("250 millis");
        assert.deepStrictEqual(yield* Fiber.join(outcome), {
          hiddenReply: "PONG",
        });
      }),
  );

  it.effect("stops following Kimi's work once the turn stops", () =>
    Effect.gen(function* () {
      const { check } = yield* makeWire(steeredTurn);
      assert.isUndefined(yield* check(endTurn, Effect.succeed(true)));
    }),
  );

  // Slash commands such as /compact answer without starting a turn.
  it.effect("settles a slash command that answers with no turn", () =>
    Effect.gen(function* () {
      const { check, polls, nextPoll } = yield* makeWire(completedTurn(0));
      const outcome = yield* check(endTurn, notStopped).pipe(Effect.forkChild);
      yield* Queue.take(polls);
      for (let poll = 2; poll <= 41; poll++) yield* nextPoll("50 millis");
      assert.isUndefined(yield* Fiber.join(outcome));
    }),
  );

  it.effect("fails only the turn this prompt ended, once Kimi writes its outcome", () =>
    Effect.gen(function* () {
      // An earlier turn's failure is history, not this prompt's outcome.
      const completed = yield* makeWire(failedTurn(0));
      yield* completed.append(completedTurn(1));
      assert.isUndefined(yield* completed.check(endTurn, notStopped));

      // Kimi answers the prompt before `turn.ended` reaches disk.
      const failed = yield* makeWire(failedTurn(0) + completedTurn(1));
      yield* failed.append(failedTurn(2).slice(0, 40));
      const pending = yield* failed.check(endTurn, notStopped).pipe(Effect.forkChild);
      yield* Queue.take(failed.polls);
      yield* failed.append(failedTurn(2).slice(40));
      yield* TestClock.adjust("50 millis");
      assert.deepStrictEqual(yield* Fiber.join(pending), {
        failure: {
          class: "provider_error",
          message: "upstream overloaded",
          code: "provider.overloaded",
          retryable: true,
        },
      });
    }),
  );
});
