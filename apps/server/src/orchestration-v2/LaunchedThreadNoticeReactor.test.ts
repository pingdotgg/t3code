import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EnvironmentId,
  EventId,
  MessageId,
  type OrchestrationV2DelegatedFrom,
  type OrchestrationV2Notification,
  type OrchestrationV2Run,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EventSink from "./EventSink.ts";
import * as LaunchedThreadNoticeReactor from "./LaunchedThreadNoticeReactor.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const here = EnvironmentId.make("environment:here");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "gpt-5.1-codex" };
const projectId = ProjectId.make("project:launched");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for notices"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = LaunchedThreadNoticeReactor.layer.pipe(
  Layer.provideMerge(
    Layer.mergeAll(
      layerDatabase,
      ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
      ProviderReplayHarness.layerWithRegistry(
        { name: "launched-thread-notice" },
        ProviderAdapterRegistry.layerFromAdapters([adapter]),
        { databaseLayer: layerDatabase, runEffectWorker: false },
      ),
      Layer.mock(ServerEnvironment.ServerEnvironment)({ getEnvironmentId: Effect.succeed(here) }),
    ),
  ),
);

const createThread = (
  threadId: ThreadId,
  title: string,
  delegatedFrom?: OrchestrationV2DelegatedFrom,
) =>
  Orchestrator.OrchestratorV2.pipe(
    Effect.flatMap((orchestrator) =>
      orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make(`create:${threadId}`),
        threadId,
        projectId,
        title,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        ...(delegatedFrom === undefined ? {} : { delegatedFrom }),
        createdBy: delegatedFrom === undefined ? "user" : "agent",
        creationSource: delegatedFrom === undefined ? "web" : "mcp",
      }),
    ),
  );

/** Starts a run on the worker for a message, then ends it with `reply`, as the provider would. */
const runToEnd = Effect.fn("test.runToEnd")(function* (input: {
  readonly threadId: ThreadId;
  readonly key: string;
  readonly status: OrchestrationV2Run["status"];
  readonly reply?: string;
  readonly senderThreadId?: ThreadId;
  readonly notification?: OrchestrationV2Notification;
  /** The user typed the message in the worker itself. */
  readonly typed?: boolean;
  /** Queues a message behind the run before it ends, as a restart or `/goal` does. */
  readonly queueBehind?: boolean;
}) {
  const orchestrator = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const eventSink = yield* EventSink.EventSinkV2;
  const messageId = MessageId.make(`message:${input.key}`);
  yield* orchestrator.dispatch({
    type: "message.dispatch",
    commandId: CommandId.make(`send:${input.key}`),
    threadId: input.threadId,
    messageId,
    text: `Work on ${input.key}`,
    attachments: [],
    // A wake is always queued; with nothing running it starts at once.
    dispatchMode: {
      type: input.notification === undefined ? "start_immediately" : "queue_after_active",
    },
    ...(input.senderThreadId === undefined ? {} : { senderThreadId: input.senderThreadId }),
    ...(input.notification === undefined ? {} : { notification: input.notification }),
    createdBy: input.typed === true ? "user" : "agent",
    creationSource:
      input.typed === true ? "web" : input.notification === undefined ? "mcp" : "server",
  });
  if (input.queueBehind === true) {
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make(`send:${input.key}:next`),
      threadId: input.threadId,
      messageId: MessageId.make(`message:${input.key}:next`),
      text: `Continue ${input.key}`,
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "agent",
      creationSource: "mcp",
    });
  }
  const { runs } = yield* projections.getThreadRecords(input.threadId, ["runs"]);
  const run = runs.find((candidate) => candidate.userMessageId === messageId)!;
  const now = yield* DateTime.now;
  const ended = {
    id: EventId.make(`event:${input.key}:ended`),
    type: "run.updated",
    threadId: input.threadId,
    runId: run.id,
    occurredAt: now,
    payload: { ...run, status: input.status, queuePosition: null, completedAt: now },
  } as const;
  yield* eventSink.write({
    events: [
      ...(input.reply === undefined
        ? []
        : [
            {
              id: EventId.make(`event:${input.key}:reply`),
              type: "message.updated" as const,
              threadId: input.threadId,
              runId: run.id,
              occurredAt: now,
              payload: {
                id: MessageId.make(`message:${input.key}:reply`),
                threadId: input.threadId,
                runId: run.id,
                nodeId: run.rootNodeId,
                role: "assistant" as const,
                text: input.reply,
                attachments: [],
                streaming: false,
                createdAt: now,
                updatedAt: now,
                createdBy: "agent" as const,
                creationSource: "provider" as const,
              },
            },
          ]),
      ended,
    ],
  });
  return ended;
});

const notices = (threadId: ThreadId) =>
  ProjectionStore.ProjectionStoreV2.pipe(
    Effect.flatMap((projections) => projections.getThreadRecords(threadId, ["messages"])),
    Effect.map(({ messages }) => messages.filter((message) => message.notification !== undefined)),
  );

it.layer(layerTest)("a thread launched from another", (it) => {
  it.effect("tells its launcher when a run ends, once per run", () =>
    Effect.gen(function* () {
      const reactor = yield* LaunchedThreadNoticeReactor.LaunchedThreadNoticeReactor;
      const launcher = ThreadId.make("thread:launcher");
      const worker = ThreadId.make("thread:worker");
      yield* createThread(launcher, "Launcher");
      yield* createThread(worker, "Worker", {
        environmentId: here,
        threadId: launcher,
        title: "Launcher",
      });

      const completed = yield* runToEnd({
        threadId: worker,
        key: "completed",
        status: "completed",
        reply: "Opened the pull request.",
        senderThreadId: launcher,
      });
      yield* reactor.handle(completed);
      yield* reactor.handle(completed);
      const [notice] = yield* notices(launcher);
      assert.equal((yield* notices(launcher)).length, 1);
      assert.deepEqual(notice?.notification, {
        source: { kind: "delegated_task", taskIds: [], childThreadId: worker },
        outcome: "completed",
        summary: 'Launched thread "Worker" completed',
      });
      assert.equal(
        notice?.text,
        `Launched thread ${worker} (Worker) [completed]:\nOpened the pull request.`,
      );

      // Stopped by the user there, or failed: the launcher hears that too.
      const interrupted = yield* runToEnd({
        threadId: worker,
        key: "interrupted",
        status: "interrupted",
      });
      yield* reactor.handle(interrupted);
      assert.deepEqual((yield* notices(launcher)).at(-1)?.notification, {
        source: { kind: "delegated_task", taskIds: [], childThreadId: worker },
        outcome: "cancelled",
        summary: 'Launched thread "Worker" was interrupted',
      });

      // A run its own pull request watch woke, one that never ran, and one the user started in the
      // worker itself tell it nothing: the launcher did not ask for them.
      const watched = yield* runToEnd({
        threadId: worker,
        key: "watched",
        status: "completed",
        reply: "Checks are still running.",
        notification: {
          source: { kind: "monitor" },
          outcome: "updated",
          summary: "#7: checks running",
        },
      });
      yield* reactor.handle(watched);
      const cancelled = yield* runToEnd({
        threadId: worker,
        key: "cancelled",
        status: "cancelled",
      });
      yield* reactor.handle(cancelled);
      const typed = yield* runToEnd({
        threadId: worker,
        key: "typed",
        status: "completed",
        reply: "Renamed it as you asked.",
        typed: true,
      });
      yield* reactor.handle(typed);
      assert.equal((yield* notices(launcher)).length, 2);
    }),
  );

  it.effect("says nothing of a run that a queued message stopped to carry on the work", () =>
    Effect.gen(function* () {
      const reactor = yield* LaunchedThreadNoticeReactor.LaunchedThreadNoticeReactor;
      const launcher = ThreadId.make("thread:restart-launcher");
      const worker = ThreadId.make("thread:restart-worker");
      yield* createThread(launcher, "Launcher");
      yield* createThread(worker, "Worker", {
        environmentId: here,
        threadId: launcher,
        title: "Launcher",
      });
      yield* reactor.handle(
        yield* runToEnd({
          threadId: worker,
          key: "restarted",
          status: "interrupted",
          senderThreadId: launcher,
          queueBehind: true,
        }),
      );
      assert.equal((yield* notices(launcher)).length, 0);
    }),
  );

  it.effect("tells no one when the launcher is elsewhere or archived", () =>
    Effect.gen(function* () {
      const reactor = yield* LaunchedThreadNoticeReactor.LaunchedThreadNoticeReactor;
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const archived = ThreadId.make("thread:archived-launcher");
      const remote = ThreadId.make("thread:remote-task");
      const orphan = ThreadId.make("thread:orphan");
      yield* createThread(archived, "Archived launcher");
      yield* orchestrator.dispatch({
        type: "thread.archive",
        commandId: CommandId.make("archive:launcher"),
        threadId: archived,
      });
      yield* createThread(orphan, "Orphan", {
        environmentId: here,
        threadId: archived,
        title: "Archived launcher",
      });
      // A linked environment's task: its follower there reports it, not this reactor.
      yield* createThread(remote, "Remote task", {
        environmentId: EnvironmentId.make("environment:elsewhere"),
        threadId: archived,
        title: "Archived launcher",
      });
      for (const threadId of [orphan, remote]) {
        yield* reactor.handle(
          yield* runToEnd({
            threadId,
            key: `${threadId}:done`,
            status: "completed",
            reply: "Done.",
            senderThreadId: archived,
          }),
        );
      }
      assert.equal((yield* notices(archived)).length, 0);
    }),
  );
});
