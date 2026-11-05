import {
  CommandId,
  MessageId,
  ScheduledTaskId,
  SIDE_CHAT_WAIT_CAP_MS,
  type ThreadId,
} from "@t3tools/contracts";
import { assert, describe, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import * as EventSink from "../EventSink.ts";
import * as Orchestrator from "../Orchestrator.ts";
import * as EffectWorker from "../EffectWorker.ts";
import { SIDE_CHAT_OUTCOME_EXCERPT_HEADER } from "../sideChat/notes.ts";
import {
  makeSideChatHarness,
  SIDE_CHAT_HARNESS_REPLY,
  type SideChatHarness,
} from "./SideChatHarness.ts";

const SPACE = "observation space";
const SPACE_QUESTION = "What is an observation space?";
const SPACE_NOTE = "They had not met observation spaces before.";
const BOX = "Box";
const BOX_QUESTION = "What is a Box?";
const BOX_NOTE = "Did not know Box bounds.";
const SPACE_LINE = `• re "observation space": ${SPACE_NOTE}`;
const BOX_LINE = `• re "Box": ${BOX_NOTE}`;

/** Resolves once a command with `commandId` has written its events after `after`. */
const awaitCommand = (after: number, commandId: string) =>
  EventSink.EventSinkV2.use((eventSink) =>
    eventSink.stream({ afterSequence: after }).pipe(
      Stream.filter((stored) => stored.commandId === CommandId.make(commandId)),
      Stream.runHead,
    ),
  );

/** Presses Done on `threadId` with the note `text` scripted, and returns the side chat once ready. */
const finishWithNote = Effect.fn("finishWithNote")(function* (
  harness: SideChatHarness,
  threadId: ThreadId,
  excerpt: string,
  text: string,
) {
  harness.scriptNote(excerpt, { text });
  const after = yield* harness.mark;
  yield* harness.finish(threadId);
  return yield* harness.awaitOutcome(after, threadId, "ready");
});

describe("side chat Done", () => {
  it.effect("opens a side chat on a highlight in the lesson's reply", () =>
    Effect.gen(function* () {
      const harness = yield* makeSideChatHarness("side-chat-harness");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const lesson = yield* harness.createLesson("Teach me RL environments.");

        const space = yield* harness.openSideChat({
          parentThreadId: lesson,
          label: "observation space",
        });

        const shell = yield* orchestrator.getThreadShell(space);
        assert.equal(shell?.sideChat?.label, "observation space");
        assert.equal(shell?.sideChat?.lessonThreadId, lesson);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.scoped),
  );

  it.effect("Done writes a short note for a side chat with messages", () =>
    Effect.gen(function* () {
      const harness = yield* makeSideChatHarness("side-chat-done-note");
      yield* Effect.gen(function* () {
        const lesson = yield* harness.createLesson("Teach me RL environments.");
        const space = yield* harness.openSideChat({ parentThreadId: lesson, label: SPACE });
        yield* harness.send(space, SPACE_QUESTION);
        harness.scriptNote(SPACE, { text: "  The learner had not met\nobservation spaces. " });

        const after = yield* harness.mark;
        yield* harness.finish(space);
        const finished = yield* harness.awaitOutcome(after, space, "ready");

        assert.equal(
          finished.sideChat?.done?.outcome.note,
          "The learner had not met observation spaces.",
        );
        const input = harness.outcomeInputFor(SPACE) ?? "";
        const header = `${SIDE_CHAT_OUTCOME_EXCERPT_HEADER}\n${SPACE}\n`;
        assert.equal(input.slice(0, header.length), header);
        assert.include(input, `User: ${SPACE_QUESTION}`);
        assert.include(input, `Assistant: ${SIDE_CHAT_HARNESS_REPLY}`);
        // R6: nothing of the side chat reached the lesson's provider.
        assert.lengthOf(harness.prompts(lesson), 1);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.scoped),
  );

  it.effect.each([
    { script: { text: null }, status: "none", error: undefined },
    { script: { fail: "model unavailable" }, status: "failed", error: "model unavailable" },
  ] as const)("Done records a $status outcome without a note", ({ script, status, error }) =>
    Effect.gen(function* () {
      const harness = yield* makeSideChatHarness(`side-chat-done-${status}`);
      yield* Effect.gen(function* () {
        const lesson = yield* harness.createLesson("Teach me RL environments.");
        const space = yield* harness.openSideChat({ parentThreadId: lesson, label: SPACE });
        yield* harness.send(space, SPACE_QUESTION);
        harness.scriptNote(SPACE, script);

        const after = yield* harness.mark;
        yield* harness.finish(space);
        const finished = yield* harness.awaitOutcome(after, space, status);

        assert.isDefined(harness.outcomeInputFor(SPACE));
        assert.isNull(finished.sideChat?.done?.outcome.note);
        assert.equal(finished.sideChat?.done?.outcome.error, error);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.scoped),
  );

  it.effect("Done deletes a side chat nobody wrote in", () =>
    Effect.gen(function* () {
      const harness = yield* makeSideChatHarness("side-chat-done-empty");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const lesson = yield* harness.createLesson("Teach me RL environments.");
        const space = yield* harness.openSideChat({ parentThreadId: lesson, label: SPACE });

        yield* harness.finish(space);

        assert.isNull(yield* orchestrator.getThreadShell(space));
        assert.deepEqual(harness.outcomeInputs(), []);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.scoped),
  );

  it.effect("Discard deletes the side chat and its nested side chats without writing a note", () =>
    Effect.gen(function* () {
      const harness = yield* makeSideChatHarness("side-chat-done-discard");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const lesson = yield* harness.createLesson("Teach me RL environments.");
        const space = yield* harness.openSideChat({ parentThreadId: lesson, label: SPACE });
        yield* harness.send(space, SPACE_QUESTION);
        const box = yield* harness.openSideChat({ parentThreadId: space, label: "Box" });

        yield* harness.finish(space, { discard: true });

        assert.isNull(yield* orchestrator.getThreadShell(space));
        assert.isNull(yield* orchestrator.getThreadShell(box));
        assert.deepEqual(harness.outcomeInputs(), []);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.scoped),
  );

  it.effect(
    "a stale outcome completion is dropped and pressing Done twice keeps the first outcome",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeSideChatHarness("side-chat-done-stale");
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const lesson = yield* harness.createLesson("Teach me RL environments.");
          const space = yield* harness.openSideChat({ parentThreadId: lesson, label: SPACE });
          yield* harness.send(space, SPACE_QUESTION);
          const gate = yield* Deferred.make<string | null>();
          harness.scriptNote(SPACE, { gate });

          const after = yield* harness.mark;
          yield* harness.finish(space);
          yield* harness.noteRequested(SPACE);
          yield* orchestrator.dispatch({
            type: "thread.side_chat.outcome.complete",
            commandId: CommandId.make("outcome-complete:stale"),
            threadId: space,
            requestId: "stale-request",
            status: "ready",
            note: "Stale note.",
          });
          assert.equal((yield* harness.thread(space)).sideChat?.done?.outcome.status, "generating");

          yield* Deferred.succeed(gate, "Real note.");
          const finished = yield* harness.awaitOutcome(after, space, "ready");
          assert.equal(finished.sideChat?.done?.outcome.note, "Real note.");

          yield* harness.finish(space);
          assert.deepEqual((yield* harness.thread(space)).sideChat?.done, finished.sideChat?.done);
        }).pipe(Effect.provide(harness.layer));
      }).pipe(Effect.scoped),
  );

  it.effect("a note that lands after Discard leaves the deleted side chat as it was", () =>
    Effect.gen(function* () {
      const harness = yield* makeSideChatHarness("side-chat-done-discard-late");
      yield* Effect.gen(function* () {
        const lesson = yield* harness.createLesson("Teach me RL environments.");
        const space = yield* harness.openSideChat({ parentThreadId: lesson, label: SPACE });
        yield* harness.send(space, SPACE_QUESTION);
        const gate = yield* Deferred.make<string | null>();
        harness.scriptNote(SPACE, { gate });
        yield* harness.finish(space);
        yield* harness.noteRequested(SPACE);
        yield* harness.finish(space, { discard: true });

        const after = yield* harness.mark;
        yield* Deferred.succeed(gate, "Late note.");
        const landed = yield* harness.awaitEvent(
          after,
          (event) => event.type === "thread.metadata-updated" && event.threadId === space,
        );

        assert(landed.type === "thread.metadata-updated");
        assert.isNotNull(landed.payload.deletedAt);
        assert.equal(landed.payload.sideChat?.done?.outcome.status, "generating");
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.scoped),
  );

  it.effect("Done refuses a thread that is not a side chat", () =>
    Effect.gen(function* () {
      const harness = yield* makeSideChatHarness("side-chat-done-lesson");
      yield* Effect.gen(function* () {
        const lesson = yield* harness.createLesson("Teach me RL environments.");

        const error = yield* harness.finish(lesson).pipe(Effect.flip);

        assert.equal(error._tag, "OrchestratorDispatchError");
        assert.include(String(error.cause), `Thread ${lesson} is not a side chat.`);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.scoped),
  );

  it.effect("merge-back from a side chat is refused with a pointer to Done", () =>
    Effect.gen(function* () {
      const harness = yield* makeSideChatHarness("side-chat-done-merge-back");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const lesson = yield* harness.createLesson("Teach me RL environments.");
        const space = yield* harness.openSideChat({ parentThreadId: lesson, label: SPACE });
        // A completed run, so only the refusal itself can stop the merge-back.
        yield* harness.send(space, SPACE_QUESTION);

        const error = yield* orchestrator
          .dispatch({
            type: "thread.merge_back",
            createdBy: "user",
            creationSource: "web",
            commandId: CommandId.make("merge-side-chat"),
            sourceThreadId: space,
            targetThreadId: lesson,
            sourcePoint: { type: "latest_stable" },
          })
          .pipe(Effect.flip);

        assert.equal(error._tag, "OrchestratorDispatchError");
        assert.equal(String(error.cause), "Use Done for side chats.");
        assert.deepEqual(
          (yield* orchestrator.getThreadRecords(lesson, ["contextTransfers"])).contextTransfers,
          [],
        );
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.scoped),
  );

  it.effect(
    "an open that reuses its lesson's id is refused rather than locking the lesson twice",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeSideChatHarness("side-chat-done-open-lesson-id");
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const lesson = yield* harness.createLesson("Teach me RL environments.");

          const error = yield* orchestrator
            .dispatch({
              type: "thread.side_chat.open",
              commandId: CommandId.make("open:lesson-id"),
              threadId: lesson,
              anchorThreadId: lesson,
              anchor: {
                threadId: lesson,
                messageId: MessageId.make("message:lesson-id"),
                start: 0,
                end: SPACE.length,
                prefix: "",
                suffix: "",
              },
              excerpt: SPACE,
              createdBy: "user",
              creationSource: "web",
            })
            .pipe(Effect.flip);

          assert.equal(error._tag, "OrchestratorThreadAlreadyExistsError");
        }).pipe(Effect.provide(harness.layer));
      }).pipe(Effect.scoped),
  );

  it.effect("a late opening summary lands on a side chat that Done already cascaded onto", () =>
    Effect.gen(function* () {
      const harness = yield* makeSideChatHarness("side-chat-done-late-opening");
      yield* Effect.gen(function* () {
        const gate = yield* Deferred.make<string | null>();
        harness.scriptOpening(SPACE_QUESTION, { gate });
        const lesson = yield* harness.createLesson("Teach me RL environments.");
        const space = yield* harness.openSideChat({ parentThreadId: lesson, label: SPACE });
        yield* harness.send(space, SPACE_QUESTION);
        const box = yield* harness.openSideChat({ parentThreadId: space, label: BOX });
        const afterAsk = yield* harness.mark;
        const question = yield* harness.send(box, BOX_QUESTION, { await: "none" });

        // Past the cap, box's first turn starts from the fallback context.
        yield* TestClock.adjust(Duration.millis(SIDE_CHAT_WAIT_CAP_MS));
        yield* harness.awaitRun(afterAsk, question, "completed");
        assert.equal((yield* harness.thread(box)).sideChat?.opening.status, "pending");

        harness.scriptNote(BOX, { text: BOX_NOTE });
        harness.scriptNote(SPACE, { text: SPACE_NOTE });
        const afterDone = yield* harness.mark;
        yield* harness.finish(space);
        yield* Deferred.succeed(gate, "Late Box summary.");
        yield* harness.awaitEvent(
          afterDone,
          (event) =>
            event.type === "thread.metadata-updated" &&
            event.threadId === box &&
            event.payload.sideChat?.opening.status === "ready",
        );
        yield* harness.awaitOutcome(afterDone, box, "ready");

        const finished = (yield* harness.thread(box)).sideChat;
        assert.isNotNull(finished?.done);
        assert.equal(finished?.done?.outcome.status, "ready");
        assert.equal(finished?.opening.text, "Late Box summary.");
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.scoped),
  );

  it.effect("Done stops a side chat that is still answering, then writes its note", () =>
    Effect.gen(function* () {
      const harness = yield* makeSideChatHarness("side-chat-done-stop");
      yield* Effect.gen(function* () {
        const lesson = yield* harness.createLesson("Teach me RL environments.");
        const space = yield* harness.openSideChat({ parentThreadId: lesson, label: SPACE });
        const after = yield* harness.mark;
        const question = yield* harness.send(space, `[hold] ${SPACE_QUESTION}`);
        // The provider holds the turn, so Done stops it there.
        yield* harness.awaitEvent(
          after,
          (event) =>
            event.type === "provider-turn.updated" &&
            event.threadId === space &&
            event.payload.status === "running",
        );

        const finished = yield* finishWithNote(harness, space, SPACE, SPACE_NOTE);

        yield* harness.awaitRun(after, question, "interrupted");
        assert.equal(finished.sideChat?.done?.outcome.note, SPACE_NOTE);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.scoped),
  );

  it.effect("Done cancels a side chat's queued message and leaves it out of the note", () =>
    Effect.gen(function* () {
      const harness = yield* makeSideChatHarness("side-chat-done-queued");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const lesson = yield* harness.createLesson("Teach me RL environments.");
        const space = yield* harness.openSideChat({ parentThreadId: lesson, label: SPACE });
        const after = yield* harness.mark;
        const held = yield* harness.send(space, `[hold] ${SPACE_QUESTION}`);
        yield* harness.awaitEvent(
          after,
          (event) =>
            event.type === "provider-turn.updated" &&
            event.threadId === space &&
            event.payload.status === "running",
        );
        const queued = yield* harness.send(space, "What is a bounded action space?", {
          dispatchMode: { type: "queue_after_active" },
          await: "none",
        });
        const queuedRun = (yield* orchestrator.getThreadProjection(space)).runs.find(
          (run) => run.userMessageId === queued,
        );
        assert(queuedRun !== undefined);

        const finished = yield* finishWithNote(harness, space, SPACE, SPACE_NOTE);

        yield* harness.awaitRun(after, held, "interrupted");
        yield* harness.awaitRun(after, queued, "cancelled");
        assert.equal(finished.sideChat?.done?.outcome.note, SPACE_NOTE);
        assert.notInclude(harness.outcomeInputFor(SPACE), "bounded action space");
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.scoped),
  );

  it.effect("Done keeps a queued message promoted onto the held turn", () =>
    Effect.gen(function* () {
      const harness = yield* makeSideChatHarness("side-chat-done-promoted");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const lesson = yield* harness.createLesson("Teach me RL environments.");
        const space = yield* harness.openSideChat({ parentThreadId: lesson, label: SPACE });
        const after = yield* harness.mark;
        const held = yield* harness.send(space, `[hold] ${SPACE_QUESTION}`);
        yield* harness.awaitEvent(
          after,
          (event) =>
            event.type === "provider-turn.updated" &&
            event.threadId === space &&
            event.payload.status === "running",
        );
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        yield* worker.drain();
        const queued = yield* harness.send(space, "Promoted question", {
          dispatchMode: { type: "queue_after_active" },
          await: "none",
        });
        const projection = yield* orchestrator.getThreadProjection(space);
        const queuedRun = projection.runs.find((run) => run.userMessageId === queued);
        const heldRun = projection.runs.find((run) => run.userMessageId === held);
        assert(queuedRun !== undefined);
        assert(heldRun !== undefined);
        yield* orchestrator.dispatch({
          type: "queued-message.promote-to-steer",
          commandId: CommandId.make("promote-promoted"),
          threadId: space,
          queuedRunId: queuedRun.id,
          targetRunId: heldRun.id,
        });
        yield* worker.drain();
        yield* harness.finishHeldTurn(space);
        harness.scriptNote(SPACE, { text: SPACE_NOTE });
        yield* harness.finish(space);
        yield* harness.awaitOutcome(after, space, "ready");
        assert.include(harness.outcomeInputFor(SPACE), "Promoted question");
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.scoped),
  );

  it.effect("Done cancels a held queued message after Stop", () =>
    Effect.gen(function* () {
      const harness = yield* makeSideChatHarness("side-chat-done-stop-queued");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const lesson = yield* harness.createLesson("Teach me RL environments.");
        const space = yield* harness.openSideChat({ parentThreadId: lesson, label: SPACE });
        const after = yield* harness.mark;
        const held = yield* harness.send(space, `[hold] ${SPACE_QUESTION}`);
        const queued = yield* harness.send(space, "bounded action space", {
          dispatchMode: { type: "queue_after_active" },
          await: "none",
        });
        yield* orchestrator.dispatch({
          type: "thread.stop",
          commandId: CommandId.make("stop-space-queued"),
          threadId: space,
        });
        yield* harness.awaitRun(after, held, "interrupted");
        const stoppedProjection = yield* orchestrator.getThreadProjection(space);
        const heldQueue = stoppedProjection.runs.find((run) => run.userMessageId === queued);
        assert.equal(heldQueue?.status, "queued");
        assert.equal(heldQueue?.queueHeld, true);
        harness.scriptNote(SPACE, { text: SPACE_NOTE });
        yield* harness.finish(space);
        const finished = yield* harness.awaitOutcome(after, space, "ready");
        const finalProjection = yield* orchestrator.getThreadProjection(space);
        assert.equal(
          finalProjection.runs.find((run) => run.userMessageId === queued)?.status,
          "cancelled",
        );
        assert.notInclude(harness.outcomeInputFor(SPACE), "bounded action space");
        assert.equal(finished.sideChat?.done?.outcome.status, "ready");
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.scoped),
  );

  it.effect("a finished side chat parks a message that isn't yours until your own reopens it", () =>
    Effect.gen(function* () {
      const harness = yield* makeSideChatHarness("side-chat-done-parks-external");
      yield* Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const lesson = yield* harness.createLesson("Teach me RL environments.");
        const space = yield* harness.openSideChat({ parentThreadId: lesson, label: SPACE });
        yield* harness.send(space, SPACE_QUESTION);
        yield* finishWithNote(harness, space, SPACE, SPACE_NOTE);

        const parked = yield* harness.send(space, "nightly check-in", {
          scheduledTaskId: ScheduledTaskId.make("task:nightly"),
          await: "none",
        });
        const parkedProjection = yield* orchestrator.getThreadProjection(space);
        const parkedRun = parkedProjection.runs.find((run) => run.userMessageId === parked);
        assert.equal(parkedRun?.status, "queued");
        assert.equal(parkedRun?.queueHeld, true);
        assert.equal(parkedProjection.thread.sideChat?.done?.outcome.status, "ready");

        const after = yield* harness.mark;
        yield* harness.send(space, BOX_QUESTION);
        assert.isNull((yield* harness.thread(space)).sideChat?.done);
        yield* harness.awaitRun(after, parked, "completed");
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.scoped),
  );

  it.effect(
    "Done finishes nested side chats first and a grandchild's note reaches the lesson through its parent",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeSideChatHarness("side-chat-done-nested");
        yield* Effect.gen(function* () {
          const lesson = yield* harness.createLesson("Teach me RL environments.");
          const space = yield* harness.openSideChat({ parentThreadId: lesson, label: SPACE });
          yield* harness.send(space, SPACE_QUESTION);
          const box = yield* harness.openSideChat({ parentThreadId: space, label: BOX });
          yield* harness.send(box, BOX_QUESTION);
          harness.scriptNote(BOX, { text: BOX_NOTE });

          const after = yield* harness.mark;
          const finishedSpace = yield* finishWithNote(harness, space, SPACE, SPACE_NOTE);
          const finishedBox = yield* harness.awaitOutcome(after, box, "ready");

          assert.include(harness.outcomeInputFor(SPACE), BOX_LINE);
          assert.deepEqual(finishedSpace.sideChatNoteDeliveries, {
            [box]: finishedBox.sideChat?.done?.outcome.requestId,
          });

          yield* harness.send(lesson, "Continue the lesson.");
          const prompt = harness.prompts(lesson).at(-1) ?? "";
          assert.include(prompt, SPACE_LINE);
          assert.notInclude(prompt, BOX_NOTE);
        }).pipe(Effect.provide(harness.layer));
      }).pipe(Effect.scoped),
  );

  it.effect("reopening a side chat and pressing Done again writes only what is new", () =>
    Effect.gen(function* () {
      const harness = yield* makeSideChatHarness("side-chat-done-reopen");
      yield* Effect.gen(function* () {
        const secondNote = "They now see that a Box bounds each observation.";
        const lesson = yield* harness.createLesson("Teach me RL environments.");
        const space = yield* harness.openSideChat({ parentThreadId: lesson, label: SPACE });
        yield* harness.send(space, SPACE_QUESTION);
        yield* finishWithNote(harness, space, SPACE, SPACE_NOTE);
        yield* harness.send(lesson, "Continue the lesson.");
        assert.include(harness.prompts(lesson).at(-1), SPACE_LINE);

        yield* harness.send(space, BOX_QUESTION);
        const reopened = (yield* harness.thread(space)).sideChat;
        assert.isNull(reopened?.done);
        assert.equal(reopened?.deliveredNote, SPACE_NOTE);

        yield* finishWithNote(harness, space, SPACE, secondNote);
        assert.include(
          harness.outcomeInputFor(SPACE),
          `Note already sent to the lesson for this side chat (write only what is new; otherwise reply null):\n${SPACE_NOTE}`,
        );

        yield* harness.send(lesson, "Next step.");
        const prompt = harness.prompts(lesson).at(-1) ?? "";
        assert.include(prompt, `• re "observation space": ${secondNote}`);
        assert.notInclude(prompt, SPACE_NOTE);
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.scoped),
  );

  it.effect("reopening before delivery replaces the undelivered note", () =>
    Effect.gen(function* () {
      const harness = yield* makeSideChatHarness("side-chat-done-reopen-undelivered");
      yield* Effect.gen(function* () {
        const lesson = yield* harness.createLesson("Teach me RL environments.");
        const space = yield* harness.openSideChat({ parentThreadId: lesson, label: SPACE });
        yield* harness.send(space, SPACE_QUESTION);
        yield* finishWithNote(harness, space, SPACE, "First note.");

        yield* harness.send(space, "One more question.");
        const reopened = (yield* harness.thread(space)).sideChat;
        assert.isNull(reopened?.done);
        assert.isUndefined(reopened?.deliveredNote);

        yield* finishWithNote(harness, space, SPACE, "Second note.");
        assert.notInclude(harness.outcomeInputFor(SPACE), "Note already sent");

        yield* harness.send(lesson, "Continue the lesson.");
        const prompt = harness.prompts(lesson).at(-1) ?? "";
        assert.include(prompt, "Second note.");
        assert.notInclude(prompt, "First note.");
      }).pipe(Effect.provide(harness.layer));
    }).pipe(Effect.scoped),
  );

  // Review Focus 5: the lesson never receives the note of a side chat reopened mid-write.
  it.effect(
    "reopening while the note is still being written drops it and the next Done replaces it",
    () =>
      Effect.gen(function* () {
        const harness = yield* makeSideChatHarness("side-chat-done-reopen-generating");
        yield* Effect.gen(function* () {
          const lesson = yield* harness.createLesson("Teach me RL environments.");
          const space = yield* harness.openSideChat({ parentThreadId: lesson, label: SPACE });
          yield* harness.send(space, SPACE_QUESTION);
          const gate = yield* Deferred.make<string | null>();
          harness.scriptNote(SPACE, { gate });
          const after = yield* harness.mark;
          yield* harness.finish(space);
          const generating = yield* harness.awaitOutcome(after, space, "generating");
          yield* harness.noteRequested(SPACE);

          yield* harness.send(space, "One more question.");
          assert.isNull((yield* harness.thread(space)).sideChat?.done);

          const staleRequestId = generating.sideChat?.done?.outcome.requestId;
          assert(staleRequestId !== undefined);
          const beforeStale = yield* harness.mark;
          yield* Deferred.succeed(gate, "Stale note.");
          yield* awaitCommand(beforeStale, `${staleRequestId}:outcome-complete`);
          assert.isNull((yield* harness.thread(space)).sideChat?.done);

          const finished = yield* finishWithNote(harness, space, SPACE, "Fresh note.");
          assert.equal(finished.sideChat?.done?.outcome.note, "Fresh note.");

          yield* harness.send(lesson, "Continue the lesson.");
          const prompt = harness.prompts(lesson).at(-1) ?? "";
          assert.include(prompt, "Fresh note.");
          assert.notInclude(prompt, "Stale note.");
        }).pipe(Effect.provide(harness.layer));
      }).pipe(Effect.scoped),
  );
});
