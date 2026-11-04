import {
  CommandId,
  EventId,
  type OrchestrationV2SideChatOutcome,
  ScheduledTaskId,
  SIDE_CHAT_NOTES_HANDOFF_TITLE,
  SIDE_CHAT_WAIT_CAP_MS,
  type ThreadId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as EventSink from "../EventSink.ts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as TestClock from "effect/testing/TestClock";

import { withWorkspaceLease } from "../../workspace/workspaceLease.ts";
import * as Orchestrator from "../Orchestrator.ts";
import {
  buildSideChatNotesSummaryText,
  isSideChatNotesHandoff,
  SIDE_CHAT_NOTES_HEADER,
} from "../sideChat/notes.ts";
import {
  makeSideChatHarness,
  type SideChatHarness,
  type SideChatNoteScript,
} from "./SideChatHarness.ts";

const SPACE = "observation space";
const BOX = "Box";
const SPACE_QUESTION = "What is an observation space?";
const BOX_QUESTION = "What is a Box?";
const SPACE_NOTE = "They had not met observation spaces before.";
const BOX_NOTE = "They did not know that a Box has bounds.";
const BOX_BOUNDS_NOTE = "Did not know Box bounds.";
const SHAPING = "reward shaping";
const SHAPING_NOTE = "They thought shaping changes the goal.";
const spaceLine = `• re "observation space": ${SPACE_NOTE}`;
const boxLine = `• re "Box": ${BOX_BOUNDS_NOTE}`;
const shapingLine = `• re "reward shaping": ${SHAPING_NOTE}`;

const headerCount = (prompt: string): number => prompt.split(SIDE_CHAT_NOTES_HEADER).length - 1;

/** Presses Done on `threadId` with its note scripted, and returns the request id it settled on. */
const finishWithNote = Effect.fn("finishWithNote")(function* (
  harness: SideChatHarness,
  threadId: ThreadId,
  excerpt: string,
  script: SideChatNoteScript,
  status: OrchestrationV2SideChatOutcome["status"],
) {
  harness.scriptNote(excerpt, script);
  const after = yield* harness.mark;
  yield* harness.finish(threadId);
  const finished = yield* harness.awaitOutcome(after, threadId, status);
  return finished.sideChat?.done?.outcome.requestId;
});

/** A lesson with the `observation space` side chat answered and done with a ready note. */
const lessonWithSpaceNote = Effect.fn("lessonWithSpaceNote")(function* (harness: SideChatHarness) {
  const lesson = yield* harness.createLesson("Teach me RL environments.");
  const space = yield* harness.openSideChat({ parentThreadId: lesson, label: SPACE });
  yield* harness.send(space, SPACE_QUESTION);
  yield* finishWithNote(harness, space, SPACE, { text: SPACE_NOTE }, "ready");
  return lesson;
});

/** A lesson with `observation space` open below it and `Box` open below that, both answered. */
const lessonWithNestedSideChats = Effect.fn("lessonWithNestedSideChats")(function* (
  harness: SideChatHarness,
) {
  const lesson = yield* harness.createLesson("Teach me RL environments.");
  const space = yield* harness.openSideChat({ parentThreadId: lesson, label: SPACE });
  yield* harness.send(space, SPACE_QUESTION);
  const box = yield* harness.openSideChat({ parentThreadId: space, label: BOX });
  yield* harness.send(box, BOX_QUESTION);
  return { lesson, space, box };
});

/**
 * A lesson whose turn `[hold] Explain rewards.` is still running, with the `observation space`
 * side chat done with a ready note. The side chat's own turn was held while the lesson's started.
 */
const heldLessonWithSpaceNote = Effect.fn("heldLessonWithSpaceNote")(function* (
  harness: SideChatHarness,
) {
  const lesson = yield* harness.createLesson("Teach me RL environments.");
  const space = yield* harness.openSideChat({ parentThreadId: lesson, label: SPACE });
  const spaceQuestion = yield* harness.send(space, `[hold] ${SPACE_QUESTION}`);
  const heldLessonMessage = yield* harness.send(lesson, "[hold] Explain rewards.");
  const afterSpace = yield* harness.mark;
  yield* harness.finishHeldTurn(space);
  yield* harness.awaitRun(afterSpace, spaceQuestion, "completed");
  yield* finishWithNote(harness, space, SPACE, { text: SPACE_NOTE }, "ready");
  return { lesson, heldLessonMessage };
});

describe("side-chat notes", () => {
  it.effect("the lesson's next user prompt carries every ready note in one handoff", () =>
    Effect.gen(function* () {
      const harness = yield* makeSideChatHarness("side-chat-notes-ready");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const lesson = yield* harness.createLesson("Teach me RL environments.");
        const space = yield* harness.openSideChat({ parentThreadId: lesson, label: SPACE });
        const box = yield* harness.openSideChat({ parentThreadId: lesson, label: BOX });
        yield* harness.send(space, SPACE_QUESTION);
        yield* harness.send(box, BOX_QUESTION);
        const spaceRequestId = yield* finishWithNote(
          harness,
          space,
          SPACE,
          { text: SPACE_NOTE },
          "ready",
        );
        yield* TestClock.adjust("1 second");
        const boxRequestId = yield* finishWithNote(harness, box, BOX, { text: BOX_NOTE }, "ready");

        yield* harness.send(lesson, "Continue the lesson.");

        const expected = buildSideChatNotesSummaryText([
          { label: SPACE, note: SPACE_NOTE },
          { label: BOX, note: BOX_NOTE },
        ]);
        const prompt = harness.prompts(lesson).at(-1) ?? "";
        assert.equal(prompt, `${expected}\n\nUser message:\nContinue the lesson.`);
        assert.equal(headerCount(prompt), 1);
        assert.isTrue(prompt.endsWith("User message:\nContinue the lesson."));
        // R3: the side chats' conversations stay out of the lesson.
        assert.notInclude(prompt, SPACE_QUESTION);
        assert.notInclude(prompt, BOX_QUESTION);

        const projection = yield* orchestrator.getThreadProjection(lesson);
        assert.deepEqual(
          projection.contextHandoffs
            .filter(isSideChatNotesHandoff)
            .map((handoff) => handoff.summaryText),
          [expected],
        );
        assert.deepEqual(projection.thread.sideChatNoteDeliveries, {
          [space]: spaceRequestId,
          [box]: boxRequestId,
        });
        assert.lengthOf(
          projection.turnItems.filter(
            (item) => item.type === "handoff" && item.title === SIDE_CHAT_NOTES_HANDOFF_TITLE,
          ),
          1,
        );
        assert.deepEqual(
          projection.contextTransfers.filter(
            (transfer) => transfer.type === "fork" || transfer.type === "merge_back",
          ),
          [],
        );

        yield* harness.send(lesson, "Next step.");
        assert.equal(headerCount(harness.prompts(lesson).at(-1) ?? ""), 0);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.scoped),
  );

  it.effect.each([{ oversized: false }, { oversized: true }])(
    "keeps zero-budget note delivery honest (oversized=$oversized)",
    ({ oversized }) =>
      Effect.gen(function* () {
        const harness = yield* makeSideChatHarness(`side-chat-notes-zero-${oversized}`);
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const eventSink = yield* EventSink.EventSinkV2;
          const lesson = yield* harness.createLesson("Teach me RL environments.");
          const space = yield* harness.openSideChat({ parentThreadId: lesson, label: SPACE });
          yield* harness.send(space, SPACE_QUESTION);
          const requestId = yield* finishWithNote(
            harness,
            space,
            SPACE,
            { text: SPACE_NOTE },
            "ready",
          );
          const { providerThreads } = yield* orchestrator.getThreadProjection(lesson);
          const providerThread = providerThreads.at(-1)!;
          yield* eventSink.write({
            events: [
              {
                id: EventId.make("event:zero-budget"),
                type: "provider-thread.updated",
                threadId: lesson,
                occurredAt: yield* DateTime.now,
                payload: {
                  ...providerThread,
                  contextUsage: { usedTokens: 155_000, maxTokens: 200_000 },
                },
              },
            ],
          });
          if (oversized) {
            for (const label of [BOX, SHAPING, "bounded vector", "reward"]) {
              const child = yield* harness.openSideChat({ parentThreadId: lesson, label });
              yield* harness.send(child, `Explain ${label}.`);
              yield* finishWithNote(harness, child, label, { text: "界".repeat(300) }, "ready");
            }
          }
          yield* harness.send(lesson, "Continue the lesson.");
          const prompt = harness.prompts(lesson).at(-1) ?? "";
          const thread = yield* harness.thread(lesson);
          if (oversized) {
            assert.equal(prompt, "Continue the lesson.");
            assert.isUndefined(thread.sideChatNoteDeliveries?.[space]);
            yield* eventSink.write({
              events: [
                {
                  id: EventId.make("event:budget-restored"),
                  type: "provider-thread.updated",
                  threadId: lesson,
                  occurredAt: yield* DateTime.now,
                  payload: {
                    ...providerThread,
                    contextUsage: { usedTokens: 1_000, maxTokens: 200_000 },
                  },
                },
              ],
            });
            yield* harness.send(lesson, "Next step.");
            assert.include(harness.prompts(lesson).at(-1), SPACE_NOTE);
            assert.equal(headerCount(harness.prompts(lesson).at(-1) ?? ""), 1);
            assert.equal(
              (yield* harness.thread(lesson)).sideChatNoteDeliveries?.[space],
              requestId,
            );
          } else {
            assert.include(prompt, SPACE_NOTE);
            assert.equal(thread.sideChatNoteDeliveries?.[space], requestId);
          }
        }).pipe(Effect.provide(harness.layer));
      }).pipe(Effect.scoped),
  );

  it.effect("no note and a failed note add nothing to the lesson's prompt", () =>
    Effect.gen(function* () {
      const harness = yield* makeSideChatHarness("side-chat-notes-none");
      yield* Effect.gen(function* () {
        const lesson = yield* harness.createLesson("Teach me RL environments.");
        const space = yield* harness.openSideChat({ parentThreadId: lesson, label: SPACE });
        const box = yield* harness.openSideChat({ parentThreadId: lesson, label: BOX });
        yield* harness.send(space, SPACE_QUESTION);
        yield* harness.send(box, BOX_QUESTION);
        yield* finishWithNote(harness, space, SPACE, { text: null }, "none");
        yield* finishWithNote(harness, box, BOX, { fail: "model unavailable" }, "failed");

        yield* harness.send(lesson, "Continue the lesson.");

        assert.equal(headerCount(harness.prompts(lesson).at(-1) ?? ""), 0);
        assert.isUndefined((yield* harness.thread(lesson)).sideChatNoteDeliveries);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.scoped),
  );

  it.effect("a scheduled-task message neither carries nor consumes notes", () =>
    Effect.gen(function* () {
      const harness = yield* makeSideChatHarness("side-chat-notes-scheduled");
      yield* Effect.gen(function* () {
        const lesson = yield* lessonWithSpaceNote(harness);

        yield* harness.send(lesson, "Run the nightly check.", {
          scheduledTaskId: ScheduledTaskId.make("scheduled:nightly"),
        });

        assert.equal(headerCount(harness.prompts(lesson).at(-1) ?? ""), 0);
        assert.isUndefined((yield* harness.thread(lesson)).sideChatNoteDeliveries);

        yield* harness.send(lesson, "Continue the lesson.");
        assert.include(harness.prompts(lesson).at(-1), spaceLine);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.scoped),
  );

  it.effect("a queued lesson message carries notes that became ready before it started", () =>
    Effect.gen(function* () {
      const harness = yield* makeSideChatHarness("side-chat-notes-queued");
      yield* Effect.gen(function* () {
        const { lesson } = yield* heldLessonWithSpaceNote(harness);

        const after = yield* harness.mark;
        const queued = yield* harness.send(lesson, "Continue the lesson.", {
          dispatchMode: { type: "queue_after_active" },
          await: "none",
        });
        yield* harness.finishHeldTurn(lesson);
        yield* harness.awaitRun(after, queued, "completed");

        const prompts = harness.prompts(lesson);
        assert.equal(headerCount(prompts.at(-2) ?? ""), 0);
        assert.include(prompts.at(-1), spaceLine);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.scoped),
  );

  it.effect("a user message waits for a note that is still being written", () =>
    Effect.gen(function* () {
      const harness = yield* makeSideChatHarness("side-chat-notes-wait");
      yield* Effect.gen(function* () {
        const lesson = yield* harness.createLesson("Teach me RL environments.");
        const space = yield* harness.openSideChat({ parentThreadId: lesson, label: SPACE });
        yield* harness.send(space, SPACE_QUESTION);
        const gate = yield* Deferred.make<string | null>();
        harness.scriptNote(SPACE, { gate });
        yield* harness.finish(space);
        yield* harness.noteRequested(SPACE);

        const after = yield* harness.mark;
        const message = yield* harness.send(lesson, "Continue the lesson.", { await: "none" });
        yield* Deferred.succeed(gate, SPACE_NOTE);
        yield* harness.awaitRun(after, message, "completed");

        assert.include(harness.prompts(lesson).at(-1), spaceLine);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.scoped),
  );

  it.effect("a cancelled queued lesson message does not consume notes", () =>
    Effect.gen(function* () {
      const harness = yield* makeSideChatHarness("side-chat-notes-cancelled");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const { lesson, heldLessonMessage } = yield* heldLessonWithSpaceNote(harness);

        const after = yield* harness.mark;
        const queued = yield* harness.send(lesson, "Continue.", {
          dispatchMode: { type: "queue_after_active" },
          await: "none",
        });
        const queuedRun = (yield* orchestrator.getThreadProjection(lesson)).runs.find(
          (run) => run.status === "queued",
        );
        assert(queuedRun !== undefined);
        yield* orchestrator.dispatch({
          type: "queued-run.cancel",
          commandId: CommandId.make("cancel-queued"),
          threadId: lesson,
          runId: queuedRun.id,
        });
        yield* harness.awaitRun(after, queued, "cancelled");

        yield* harness.finishHeldTurn(lesson);
        yield* harness.awaitRun(after, heldLessonMessage, "completed");
        assert.isUndefined((yield* harness.thread(lesson)).sideChatNoteDeliveries);

        yield* harness.send(lesson, "Next step.");
        assert.include(harness.prompts(lesson).at(-1), spaceLine);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.scoped),
  );

  // PF-11: a handoff left by a run that never reached the provider rides the next run, but notes
  // only ride the user's own messages.
  it.effect("a stopped lesson turn's notes wait for the user's next message", () =>
    Effect.gen(function* () {
      const harness = yield* makeSideChatHarness("side-chat-notes-stopped");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const lesson = yield* lessonWithSpaceNote(harness);
        const worktreePath = (yield* harness.thread(lesson)).worktreePath;
        assert(worktreePath !== null);
        // Holding the lesson's worktree keeps its next turn from reaching the provider.
        const leaseTaken = yield* Deferred.make<void>();
        const releaseLease = yield* Deferred.make<void>();
        yield* withWorkspaceLease(
          worktreePath,
          Deferred.succeed(leaseTaken, undefined).pipe(
            Effect.andThen(Deferred.await(releaseLease)),
          ),
        ).pipe(Effect.forkScoped);
        yield* Deferred.await(leaseTaken);

        const after = yield* harness.mark;
        const stopped = yield* harness.send(lesson, "Continue the lesson.", { await: "none" });
        yield* harness.awaitEvent(
          after,
          (event) =>
            event.type === "context-handoff.updated" &&
            event.threadId === lesson &&
            isSideChatNotesHandoff(event.payload),
        );
        assert.isUndefined((yield* harness.thread(lesson)).sideChatNoteDeliveries);
        yield* orchestrator.dispatch({
          type: "thread.stop",
          commandId: CommandId.make("stop-lesson"),
          threadId: lesson,
        });
        yield* harness.awaitRun(after, stopped, "interrupted");
        yield* Deferred.succeed(releaseLease, undefined);

        yield* harness.send(lesson, "Run the nightly check.", {
          scheduledTaskId: ScheduledTaskId.make("scheduled:nightly"),
        });
        assert.equal(headerCount(harness.prompts(lesson).at(-1) ?? ""), 0);

        yield* harness.send(lesson, "Next step.");
        assert.include(harness.prompts(lesson).at(-1), spaceLine);
        assert.equal(headerCount(harness.prompts(lesson).at(-1) ?? ""), 1);

        yield* harness.send(lesson, "And after that.");
        assert.equal(harness.prompts(lesson).at(-1), "And after that.");
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.scoped),
  );

  it.effect(
    "a side-chat message finishes its idle nested side chats and carries their note, which its own note takes on",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeSideChatHarness("side-chat-notes-auto-done-side-chat");
        yield* Effect.gen(function* () {
          const { lesson, space, box } = yield* lessonWithNestedSideChats(harness);
          harness.scriptNote(BOX, { text: BOX_BOUNDS_NOTE });

          yield* harness.send(space, "Back to observation spaces.");

          assert.equal((yield* harness.thread(box)).sideChat?.done?.outcome.status, "ready");
          assert.include(harness.prompts(space).at(-1), boxLine);
          assert.isNull((yield* harness.thread(space)).sideChat?.done);
          for (const prompt of harness.prompts(lesson)) {
            assert.notInclude(prompt, SIDE_CHAT_NOTES_HEADER);
          }

          yield* finishWithNote(harness, space, SPACE, { text: SPACE_NOTE }, "ready");
          assert.include(harness.outcomeInputFor(SPACE), boxLine);
        }).pipe(Effect.provide(harness.layer));
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a lesson message finishes idle side chats, nested ones included, and carries their note",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeSideChatHarness("side-chat-notes-auto-done-lesson");
        yield* Effect.gen(function* () {
          const { lesson, space, box } = yield* lessonWithNestedSideChats(harness);
          harness.scriptNote(BOX, { text: BOX_BOUNDS_NOTE });
          harness.scriptNote(SPACE, { text: SPACE_NOTE });

          yield* harness.send(lesson, "Continue the lesson.");

          assert.equal((yield* harness.thread(space)).sideChat?.done?.outcome.status, "ready");
          assert.equal((yield* harness.thread(box)).sideChat?.done?.outcome.status, "ready");
          assert.include(harness.outcomeInputFor(SPACE), boxLine);
          const prompt = harness.prompts(lesson).at(-1) ?? "";
          assert.include(prompt, spaceLine);
          assert.notInclude(prompt, boxLine);
        }).pipe(Effect.provide(harness.layer));
      }).pipe(Effect.scoped),
  );

  it.effect("a lesson message leaves a side chat that is still answering open", () =>
    Effect.gen(function* () {
      const harness = yield* makeSideChatHarness("side-chat-notes-auto-done-answering");
      yield* Effect.gen(function* () {
        const lesson = yield* harness.createLesson("Teach me RL environments.");
        const space = yield* harness.openSideChat({ parentThreadId: lesson, label: SPACE });
        const after = yield* harness.mark;
        const question = yield* harness.send(space, `[hold] ${SPACE_QUESTION}`);

        yield* harness.send(lesson, "Continue the lesson.");

        assert.isNull((yield* harness.thread(space)).sideChat?.done);
        assert.equal(headerCount(harness.prompts(lesson).at(-1) ?? ""), 0);

        yield* harness.finishHeldTurn(space);
        yield* harness.awaitRun(after, question, "completed");
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.scoped),
  );

  it.effect(
    "a lesson message leaves a side chat open while a side chat below it is still answering",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeSideChatHarness("side-chat-notes-auto-done-nested-answering");
        yield* Effect.gen(function* () {
          const lesson = yield* harness.createLesson("Teach me RL environments.");
          const space = yield* harness.openSideChat({ parentThreadId: lesson, label: SPACE });
          yield* harness.send(space, SPACE_QUESTION);
          const box = yield* harness.openSideChat({ parentThreadId: space, label: BOX });
          const after = yield* harness.mark;
          const question = yield* harness.send(box, `[hold] ${BOX_QUESTION}`);

          yield* harness.send(lesson, "Continue the lesson.");

          assert.isNull((yield* harness.thread(space)).sideChat?.done);
          assert.isNull((yield* harness.thread(box)).sideChat?.done);
          assert.equal(headerCount(harness.prompts(lesson).at(-1) ?? ""), 0);

          // Once `Box` has answered, the next lesson message finishes both and its note chains up.
          yield* harness.finishHeldTurn(box);
          yield* harness.awaitRun(after, question, "completed");
          harness.scriptNote(BOX, { text: BOX_BOUNDS_NOTE });
          harness.scriptNote(SPACE, { text: SPACE_NOTE });
          yield* harness.send(lesson, "Next step.");

          assert.include(harness.outcomeInputFor(SPACE), boxLine);
          assert.include(harness.prompts(lesson).at(-1), spaceLine);
        }).pipe(Effect.provide(harness.layer));
      }).pipe(Effect.scoped),
  );

  it.effect(
    "opening a side chat under a done one reopens it and the done side chats above it, so the new note reaches the lesson",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeSideChatHarness("side-chat-notes-open-under-done");
        yield* Effect.gen(function* () {
          const { lesson, space, box } = yield* lessonWithNestedSideChats(harness);
          // Done on `observation space` finishes `Box` below it too.
          yield* finishWithNote(harness, space, SPACE, { text: SPACE_NOTE }, "ready");

          const shaping = yield* harness.openSideChat({ parentThreadId: box, label: SHAPING });

          assert.isNull((yield* harness.thread(box)).sideChat?.done);
          assert.isNull((yield* harness.thread(space)).sideChat?.done);

          const after = yield* harness.mark;
          const question = yield* harness.send(shaping, "[hold] What is reward shaping?");
          yield* harness.send(lesson, "Continue the lesson.");
          assert.isNull((yield* harness.thread(box)).sideChat?.done);
          assert.isNull((yield* harness.thread(space)).sideChat?.done);

          yield* harness.finishHeldTurn(shaping);
          yield* harness.awaitRun(after, question, "completed");
          harness.scriptNote(SHAPING, { text: SHAPING_NOTE });
          harness.scriptNote(BOX, { text: BOX_BOUNDS_NOTE });
          harness.scriptNote(SPACE, { text: SPACE_NOTE });
          yield* harness.send(lesson, "Next step.");

          assert.include(harness.outcomeInputFor(BOX), shapingLine);
          assert.include(harness.outcomeInputFor(SPACE), boxLine);
          assert.include(harness.prompts(lesson).at(-1), spaceLine);
        }).pipe(Effect.provide(harness.layer));
      }).pipe(Effect.scoped),
  );

  it.effect("a message in a side chat reopens the done side chats above it", () =>
    Effect.gen(function* () {
      const harness = yield* makeSideChatHarness("side-chat-notes-message-under-done");
      yield* Effect.gen(function* () {
        const lesson = yield* harness.createLesson("Teach me RL environments.");
        const space = yield* harness.openSideChat({ parentThreadId: lesson, label: SPACE });
        yield* harness.send(space, SPACE_QUESTION);
        const box = yield* harness.openSideChat({ parentThreadId: space, label: BOX });
        // Nobody has written in `Box` yet, so the lesson message finishes only its parent.
        yield* harness.send(lesson, "Continue the lesson.");

        yield* harness.send(box, BOX_QUESTION);

        assert.isNull((yield* harness.thread(space)).sideChat?.done);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.scoped),
  );

  it.effect(
    "a side chat reopened before the lesson received its note still carries its nested side chats' notes",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeSideChatHarness("side-chat-notes-reopen-chain-up");
        yield* Effect.gen(function* () {
          const { space, box } = yield* lessonWithNestedSideChats(harness);
          yield* finishWithNote(harness, box, BOX, { text: BOX_BOUNDS_NOTE }, "ready");
          yield* finishWithNote(harness, space, SPACE, { text: SPACE_NOTE }, "ready");
          assert.include(harness.outcomeInputFor(SPACE), boxLine);

          yield* harness.send(space, "One more question.");
          assert.isNull((yield* harness.thread(space)).sideChat?.done);

          yield* finishWithNote(harness, space, SPACE, { text: SPACE_NOTE }, "ready");
          const input = harness.outcomeInputFor(SPACE) ?? "";
          assert.include(input, "User: One more question.");
          assert.include(input, boxLine);
        }).pipe(Effect.provide(harness.layer));
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a side chat whose note writer answers null still carries its nested side chats' notes to the lesson, once",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeSideChatHarness("side-chat-notes-null-chain-up");
        yield* Effect.gen(function* () {
          const { lesson, space, box } = yield* lessonWithNestedSideChats(harness);
          const boxRequestId = yield* finishWithNote(
            harness,
            box,
            BOX,
            { text: BOX_BOUNDS_NOTE },
            "ready",
          );
          yield* finishWithNote(harness, space, SPACE, { text: SPACE_NOTE }, "ready");
          // Reopens `observation space` and drops the note that carried `Box`'s.
          yield* harness.send(space, "One more question.");

          harness.scriptNote(SPACE, { text: null });
          yield* harness.send(lesson, "Continue the lesson.");

          const fallback = `re "Box": ${BOX_BOUNDS_NOTE}`;
          const finished = yield* harness.thread(space);
          assert.equal(finished.sideChat?.done?.outcome.status, "ready");
          assert.equal(finished.sideChat?.done?.outcome.note, fallback);
          assert.equal(finished.sideChatNoteDeliveries?.[box], boxRequestId);
          assert.include(harness.prompts(lesson).at(-1), `• re "observation space": ${fallback}`);

          // The lesson has it now, so a null answer after another reopen sends nothing again.
          yield* harness.send(space, "And another.");
          harness.scriptNote(SPACE, { text: null });
          yield* harness.send(lesson, "Next step.");

          assert.equal((yield* harness.thread(space)).sideChat?.done?.outcome.status, "none");
          assert.equal(headerCount(harness.prompts(lesson).at(-1) ?? ""), 0);
        }).pipe(Effect.provide(harness.layer));
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a nested note the lesson received through its parent side chat never goes up again",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeSideChatHarness("side-chat-notes-settled-chain-up");
        yield* Effect.gen(function* () {
          const { lesson, space, box } = yield* lessonWithNestedSideChats(harness);
          yield* finishWithNote(harness, box, BOX, { text: BOX_BOUNDS_NOTE }, "ready");
          // `observation space` takes `Box`'s note in its own turn as well as at Done.
          yield* harness.send(space, "Back to spaces.");
          yield* finishWithNote(harness, space, SPACE, { text: SPACE_NOTE }, "ready");
          assert.include(harness.outcomeInputFor(SPACE), boxLine);
          yield* harness.send(lesson, "Continue the lesson.");

          // A nested side chat asked after the lesson received that note still goes up.
          yield* harness.send(space, "One more question.");
          const shaping = yield* harness.openSideChat({ parentThreadId: space, label: SHAPING });
          yield* harness.send(shaping, "What is reward shaping?");
          harness.scriptNote(SHAPING, { text: SHAPING_NOTE });
          yield* finishWithNote(
            harness,
            space,
            SPACE,
            { text: "Wanted a worked example." },
            "ready",
          );
          assert.include(harness.outcomeInputFor(SPACE), shapingLine);
          assert.notInclude(harness.outcomeInputFor(SPACE), boxLine);
          yield* harness.send(lesson, "Next step.");

          // The note kept for the next reopen no longer mentions either nested point.
          yield* harness.send(space, "And another.");
          yield* finishWithNote(harness, space, SPACE, { text: null }, "none");
          assert.notInclude(harness.outcomeInputFor(SPACE), boxLine);
          assert.notInclude(harness.outcomeInputFor(SPACE), shapingLine);
        }).pipe(Effect.provide(harness.layer));
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a nested side chat reopened before the lesson received its parent's note writes its whole note again",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeSideChatHarness("side-chat-notes-reopen-nested");
        yield* Effect.gen(function* () {
          const { space, box } = yield* lessonWithNestedSideChats(harness);
          harness.scriptNote(BOX, { text: BOX_BOUNDS_NOTE });
          yield* finishWithNote(harness, space, SPACE, { text: SPACE_NOTE }, "ready");
          assert.include(harness.outcomeInputFor(SPACE), boxLine);

          // Reopens `observation space` too, which drops the only note that carried `Box`'s.
          yield* harness.send(box, "Follow-up.");
          assert.isUndefined((yield* harness.thread(box)).sideChat?.deliveredNote);

          harness.scriptNote(BOX, { text: BOX_BOUNDS_NOTE });
          yield* finishWithNote(harness, space, SPACE, { text: SPACE_NOTE }, "ready");
          assert.notInclude(harness.outcomeInputFor(BOX), "Note already sent to the lesson");
          assert.include(harness.outcomeInputFor(SPACE), boxLine);
        }).pipe(Effect.provide(harness.layer));
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a lesson message leaves side chats nobody wrote in open, without holding their parent open",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeSideChatHarness("side-chat-notes-auto-done-empty");
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const lesson = yield* harness.createLesson("Teach me RL environments.");
          const space = yield* harness.openSideChat({ parentThreadId: lesson, label: SPACE });
          yield* harness.send(space, SPACE_QUESTION);
          const box = yield* harness.openSideChat({ parentThreadId: space, label: BOX });
          const shaping = yield* harness.openSideChat({
            parentThreadId: lesson,
            label: "reward shaping",
          });

          yield* harness.send(lesson, "Continue the lesson.");

          const state = (threadId: ThreadId) =>
            orchestrator
              .getThreadShell(threadId)
              .pipe(Effect.map((shell) => shell?.sideChat?.state));
          assert.equal(yield* state(shaping), "open");
          assert.equal(yield* state(box), "open");
          assert.equal(yield* state(space), "done");
        }).pipe(Effect.provide(harness.layer));
      }).pipe(Effect.scoped),
  );

  it.effect(
    "a lesson message goes ahead without a note still being written after the wait cap, and the note rides the next message",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeSideChatHarness("side-chat-notes-auto-done-cap");
        yield* Effect.gen(function* () {
          const lesson = yield* harness.createLesson("Teach me RL environments.");
          const space = yield* harness.openSideChat({ parentThreadId: lesson, label: SPACE });
          yield* harness.send(space, SPACE_QUESTION);
          const gate = yield* Deferred.make<string | null>();
          harness.scriptNote(SPACE, { gate });

          const after = yield* harness.mark;
          const message = yield* harness.send(lesson, "Continue the lesson.", { await: "none" });
          yield* harness.noteRequested(SPACE);

          yield* TestClock.adjust(Duration.millis(SIDE_CHAT_WAIT_CAP_MS));
          yield* harness.awaitRun(after, message, "completed");
          assert.equal(headerCount(harness.prompts(lesson).at(-1) ?? ""), 0);

          yield* Deferred.succeed(gate, SPACE_NOTE);
          yield* harness.awaitOutcome(after, space, "ready");
          yield* harness.send(lesson, "Next step.");
          assert.include(harness.prompts(lesson).at(-1), spaceLine);
        }).pipe(Effect.provide(harness.layer));
      }).pipe(Effect.scoped),
  );
});
