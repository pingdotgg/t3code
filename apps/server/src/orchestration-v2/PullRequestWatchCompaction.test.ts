import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeRequestId,
  ThreadId,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as Orchestrator from "./Orchestrator.ts";
import type { ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";

const adapters = ["codex", "claudeAgent", "cursor"].map(
  (driver) =>
    ({
      instanceId: ProviderInstanceId.make(driver),
      driver: ProviderDriverKind.make(driver),
      getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: () => Effect.die("This test must not call a provider"),
    }) as ProviderAdapterV2Shape,
);
const databaseLayer = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  ProviderReplayHarness.layerWithRegistry(
    { name: "watch-compaction" },
    ProviderAdapterRegistry.layerFromAdapters(adapters),
    { databaseLayer, runEffectWorker: false },
  ),
  ProjectionStore.layer.pipe(Layer.provide(databaseLayer)),
);
const key = { host: "github.com", repository: "pingdotgg/t3code", number: 7 };
const link = { url: "https://github.com/pingdotgg/t3code/pull/7", source: "agent" as const };

const createConversation = Effect.fn(function* (
  driver = "codex",
  text = "Preserve my pending work",
  suffix = driver,
) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const threadId = ThreadId.make(`watch-compaction:${suffix}`);
  yield* orchestrator.dispatch({
    type: "thread.create",
    commandId: CommandId.make(`create:${threadId}`),
    threadId,
    projectId: ProjectId.make("watch-compaction-project"),
    title: "Watch compaction",
    modelSelection: { instanceId: ProviderInstanceId.make(driver), model: "fixture" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    createdBy: "user",
    creationSource: "web",
  });
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`send:${threadId}`),
    threadId,
    messageId: MessageId.make(`message:${threadId}`),
    text,
    attachments: [],
    dispatchMode: { type: "start_immediately" },
    createdBy: "user",
    creationSource: "web",
  });
  return { threadId, run: (yield* orchestrator.getThreadProjection(threadId)).runs[0]! };
});

const updateRun = Effect.fn(function* (
  run: OrchestrationV2Run,
  status: OrchestrationV2Run["status"],
) {
  const sink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  yield* sink.write({
    events: [
      {
        id: EventId.make(`${run.id}:${status}`),
        type: "run.updated",
        threadId: run.threadId,
        runId: run.id,
        occurredAt: now,
        payload: {
          ...run,
          status,
          startedAt: now,
          completedAt: status === "completed" ? now : null,
        },
      },
    ],
  });
});

const watch = (threadId: ThreadId, compactBeforeWaiting?: boolean, suffix = "start") =>
  Effect.flatMap(Orchestrator.OrchestratorV2, (orchestrator) =>
    orchestrator.dispatch({
      type: "thread.pull-request.watch",
      commandId: CommandId.make(`watch:${threadId}:${suffix}`),
      threadId,
      ...key,
      watching: true,
      link,
      ...(compactBeforeWaiting === undefined ? {} : { compactBeforeWaiting }),
    }),
  );

it.layer(layerTest)("compaction before a PR wait", (it) => {
  it.effect.each([undefined, false])("ordinary watches do not compact: %s", (optIn) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { threadId } = yield* createConversation(
        "codex",
        "Preserve my pending work",
        `default:${optIn}`,
      );
      yield* watch(threadId, optIn);
      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.lengthOf(projection.runs, 1);
      assert.lengthOf(projection.messages, 1);
      assert.isDefined(projection.thread.pullRequests?.[0]?.watch);
    }),
  );

  it.effect.each(["codex", "claudeAgent", "cursor"])(
    "queues one compaction after the turn: %s",
    (driver) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const { threadId, run } = yield* createConversation(driver);
        yield* updateRun(run, "running");
        yield* watch(threadId, true);
        yield* watch(threadId, true, "repeat");
        const before = yield* orchestrator.getThreadProjection(threadId);
        assert.deepEqual(
          before.messages.map((message) => message.text),
          ["Preserve my pending work", "/compact"],
        );
        assert.deepEqual(
          before.runs.map((run) => run.status),
          ["running", "queued"],
        );
        assert.equal(yield* orchestrator.resumeQueuedRuns, 0);
        const watched = before.thread.pullRequests?.[0]?.watch;
        assert.isDefined(watched);
        // Even PR news arriving before the original turn ends queues behind compaction.
        yield* orchestrator.dispatch({
          type: "thread.pull-request-watch.sync",
          commandId: CommandId.make(`news:${threadId}`),
          threadId,
          ...key,
          startedAt: watched!.startedAt,
          watch: { ...watched!, headSha: "new-head" },
          wake: {
            messageId: MessageId.make(`news:${threadId}`),
            text: "Review the failed check",
            notification: {
              source: { kind: "monitor" },
              outcome: "updated",
              summary: "#7: checks failed",
            },
          },
        });
        yield* updateRun(run, "completed");
        yield* orchestrator.dispatch({
          type: "queue.resume",
          commandId: CommandId.make(`resume:${threadId}`),
          threadId,
        });
        const during = yield* orchestrator.getThreadProjection(threadId);
        const compact = during.runs[1]!;
        assert.equal(compact.status, "starting");
        assert.equal(during.runs[2]?.status, "queued");
        yield* updateRun(compact, "completed");
        yield* orchestrator.dispatch({
          type: "queue.resume",
          commandId: CommandId.make(`resume-news:${threadId}`),
          threadId,
        });
        const after = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(after.runs[2]?.status, "starting");
        assert.equal(after.thread.pullRequests?.[0]?.watch?.headSha, "new-head");
        assert.equal(after.messages[0]?.text, "Preserve my pending work");
      }),
  );

  it.effect("starts one compaction for a completed conversation", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { threadId, run } = yield* createConversation(
        "codex",
        "Preserve my pending work",
        "idle",
      );
      yield* updateRun(run, "completed");
      yield* watch(threadId, true);
      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(
        projection.runs.map((run) => run.status),
        ["completed", "starting"],
      );
      assert.equal(projection.messages[1]?.text, "/compact");
      assert.isDefined(projection.thread.pullRequests?.[0]?.watch);
    }),
  );

  it.effect("cancelling the compaction keeps the watch", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { threadId, run } = yield* createConversation(
        "codex",
        "Preserve my pending work",
        "cancel",
      );
      yield* updateRun(run, "running");
      yield* watch(threadId, true);
      const compact = (yield* orchestrator.getThreadProjection(threadId)).runs[1]!;
      yield* orchestrator.dispatch({
        type: "queued-run.cancel",
        commandId: CommandId.make("cancel-compact"),
        threadId,
        runId: compact.id,
      });
      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.equal(after.runs[1]?.status, "cancelled");
      assert.isDefined(after.thread.pullRequests?.[0]?.watch);
      assert.equal(after.messages[0]?.text, "Preserve my pending work");
      yield* updateRun(run, "completed");
      yield* orchestrator.dispatch({
        type: "queue.resume",
        commandId: CommandId.make("resume-after-cancel"),
        threadId,
      });
      assert.equal(
        (yield* orchestrator.getThreadProjection(threadId)).runs[1]?.status,
        "cancelled",
      );
    }),
  );

  it.effect.each([
    "starting",
    "waiting",
    "failed",
    "cancelled",
    "queued",
    "maintenance",
    "permission",
    "user_input",
  ])("rejects unsafe compaction atomically: %s", (mode) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { threadId, run } = yield* createConversation(
        "codex",
        mode === "maintenance" ? "/compact" : "Preserve my pending work",
        mode,
      );
      if (["starting", "waiting", "failed", "cancelled"].includes(mode)) {
        yield* updateRun(run, mode as OrchestrationV2Run["status"]);
      } else {
        yield* updateRun(run, "running");
      }
      if (mode === "queued")
        yield* orchestrator.dispatch({
          type: "message.dispatch",
          commandId: CommandId.make("queued-user-work"),
          threadId,
          messageId: MessageId.make("queued-user-work"),
          text: "Do this next",
          attachments: [],
          dispatchMode: { type: "queue_after_active" },
          createdBy: "user",
          creationSource: "web",
        });
      if (mode === "permission" || mode === "user_input") {
        const sink = yield* EventSink.EventSinkV2;
        const now = yield* DateTime.now;
        yield* sink.write({
          events: [
            {
              id: EventId.make(`pending-input:${mode}`),
              type: "runtime-request.updated",
              threadId,
              occurredAt: now,
              payload: {
                id: RuntimeRequestId.make(`pending-input:${mode}`),
                nodeId: run.rootNodeId!,
                providerTurnId: null,
                nativeRequestRef: null,
                kind: mode,
                status: "pending",
                responseCapability: { type: "message" },
                createdAt: now,
                resolvedAt: null,
              },
            },
          ],
        });
      }
      const before = yield* orchestrator.getThreadProjection(threadId);
      const error = yield* watch(threadId, true).pipe(Effect.flip);
      assert.equal(error._tag, "OrchestratorDispatchError");
      const after = yield* orchestrator.getThreadProjection(threadId);
      assert.deepEqual(after.thread.pullRequests, before.thread.pullRequests);
      assert.deepEqual(after.runs, before.runs);
      assert.deepEqual(after.messages, before.messages);
    }),
  );

  it.effect.each(["permission", "user_input"] as const)(
    "input arriving after opt-in skips the compaction: %s",
    (kind) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const sink = yield* EventSink.EventSinkV2;
        const { threadId, run } = yield* createConversation(
          "codex",
          "Preserve my pending work",
          `late:${kind}`,
        );
        yield* updateRun(run, "running");
        yield* watch(threadId, true);
        const now = yield* DateTime.now;
        const request = {
          id: RuntimeRequestId.make(`late:${kind}`),
          nodeId: run.rootNodeId!,
          providerTurnId: null,
          nativeRequestRef: null,
          kind,
          status: "pending" as const,
          responseCapability: { type: "message" as const },
          createdAt: now,
          resolvedAt: null,
        };
        yield* sink.write({
          events: [
            {
              id: EventId.make(`late-request:${kind}`),
              type: "runtime-request.updated",
              threadId,
              occurredAt: now,
              payload: request,
            },
          ],
        });
        yield* updateRun(run, "completed");
        yield* orchestrator.dispatch({
          type: "queue.resume",
          commandId: CommandId.make(`late-resume:${kind}`),
          threadId,
        });
        const after = yield* orchestrator.getThreadProjection(threadId);
        assert.equal(after.runs[1]?.status, "cancelled");
        assert.isFalse(after.runs.some((candidate) => candidate.queueHeld === true));
        assert.isDefined(after.thread.pullRequests?.[0]?.watch);
      }),
  );

  it.effect("pending input never drops a compaction the user edited into work", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const sink = yield* EventSink.EventSinkV2;
      const { threadId, run } = yield* createConversation(
        "codex",
        "Preserve my pending work",
        "edited",
      );
      yield* updateRun(run, "running");
      yield* watch(threadId, true);
      const queued = (yield* orchestrator.getThreadProjection(threadId)).runs[1]!;
      yield* orchestrator.dispatch({
        type: "queued-run.edit",
        commandId: CommandId.make("edit-compact"),
        threadId,
        runId: queued.id,
        text: "Do the real work",
        attachments: [],
      });
      const now = yield* DateTime.now;
      yield* sink.write({
        events: [
          {
            id: EventId.make("edited-request"),
            type: "runtime-request.updated",
            threadId,
            occurredAt: now,
            payload: {
              id: RuntimeRequestId.make("edited-request"),
              nodeId: run.rootNodeId!,
              providerTurnId: null,
              nativeRequestRef: null,
              kind: "user_input",
              status: "pending",
              responseCapability: { type: "message" },
              createdAt: now,
              resolvedAt: null,
            },
          },
        ],
      });
      yield* updateRun(run, "completed");
      yield* orchestrator.dispatch({
        type: "queue.resume",
        commandId: CommandId.make("edited-resume"),
        threadId,
      });
      assert.equal((yield* orchestrator.getThreadProjection(threadId)).runs[1]?.status, "starting");
    }),
  );

  it.effect("Stop holds the queued compaction and ends the watch", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const { threadId, run } = yield* createConversation(
        "codex",
        "Preserve my pending work",
        "stop",
      );
      yield* updateRun(run, "running");
      yield* watch(threadId, true);
      yield* orchestrator.dispatch({
        type: "thread.stop",
        commandId: CommandId.make("stop-wait"),
        threadId,
      });
      const projection = yield* orchestrator.getThreadProjection(threadId);
      assert.isUndefined(projection.thread.pullRequests?.[0]?.watch);
      assert.equal(projection.runs[1]?.queueHeld, true);
      assert.equal(yield* orchestrator.resumeQueuedRuns, 0);
    }),
  );
});
