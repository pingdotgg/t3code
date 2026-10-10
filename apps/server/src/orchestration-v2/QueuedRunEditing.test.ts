import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import type { ProviderAdapterV2 } from "@t3tools/provider-core/server/ProviderAdapter";

import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const modelSelection = { instanceId: ProviderInstanceId.make("codex"), model: "test" };
const adapter = {
  instanceId: modelSelection.instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("provider execution is disabled in queue editing tests"),
} satisfies ProviderAdapterV2["Service"];
const layer = ProviderReplayHarness.layerWithRegistry(
  { name: "queued-run-editing" },
  ProviderAdapterRegistry.layerFromAdapters([adapter]),
  { runEffectWorker: false },
);

const createQueue = Effect.fnUntraced(function* (name: string) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const sink = yield* EventSink.EventSinkV2;
  const threadId = ThreadId.make(`thread:${name}`);
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`${name}:create`),
    threadId,
    projectId: ProjectId.make(`project:${name}`),
    title: name,
    modelSelection,
    createdBy: "user",
    creationSource: "web",
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: process.cwd(),
  });
  for (const [index, text] of ["Active", "Original", "Later"].entries()) {
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`${name}:message:${index}`),
      threadId,
      messageId: MessageId.make(`${name}:message:${index}`),
      text,
      attachments: [],
      createdBy: "user",
      creationSource: "web",
      modelSelection,
      dispatchMode: { type: index === 0 ? "start_immediately" : "queue_after_active" },
    });
  }
  const projection = yield* orchestrator.getThreadProjection(threadId);
  const [active, queued, later] = projection.runs;
  assert.isDefined(active);
  assert.isDefined(queued);
  assert.isDefined(later);
  const editId = CommandId.make(`${name}:begin`);
  const begin = {
    type: "queued-run.edit.begin" as const,
    commandId: editId,
    threadId,
    runId: queued.id,
    previousEditId: null,
  };
  const complete = Effect.gen(function* () {
    const now = yield* DateTime.now;
    yield* sink.write({
      events: [
        {
          id: EventId.make(`${name}:complete`),
          type: "run.updated",
          threadId,
          runId: active.id,
          providerInstanceId: active.providerInstanceId,
          occurredAt: now,
          payload: { ...active, status: "completed", completedAt: now },
        },
      ],
    });
    yield* orchestrator.resumeQueuedRuns;
  });
  return { orchestrator, threadId, active, queued, later, editId, begin, complete };
});

it.layer(layer)("queued message editing", (it) => {
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
