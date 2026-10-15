import { assert, it } from "@effect/vitest";
import { CommandId, RunId } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import * as EventSink from "./EventSink.ts";

import { createQueue, layer, pauseTerminalListener } from "./QueuedRunEditing.testkit.ts";

it.layer(layer)("queued message editing", (it) => {
  it.effect.each([
    { reason: "provider_error", action: "save" },
    { reason: "provider_error", action: "cancel" },
    { reason: "missing_worktree", action: "save" },
    { reason: "missing_worktree", action: "cancel" },
  ] as const)(
    "$action preserves the queue pause after $reason during editing",
    ({ reason, action }) =>
      Effect.gen(function* () {
        const name = `${reason}-${action}`;
        const { orchestrator, threadId, queued, later, editId, begin, endActiveRun } =
          yield* createQueue(name, null);
        const sink = yield* EventSink.EventSinkV2;
        yield* orchestrator.dispatch(begin);
        const heldRunIds = yield* Queue.unbounded<RunId>();
        const afterSequence = yield* orchestrator.getThreadEventSequence(threadId);
        yield* sink.stream({ threadId, afterSequence }).pipe(
          Stream.runForEach((stored) =>
            stored.event.type === "run.updated" && stored.event.payload.queueHeld === true
              ? Queue.offer(heldRunIds, stored.event.payload.id)
              : Effect.void,
          ),
          Effect.forkScoped,
        );
        yield* Effect.yieldNow;
        yield* endActiveRun(reason);
        assert.equal(yield* Queue.take(heldRunIds), queued.id);
        yield* orchestrator.dispatch(
          action === "save"
            ? {
                type: "queued-run.edit",
                commandId: CommandId.make(`${name}:finish`),
                threadId,
                runId: queued.id,
                editId,
                text: "Edited",
              }
            : {
                type: "queued-run.edit.cancel",
                commandId: CommandId.make(`${name}:finish`),
                threadId,
                runId: queued.id,
                editId,
              },
        );
        const after = yield* orchestrator.getThreadProjection(threadId);
        for (const id of [queued.id, later.id]) {
          const run = after.runs.find((candidate) => candidate.id === id);
          assert.equal(run?.status, "queued");
          assert.isTrue(run?.queueHeld);
          assert.isFalse(after.turnItems.some((item) => item.runId === id));
        }
        assert.isNull(after.runs.find((run) => run.id === queued.id)?.queueEditId);
      }),
  );

  it.effect.each([
    { reason: "provider_error", action: "save" },
    { reason: "provider_error", action: "cancel" },
    { reason: "provider_error", action: "reorder" },
    { reason: "missing_worktree", action: "save" },
    { reason: "missing_worktree", action: "cancel" },
    { reason: "missing_worktree", action: "reorder" },
  ] as const)(
    "$action holds the queue after $reason before the terminal listener handles it",
    ({ reason, action }) =>
      Effect.gen(function* () {
        const name = `before-listener-${reason}-${action}`;
        const { orchestrator, threadId, queued, later, editId, begin, endActiveRun } =
          yield* createQueue(name, null);
        yield* orchestrator.dispatch(begin);
        const listener = yield* pauseTerminalListener(threadId);
        yield* endActiveRun(reason);
        yield* listener.entered;
        const before = yield* orchestrator.getThreadProjection(threadId);
        assert.isFalse(before.runs.some((run) => run.queueHeld === true));
        const finish =
          action === "save"
            ? {
                type: "queued-run.edit" as const,
                commandId: CommandId.make(`${name}:finish`),
                threadId,
                runId: queued.id,
                editId,
                text: "Edited",
              }
            : action === "cancel"
              ? {
                  type: "queued-run.edit.cancel" as const,
                  commandId: CommandId.make(`${name}:finish`),
                  threadId,
                  runId: queued.id,
                  editId,
                }
              : {
                  type: "queued-run.reorder" as const,
                  commandId: CommandId.make(`${name}:finish`),
                  threadId,
                  runId: later.id,
                  beforeRunId: queued.id,
                };
        yield* orchestrator.dispatch(finish);
        yield* orchestrator.dispatch(finish);
        const after = yield* orchestrator.getThreadProjection(threadId);
        for (const id of [queued.id, later.id]) {
          const run = after.runs.find((candidate) => candidate.id === id);
          assert.equal(run?.status, "queued");
          assert.isTrue(run?.queueHeld);
          assert.isFalse(after.turnItems.some((item) => item.runId === id));
        }
        assert.equal(
          after.runs.find((run) => run.id === queued.id)?.queueEditId,
          action === "reorder" ? editId : null,
        );
        if (action === "reorder") {
          assert.equal(after.runs.find((run) => run.id === later.id)?.queuePosition, 1);
        }
        yield* orchestrator.dispatch({
          type: "queue.resume",
          commandId: CommandId.make(`${name}:resume`),
          threadId,
        });
        const resumed = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(
          resumed.runs.find((run) => run.id === (action === "reorder" ? later.id : queued.id))
            ?.status,
          "starting",
          "An explicit resume still overrides the terminal pause",
        );
        yield* listener.release;
      }),
  );

  it.effect(
    "reordering ahead of an edit-held head starts the eligible message after completion",
    () =>
      Effect.gen(function* () {
        const { orchestrator, threadId, queued, later, editId, begin, endActiveRun } =
          yield* createQueue("reorder-completed");
        yield* orchestrator.dispatch(begin);
        const listener = yield* pauseTerminalListener(threadId);
        yield* endActiveRun("completed");
        yield* listener.entered;
        yield* listener.release;
        yield* listener.handled;
        const before = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(before.runs.find((run) => run.id === queued.id)?.status, "queued");
        assert.equal(before.runs.find((run) => run.id === later.id)?.status, "queued");
        assert.isFalse(before.runs.some((run) => run.queueHeld === true));
        const reorder = {
          type: "queued-run.reorder" as const,
          commandId: CommandId.make("reorder-completed:reorder"),
          threadId,
          runId: later.id,
          beforeRunId: queued.id,
        };
        yield* orchestrator.dispatch(reorder);
        yield* orchestrator.dispatch(reorder);
        const after = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(after.runs.find((run) => run.id === later.id)?.status, "starting");
        assert.equal(after.runs.find((run) => run.id === queued.id)?.status, "queued");
        assert.equal(after.runs.find((run) => run.id === queued.id)?.queueEditId, editId);
        assert.isFalse(after.turnItems.some((item) => item.runId === queued.id));
        assert.equal(after.turnItems.filter((item) => item.runId === later.id).length, 1);
      }),
  );

  it.effect.each(["save", "cancel", "reorder"] as const)(
    "%s does not pause the queue after a message-local validation failure",
    (action) =>
      Effect.gen(function* () {
        const name = `validation-${action}`;
        const { orchestrator, threadId, queued, later, editId, begin, endActiveRun } =
          yield* createQueue(name);
        yield* orchestrator.dispatch(begin);
        const listener = yield* pauseTerminalListener(threadId);
        yield* endActiveRun("validation_error");
        yield* listener.entered;
        yield* orchestrator.dispatch(
          action === "save"
            ? {
                type: "queued-run.edit",
                commandId: CommandId.make(`${name}:finish`),
                threadId,
                runId: queued.id,
                editId,
                text: "Edited",
              }
            : action === "cancel"
              ? {
                  type: "queued-run.edit.cancel",
                  commandId: CommandId.make(`${name}:finish`),
                  threadId,
                  runId: queued.id,
                  editId,
                }
              : {
                  type: "queued-run.reorder",
                  commandId: CommandId.make(`${name}:finish`),
                  threadId,
                  runId: later.id,
                  beforeRunId: queued.id,
                },
        );
        const after = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(
          after.runs.find((run) => run.id === (action === "reorder" ? later.id : queued.id))
            ?.status,
          "starting",
        );
        assert.isFalse(after.runs.some((run) => run.queueHeld === true));
        yield* listener.release;
      }),
  );

  it.effect.each(["save", "cancel"] as const)(
    "%s releases an edit only after completion has left the original queued",
    (action) =>
      Effect.gen(function* () {
        const { orchestrator, threadId, queued, later, editId, begin, complete } =
          yield* createQueue(action);
        yield* orchestrator.dispatch(begin);
        yield* orchestrator.dispatch(begin);
        yield* complete;
        const held = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(held.runs.find((run) => run.id === queued.id)?.status, "queued");
        assert.equal(held.runs.find((run) => run.id === later.id)?.status, "queued");
        assert.isFalse(held.turnItems.some((item) => item.runId === queued.id));

        const finish =
          action === "save"
            ? {
                type: "queued-run.edit" as const,
                commandId: CommandId.make(`${action}:finish`),
                threadId,
                runId: queued.id,
                editId,
                text: "Edited",
              }
            : {
                type: "queued-run.edit.cancel" as const,
                commandId: CommandId.make(`${action}:finish`),
                threadId,
                runId: queued.id,
                editId,
              };
        yield* orchestrator.dispatch(finish);
        yield* orchestrator.dispatch(finish);
        const after = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(after.runs.find((run) => run.id === queued.id)?.status, "starting");
        assert.equal(after.runs.find((run) => run.id === later.id)?.status, "queued");
        const items = after.turnItems.filter(
          (item) => item.type === "user_message" && item.runId === queued.id,
        );
        assert.equal(items.length, 1);
        const item = items[0];
        assert.isDefined(item);
        assert.equal(item.type, "user_message");
        if (item.type !== "user_message") return assert.fail("Expected the queued user message");
        assert.equal(item.text, action === "save" ? "Edited" : "Original");
        assert.equal(after.runs.length, 3);
      }),
  );

  it.effect("rejects editing after dispatch has already won", () =>
    Effect.gen(function* () {
      const { orchestrator, threadId, queued, begin, complete } =
        yield* createQueue("already-started");
      yield* complete;
      assert.isTrue(Exit.isFailure(yield* Effect.exit(orchestrator.dispatch(begin))));
      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(after.runs.find((run) => run.id === queued.id)?.status, "starting");
      assert.equal(
        after.messages.find((message) => message.id === queued.userMessageId)?.text,
        "Original",
      );
    }),
  );

  it.effect("holding a later message does not block an earlier queued message", () =>
    Effect.gen(function* () {
      const { orchestrator, threadId, queued, later, begin, complete } =
        yield* createQueue("later-edit");
      yield* orchestrator.dispatch({ ...begin, runId: later.id });
      yield* complete;
      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(after.runs.find((run) => run.id === queued.id)?.status, "starting");
      assert.equal(after.runs.find((run) => run.id === later.id)?.status, "queued");
    }),
  );

  it.effect("steering cannot bypass an active edit", () =>
    Effect.gen(function* () {
      const { orchestrator, threadId, active, queued, begin } = yield* createQueue("held-steer");
      yield* orchestrator.dispatch(begin);
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            orchestrator.dispatch({
              type: "queued-message.promote-to-steer",
              commandId: CommandId.make("held-steer:promote"),
              threadId,
              queuedRunId: queued.id,
              targetRunId: active.id,
            }),
          ),
        ),
      );
      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(after.runs.find((run) => run.id === queued.id)?.status, "queued");
    }),
  );

  it.effect("resume and rejected edits cannot release an active edit", () =>
    Effect.gen(function* () {
      const { orchestrator, threadId, queued, editId, begin, complete } =
        yield* createQueue("rejections");
      yield* orchestrator.dispatch(begin);
      yield* complete;
      yield* orchestrator.dispatch({
        type: "queue.resume",
        commandId: CommandId.make("rejections:resume"),
        threadId,
      });
      for (const [index, extra] of [
        { text: "", editId },
        { text: "Overwritten" },
        { text: "Stale", editId: CommandId.make("wrong") },
      ].entries()) {
        assert.isTrue(
          Exit.isFailure(
            yield* Effect.exit(
              orchestrator.dispatch({
                type: "queued-run.edit",
                commandId: CommandId.make(`rejections:edit:${index}`),
                threadId,
                runId: queued.id,
                ...extra,
              }),
            ),
          ),
        );
      }
      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(after.runs.find((run) => run.id === queued.id)?.queueEditId, editId);
      assert.equal(after.runs.find((run) => run.id === queued.id)?.status, "queued");
      assert.equal(
        after.messages.find((message) => message.id === queued.userMessageId)?.text,
        "Original",
      );
    }),
  );

  it.effect.each(["save", "cancel"] as const)("%s preserves a pre-existing queue pause", (action) =>
    Effect.gen(function* () {
      const { orchestrator, threadId, active, queued, editId, begin } = yield* createQueue(
        `paused-${action}`,
      );
      yield* orchestrator.dispatch({
        type: "run.interrupt",
        commandId: CommandId.make(`paused-${action}:stop`),
        threadId,
        runId: active.id,
        holdQueue: true,
      });
      yield* orchestrator.dispatch(begin);
      yield* orchestrator.dispatch(
        action === "save"
          ? {
              type: "queued-run.edit",
              commandId: CommandId.make(`paused-${action}:finish`),
              threadId,
              runId: queued.id,
              editId,
              text: "Edited",
            }
          : {
              type: "queued-run.edit.cancel",
              commandId: CommandId.make(`paused-${action}:finish`),
              threadId,
              runId: queued.id,
              editId,
            },
      );
      const after = yield* orchestrator.getThreadProjection(threadId);
      const run = after.runs.find((candidate) => candidate.id === queued.id);
      assert.equal(run?.status, "queued");
      assert.isTrue(run?.queueHeld);
      assert.isNull(run?.queueEditId);
    }),
  );

  it.effect("reopening an edit invalidates stale saves and cancels", () =>
    Effect.gen(function* () {
      const { orchestrator, threadId, queued, editId, begin, complete } =
        yield* createQueue("reopen");
      yield* orchestrator.dispatch(begin);
      const reopenedId = CommandId.make("reopen:new-editor");
      yield* orchestrator.dispatch({ ...begin, commandId: reopenedId, previousEditId: editId });
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            orchestrator.dispatch({
              type: "queued-run.edit.cancel",
              commandId: CommandId.make("reopen:stale-cancel"),
              threadId,
              runId: queued.id,
              editId,
            }),
          ),
        ),
      );
      yield* complete;
      const held = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(held.runs.find((run) => run.id === queued.id)?.status, "queued");
      yield* orchestrator.dispatch({
        type: "queued-run.edit",
        commandId: CommandId.make("reopen:save"),
        threadId,
        runId: queued.id,
        editId: reopenedId,
        text: "Recovered",
      });
      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(after.runs.find((run) => run.id === queued.id)?.status, "starting");
    }),
  );
});
