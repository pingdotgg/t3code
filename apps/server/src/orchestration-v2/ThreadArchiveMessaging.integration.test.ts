import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  type OrchestrationV2ServerCommand,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const projectId = ProjectId.make("project:archive-messaging");
const database = SqlitePersistence.layerMemory;
const fixture = (onOpen = () => {}) => {
  const adapter = {
    instanceId,
    driver: ProviderDriverKind.make("codex"),
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
    openSession: () =>
      Effect.sync(onOpen).pipe(Effect.andThen(Effect.die("No provider should start"))),
  } as ProviderAdapter.ProviderAdapterV2["Service"];
  return ProviderReplayHarness.layerWithRegistry(
    { name: "archive-messaging" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: database, runEffectWorker: false },
  ).pipe(Layer.provideMerge(EffectOutbox.layer.pipe(Layer.provide(database))));
};

const create = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId,
      title: threadId,
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: null,
      createdBy: "user",
      creationSource: "web",
    });
  });

const archive = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    yield* orchestrator.dispatch({
      type: "thread.archive",
      commandId: CommandId.make(`archive:${threadId}`),
      threadId,
    });
    assert.isNotNull((yield* orchestrator.getThreadProjection(threadId)).thread.archivedAt);
  });

const message = (
  threadId: ThreadId,
  key: string,
  dispatchMode: Extract<
    OrchestrationV2ServerCommand,
    { type: "message.dispatch" }
  >["dispatchMode"] = { type: "start_immediately" },
  senderThreadId?: ThreadId,
) => ({
  type: "message.dispatch" as const,
  commandId: CommandId.make(`send:${key}`),
  threadId,
  messageId: MessageId.make(`message:${key}`),
  text: key,
  attachments: [],
  dispatchMode,
  createdBy: "agent" as const,
  creationSource: "mcp" as const,
  ...(senderThreadId === undefined ? {} : { senderThreadId }),
});

it.effect.each([
  { type: "start_immediately" as const },
  { type: "queue_after_active" as const },
  { type: "steer_active" as const, targetRunId: RunId.make("stale-run") },
  { type: "restart_active" as const, targetRunId: RunId.make("stale-run") },
])("rejects $type messages to an archived recipient without recording work", (dispatchMode) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const target = ThreadId.make("archived-recipient");
    yield* create(target);
    yield* archive(target);
    const before = yield* orchestrator.getThreadProjection(target);
    const command = message(target, dispatchMode.type, dispatchMode);
    const error = yield* orchestrator.dispatch(command).pipe(Effect.flip);
    assert.instanceOf(error, Orchestrator.OrchestratorDispatchError);
    if (error._tag === "OrchestratorDispatchError")
      assert.equal(error.cause, `Thread ${target} is not active.`);
    assert.deepEqual(yield* orchestrator.getThreadProjection(target), before);
    assert.isEmpty(yield* outbox.listByCommandId(command.commandId));
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    yield* worker.drain();
    assert.deepEqual(yield* orchestrator.getThreadProjection(target), before);
  }).pipe(Effect.provide(fixture())),
);

it.effect("rejects an archived sender without changing its recipient", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sender = ThreadId.make("archived-sender");
    const target = ThreadId.make("live-recipient");
    yield* create(sender);
    yield* create(target);
    yield* archive(sender);
    const before = yield* orchestrator.getThreadProjection(target);
    const command = message(target, "archived-outgoing", undefined, sender);
    const error = yield* orchestrator.dispatch(command).pipe(Effect.flip);
    assert.instanceOf(error, Orchestrator.OrchestratorDispatchError);
    if (error._tag === "OrchestratorDispatchError")
      assert.equal(error.cause, `Sender thread ${sender} is not active.`);
    assert.deepEqual(yield* orchestrator.getThreadProjection(target), before);
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    assert.isEmpty(yield* outbox.listByCommandId(command.commandId));
  }).pipe(Effect.provide(fixture())),
);

it.effect("does not reuse an accepted turn as a new send from an archived sender", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const sender = ThreadId.make("accepted-turn-sender");
    const target = ThreadId.make("accepted-turn-recipient");
    yield* create(sender);
    yield* create(target);
    const accepted = message(target, "accepted-turn", undefined, sender);
    yield* orchestrator.dispatch(accepted);
    yield* archive(sender);
    const before = yield* orchestrator.getThreadProjection(target);
    const command = { ...accepted, commandId: CommandId.make("send:reused-accepted-turn") };
    const error = yield* orchestrator.dispatch(command).pipe(Effect.flip);
    assert.instanceOf(error, Orchestrator.OrchestratorDispatchError);
    assert.deepEqual(yield* orchestrator.getThreadProjection(target), before);
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    assert.isEmpty(yield* outbox.listByCommandId(command.commandId));
  }).pipe(Effect.provide(fixture())),
);

it.effect("keeps live, self, opposite-direction sends and committed receipt replay working", () =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const left = ThreadId.make("live-left");
    const right = ThreadId.make("live-right");
    yield* create(left);
    yield* create(right);
    const outgoing = message(right, "left-to-right", undefined, left);
    const [original] = yield* Effect.all(
      [
        orchestrator.dispatch(outgoing),
        orchestrator.dispatch(message(left, "right-to-left", undefined, right)),
      ],
      { concurrency: "unbounded" },
    );
    yield* orchestrator.dispatch(message(left, "self", { type: "queue_after_active" }, left));
    yield* orchestrator.dispatch({
      type: "thread.stop",
      commandId: CommandId.make("stop:left"),
      threadId: left,
    });
    yield* archive(left);
    const beforeReplay = yield* orchestrator.getThreadProjection(right);
    const replay = yield* orchestrator.dispatch(outgoing);
    assert.equal(replay.sequence, original.sequence);
    assert.deepEqual(yield* orchestrator.getThreadProjection(right), beforeReplay);
    yield* orchestrator.dispatch({
      type: "thread.unarchive",
      commandId: CommandId.make("reopen:left"),
      threadId: left,
    });
    yield* orchestrator.dispatch(message(left, "reopened-incoming", undefined, right));
    yield* orchestrator.dispatch(
      message(right, "reopened-outgoing", { type: "queue_after_active" }, left),
    );
    assert.isTrue(
      (yield* orchestrator.getThreadProjection(left)).messages.some(
        (item) => item.text === "reopened-incoming",
      ),
    );
    assert.isTrue(
      (yield* orchestrator.getThreadProjection(right)).messages.some(
        (item) => item.text === "reopened-outgoing",
      ),
    );
  }).pipe(Effect.provide(fixture())),
);

it.effect.each(["starting", "waiting"] as const)(
  "blocks archive while a %s run is unfinished and never starts it afterward",
  (status) => {
    let opens = 0;
    return Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const target = ThreadId.make(`pending-${status}-recipient`);
      yield* create(target);
      yield* orchestrator.dispatch(message(target, "admitted-start"));
      const recordFinalizationStatus = (runStatus: "waiting" | "completed") =>
        Effect.gen(function* () {
          const eventSink = yield* EventSink.EventSinkV2;
          const projection = yield* orchestrator.getThreadProjection(target);
          const run = projection.runs[0]!;
          const now = yield* DateTime.now;
          const commandId = CommandId.make(`fixture:run-${runStatus}`);
          yield* eventSink.commitCommand({
            commandId,
            threadId: target,
            commandType: "checkpoint.capture",
            acceptedAt: now,
            events: [
              {
                id: EventId.make(`fixture:run-${runStatus}`),
                type: "run.updated",
                threadId: target,
                runId: run.id,
                occurredAt: now,
                payload: {
                  ...run,
                  status: runStatus,
                  completedAt: runStatus === "completed" ? now : null,
                },
              },
            ],
            effects: [],
          });
        });
      if (status === "waiting") {
        // A completed provider turn stays blocking while its post-terminal work drains.
        yield* recordFinalizationStatus("waiting");
      }
      const before = yield* orchestrator.getThreadProjection(target);
      assert.equal(before.runs[0]?.status, status);
      const attempt = yield* Effect.exit(
        orchestrator.dispatch({
          type: "thread.archive",
          commandId: CommandId.make(`archive:while-${status}`),
          threadId: target,
        }),
      );
      assert.isTrue(Exit.isFailure(attempt));
      assert.deepEqual(yield* orchestrator.getThreadProjection(target), before);
      if (status === "waiting") {
        yield* recordFinalizationStatus("completed");
      } else {
        yield* orchestrator.dispatch({
          type: "thread.stop",
          commandId: CommandId.make("stop:pending-start"),
          threadId: target,
        });
      }
      yield* archive(target);
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      yield* worker.drain();
      assert.equal(opens, 0);
      const after = yield* orchestrator.getThreadProjection(target);
      assert.isNotNull(after.thread.archivedAt);
      assert.equal(after.runs[0]?.status, status === "waiting" ? "completed" : "interrupted");
    }).pipe(
      Effect.provide(
        fixture(() => {
          opens += 1;
        }),
      ),
    );
  },
);
