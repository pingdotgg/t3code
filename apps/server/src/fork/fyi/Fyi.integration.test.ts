import { assert, it } from "@effect/vitest";
import {
  CommandId,
  EventId,
  FYI_TEXT_MAX_CHARS,
  fyiDeliveryState,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2Command,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderCapabilities,
  type OrchestrationV2ProviderFailure,
} from "@t3tools/contracts";
import * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import * as TestClock from "effect/testing/TestClock";

import { CodexProviderCapabilitiesV2 } from "../../orchestration-v2/Adapters/CodexAdapterV2.ts";
import * as EffectWorker from "../../orchestration-v2/EffectWorker.ts";
import * as EventSink from "../../orchestration-v2/EventSink.ts";
import * as Orchestrator from "../../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../../orchestration-v2/ProjectionStore.ts";
import * as ProviderAdapterRegistry from "../../orchestration-v2/ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "../../orchestration-v2/testkit/ProviderReplayHarness.ts";
import { FYI_WAKE_TEXT, wakeCommand } from "./Fyi.ts";
import * as FyiDelivery from "./FyiDelivery.ts";

const FYI_HEADER =
  "FYI messages for you. No action is needed. Use one only if it changes your current work.";

/**
 * A provider that steers without stopping tools, whose turns run until the test finishes them.
 * With `toolBatchAtStart`, each turn start also asks for FYIs as a Claude tool call would.
 */
const runWithProvider = <A, E, R>(
  name: string,
  body: (provider: {
    readonly started: Array<ProviderAdapter.ProviderAdapterV2TurnInput>;
    readonly steered: Array<ProviderAdapter.ProviderAdapterV2SteerInput>;
    readonly toolBatches: Array<string | undefined>;
    readonly events: Queue.Queue<ProviderAdapter.ProviderAdapterV2Event>;
    readonly behaviour: {
      failStart: boolean;
      failReads: boolean;
      toolBatchAtStart: boolean;
    };
    readonly cwd: string;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    const driver = ProviderDriverKind.make("codex");
    const instanceId = ProviderInstanceId.make(String(driver));
    const capabilities: OrchestrationV2ProviderCapabilities = {
      ...CodexProviderCapabilitiesV2,
      turns: {
        ...CodexProviderCapabilitiesV2.turns,
        supportsActiveSteering: true,
        activeSteeringInterruptsTools: false,
      },
    };
    const cwd = yield* checkpointWorkspace(`fyi-${name}`);
    const events = yield* Queue.unbounded<ProviderAdapter.ProviderAdapterV2Event>();
    const started: Array<ProviderAdapter.ProviderAdapterV2TurnInput> = [];
    const steered: Array<ProviderAdapter.ProviderAdapterV2SteerInput> = [];
    const toolBatches: Array<string | undefined> = [];
    const behaviour = { failStart: false, failReads: false, toolBatchAtStart: false };
    const makeAdapter = (
      fyiDelivery: FyiDelivery.FyiDeliveryShape,
    ): ProviderAdapter.ProviderAdapterV2["Service"] => ({
      instanceId,
      driver,
      getCapabilities: () => Effect.succeed(capabilities),
      planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
      openSession: (input) =>
        Effect.gen(function* () {
          const now = yield* DateTime.now;
          // A released session's events end, as a real provider's do, so only its successor reads.
          const released = yield* Deferred.make<void>();
          yield* Effect.addFinalizer(() => Deferred.succeed(released, undefined));
          return {
            instanceId,
            driver,
            providerSessionId: input.providerSessionId,
            providerSession: {
              id: input.providerSessionId,
              driver,
              providerInstanceId: instanceId,
              status: "ready",
              cwd,
              model: "test-model",
              capabilities,
              createdAt: now,
              updatedAt: now,
              lastError: null,
            },
            events: Stream.fromQueue(events).pipe(Stream.interruptWhen(Deferred.await(released))),
            ensureThread: ({ threadId }) =>
              Effect.succeed({
                id: ProviderThreadId.make(`provider-thread:${threadId}`),
                driver,
                providerInstanceId: instanceId,
                providerSessionId: input.providerSessionId,
                appThreadId: threadId,
                ownerNodeId: null,
                nativeThreadRef: { driver, nativeId: "native-thread", strength: "strong" },
                nativeConversationHeadRef: null,
                status: "idle",
                firstRunOrdinal: null,
                lastRunOrdinal: null,
                handoffIds: [],
                forkedFrom: null,
                createdAt: now,
                updatedAt: now,
              }),
            resumeThread: ({ providerThread }) => Effect.succeed(providerThread),
            startTurn: (turn) =>
              Effect.gen(function* () {
                if (behaviour.failStart) {
                  return yield* new ProviderAdapter.ProviderAdapterTurnStartError({
                    driver,
                    threadId: turn.threadId,
                    providerThreadId: turn.providerThread.id,
                    runId: turn.runId,
                  });
                }
                started.push(turn);
                if (behaviour.toolBatchAtStart) {
                  toolBatches.push(
                    yield* fyiDelivery.forToolBatch({
                      threadId: turn.threadId,
                      carrier: {
                        runId: turn.runId,
                        nodeId: turn.rootNodeId,
                        providerThreadId: turn.providerThread.id,
                      },
                      stop: () => false,
                    }),
                  );
                }
                yield* Queue.offer(events, {
                  type: "provider_turn.updated",
                  driver,
                  providerTurn: {
                    id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
                    providerThreadId: turn.providerThread.id,
                    nodeId: turn.rootNodeId,
                    runAttemptId: turn.attemptId,
                    nativeTurnRef: {
                      driver,
                      nativeId: `native:${turn.attemptId}`,
                      strength: "strong",
                    },
                    ordinal: turn.providerTurnOrdinal,
                    status: "running",
                    startedAt: yield* DateTime.now,
                    completedAt: null,
                  },
                });
              }),
            steerTurn: (turn) =>
              Effect.sync(() => {
                steered.push(turn);
              }),
            interruptTurn: ({ providerTurnId }) =>
              Effect.forEach(
                started.filter(
                  (turn) =>
                    ProviderTurnId.make(`provider-turn:${turn.attemptId}`) === providerTurnId,
                ),
                (turn) =>
                  Effect.gen(function* () {
                    const now = yield* DateTime.now;
                    yield* Queue.offer(events, {
                      type: "provider_turn.updated",
                      driver,
                      providerTurn: {
                        id: providerTurnId,
                        providerThreadId: turn.providerThread.id,
                        nodeId: turn.rootNodeId,
                        runAttemptId: turn.attemptId,
                        nativeTurnRef: {
                          driver,
                          nativeId: `native:${turn.attemptId}`,
                          strength: "strong",
                        },
                        ordinal: turn.providerTurnOrdinal,
                        status: "interrupted",
                        startedAt: now,
                        completedAt: now,
                      },
                    });
                    yield* Queue.offer(events, {
                      type: "turn.terminal",
                      driver,
                      providerThreadId: turn.providerThread.id,
                      providerTurnId,
                      runOrdinal: turn.runOrdinal,
                      status: "interrupted",
                      failure: null,
                      threadDisposition: "reusable",
                    });
                  }),
                { discard: true },
              ),
            respondToRuntimeRequest: () => Effect.void,
            readThreadSnapshot: () => Effect.die("unused"),
            rollbackThread: ({ providerThread }) =>
              Effect.succeed({
                providerThread,
                providerTurns: [],
                messages: [],
                runtimeRequests: [],
              }),
            forkThread: () => Effect.die("unused"),
          };
        }),
    });
    return yield* body({ started, steered, toolBatches, events, behaviour, cwd }).pipe(
      Effect.provide(
        ProviderReplayHarness.layerWithRegistry(
          { name: `fyi-${name}` },
          Layer.unwrap(
            Effect.gen(function* () {
              return ProviderAdapterRegistry.layerSingle(
                makeAdapter(yield* FyiDelivery.FyiDelivery),
              );
            }),
          ),
          {
            runEffectWorker: false,
            wrapProjectionStore: (store) => ({
              ...store,
              getThreadRecords: (threadId, ...rest) =>
                behaviour.failReads
                  ? Effect.fail(new ProjectionStore.ProjectionStoreReadError({ threadId }))
                  : store.getThreadRecords(threadId, ...rest),
            }),
          },
        ),
      ),
    );
  });

const waitFor = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    return yield* orchestrator.streamDomainEvents.pipe(
      Stream.filter(predicate),
      Stream.take(1),
      Stream.runDrain,
      // The stream starts at the latest event, so it must subscribe before the caller acts.
      Effect.forkScoped({ startImmediately: true }),
    );
  });

const send = (
  threadId: ThreadId,
  key: string,
  text: string,
): Extract<OrchestrationV2Command, { readonly type: "message.dispatch" }> => ({
  type: "message.dispatch",
  commandId: CommandId.make(`command:${key}`),
  threadId,
  messageId: MessageId.make(`message:${key}`),
  text,
  attachments: [],
  dispatchMode: { type: "start_immediately" },
  createdBy: "user",
  creationSource: "web",
});

const fyi = (threadId: ThreadId, key: string, text: string) => ({
  ...send(threadId, key, text),
  dispatchMode: { type: "fyi" as const },
  senderThreadId: ThreadId.make("thread:chief"),
  createdBy: "agent" as const,
  creationSource: "mcp" as const,
});

/** Creates the thread and starts its first turn, which stays running. */
const startThread = (threadId: ThreadId, cwd: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make(`create:${threadId}`),
      threadId,
      projectId: ProjectId.make("project:fyi"),
      title: "FYI",
      modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "test-model" },
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: cwd,
      createdBy: "user",
      creationSource: "web",
    });
    const running = yield* waitFor(
      (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
    );
    yield* orchestrator.dispatch(send(threadId, "first", "first"));
    yield* worker.drain();
    yield* Fiber.join(running);
  });

/** Ends the running turn; a `failure` ends it failed. */
const finishTurn = (
  threadId: ThreadId,
  events: Queue.Queue<ProviderAdapter.ProviderAdapterV2Event>,
  status: "completed" | "interrupted" = "completed",
  failure?: OrchestrationV2ProviderFailure,
) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const projection = yield* orchestrator.getThreadProjection(threadId);
    const run = projection.runs.find((candidate) => candidate.status === "running")!;
    const turn = projection.providerTurns.find((candidate) => candidate.status === "running")!;
    const ended = yield* waitFor(
      (event) =>
        event.type === "run.updated" &&
        event.payload.id === run.id &&
        event.payload.status !== "running",
    );
    yield* Queue.offer(events, {
      type: "provider_turn.updated",
      driver: turn.nativeTurnRef!.driver,
      providerTurn: {
        ...turn,
        status: failure === undefined ? status : "failed",
        completedAt: yield* DateTime.now,
      },
    });
    const terminal = {
      type: "turn.terminal",
      driver: turn.nativeTurnRef!.driver,
      providerThreadId: turn.providerThreadId,
      providerTurnId: turn.id,
      runOrdinal: run.ordinal,
      threadDisposition: "reusable",
    } as const;
    yield* Queue.offer(
      events,
      failure === undefined
        ? { ...terminal, status, failure: null }
        : { ...terminal, status: "failed", failure, failureItemOrdinal: 1 },
    );
    yield* Fiber.join(ended);
    yield* worker.drain();
  });

const fyiItemOf = (threadId: ThreadId, key: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const projection = yield* orchestrator.getThreadProjection(threadId);
    const messageId = MessageId.make(`message:${key}`);
    const item = projection.turnItems.find(
      (candidate) => candidate.type === "user_message" && candidate.messageId === messageId,
    );
    assert.isDefined(item);
    assert.isTrue(item?.type === "user_message" && item.fyi === true, "the item is an FYI");
    return {
      item: item!,
      message: projection.messages.find((candidate) => candidate.id === messageId)!,
      state:
        item?.type === "user_message"
          ? fyiDeliveryState(
              item,
              projection.runs.find((run) => run.id === item.runId),
            )
          : undefined,
      projection,
    };
  });

/** Sends a message to an idle thread and waits until its turn runs. */
const startTurn = (threadId: ThreadId, key: string, text: string) =>
  Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const running = yield* waitFor(
      (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
    );
    yield* orchestrator.dispatch(send(threadId, key, text));
    yield* worker.drain();
    yield* Fiber.join(running);
  });

it.effect("an FYI to an idle thread waits where it was sent and rides the next turn once", () =>
  runWithProvider("idle", ({ started, events, cwd }) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const threadId = ThreadId.make("thread:fyi-idle");
      yield* startThread(threadId, cwd);
      yield* finishTurn(threadId, events);
      yield* orchestrator.dispatch({
        type: "thread.settle",
        commandId: CommandId.make("settle"),
        threadId,
      });
      yield* orchestrator.dispatch({
        type: "thread.snooze",
        commandId: CommandId.make("snooze"),
        threadId,
        snoozedUntil: "2099-01-01T00:00:00.000Z",
      });
      const before = yield* orchestrator.getThreadProjection(threadId);
      const posted = yield* orchestrator.dispatch(fyi(threadId, "note", "main moved"));
      const replayed = yield* orchestrator.dispatch(fyi(threadId, "note", "main moved"));
      assert.isTrue(replayed.replayed, "a replay returns the post's receipt");
      assert.strictEqual(replayed.sequence, posted.sequence);

      const waiting = yield* fyiItemOf(threadId, "note");
      assert.lengthOf(waiting.projection.runs, 1, "an FYI starts no run");
      assert.isNull(waiting.message.runId);
      assert.strictEqual(waiting.item.runId, null);
      assert.strictEqual(waiting.item.status, "pending");
      assert.strictEqual(waiting.projection.thread.settledOverride, "settled");
      assert.isNotNull(waiting.projection.thread.snoozedUntil);
      const lastRunItems = before.turnItems.map((item) => item.ordinal);
      assert.isAbove(waiting.item.ordinal, Math.max(...lastRunItems), "placed after the last run");
      assert.isAtLeast(waiting.item.ordinal, before.runs[0]!.ordinal * 1_000_000);
      const shell = ProjectionStore.threadShellFromProjection(waiting.projection);
      assert.deepStrictEqual(
        shell.latestUserMessageAt,
        ProjectionStore.threadShellFromProjection(before).latestUserMessageAt,
        "an FYI is no user activity",
      );

      const running = yield* waitFor(
        (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
      );
      yield* orchestrator.dispatch(send(threadId, "next", "Fix the flaky test"));
      yield* worker.drain();
      yield* Fiber.join(running);
      assert.lengthOf(started, 2);
      assert.strictEqual(
        started[1]!.message.text,
        `${FYI_HEADER}\n\n<fyi from="thread thread:chief" sent="${DateTime.formatIso(waiting.item.startedAt!)}">\nmain moved\n</fyi>\n\nUser message:\nFix the flaky test`,
      );
      const carried = yield* fyiItemOf(threadId, "note");
      assert.strictEqual(carried.state, "sent", "sent while its turn runs");
      assert.strictEqual(carried.item.runId, started[1]!.runId);
      assert.strictEqual(carried.message.runId, started[1]!.runId);
      assert.strictEqual(carried.item.ordinal, waiting.item.ordinal, "keeps where it was sent");
      yield* finishTurn(threadId, events);
      assert.strictEqual((yield* fyiItemOf(threadId, "note")).state, "delivered");

      yield* orchestrator.dispatch({
        ...fyi(threadId, "note", "main moved"),
        commandId: CommandId.make("command:note-after-receipt-pruned"),
      });
      const reposted = yield* fyiItemOf(threadId, "note");
      assert.strictEqual(reposted.state, "delivered", "a repost leaves it delivered");
      assert.strictEqual(reposted.item.runId, started[1]!.runId);
    }),
  ),
);

it.effect("an FYI posted again on a compacted thread changes nothing", () =>
  runWithProvider("compacted", ({ events, cwd }) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("thread:fyi-compacted");
      yield* startThread(threadId, cwd);
      yield* finishTurn(threadId, events);
      const [run] = (yield* orchestrator.getThreadProjection(threadId)).runs;
      const now = yield* DateTime.now;
      // A compaction narrows a new message's read of messages to its recent runs.
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("event:fyi-compacted:compaction"),
            type: "turn-item.updated",
            threadId,
            runId: run!.id,
            occurredAt: now,
            payload: {
              id: TurnItemId.make("item:fyi-compacted:compaction"),
              threadId,
              runId: run!.id,
              nodeId: run!.rootNodeId,
              providerThreadId: null,
              providerTurnId: null,
              nativeItemRef: null,
              parentItemId: null,
              ordinal: 50,
              status: "completed",
              title: null,
              startedAt: now,
              completedAt: now,
              updatedAt: now,
              type: "compaction",
              driver: ProviderDriverKind.make("codex"),
            },
          },
        ],
      });
      yield* orchestrator.dispatch(fyi(threadId, "note", "main moved"));
      const posted = yield* fyiItemOf(threadId, "note");
      yield* TestClock.adjust("1 day");
      yield* orchestrator.dispatch({
        ...fyi(threadId, "note", "main moved"),
        commandId: CommandId.make("command:note-after-receipt-pruned"),
      });
      const reposted = yield* fyiItemOf(threadId, "note");
      assert.deepStrictEqual(reposted.item, posted.item, "a repost changes nothing");
    }),
  ),
);

it.effect(
  "an FYI to a running turn waits instead of steering it, and one past the cap is refused",
  () =>
    runWithProvider("running", ({ steered, cwd }) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = ThreadId.make("thread:fyi-running");
        yield* startThread(threadId, cwd);
        const tooLong = yield* Effect.flip(
          orchestrator.dispatch(fyi(threadId, "long", "x".repeat(FYI_TEXT_MAX_CHARS + 1))),
        );
        assert.instanceOf(tooLong, Orchestrator.OrchestratorDispatchError, "past the cap");
        yield* orchestrator.dispatch(fyi(threadId, "note", "main moved"));
        yield* worker.drain();
        const after = yield* fyiItemOf(threadId, "note");
        assert.lengthOf(steered, 0);
        assert.lengthOf(after.projection.runs, 1, "an FYI starts no turn");
        assert.isNull(after.item.runId);
        assert.strictEqual(after.item.status, "pending");

        // A queued message has no turn item until its run starts.
        yield* orchestrator.dispatch({
          ...send(threadId, "queued", "Fix the flaky test"),
          dispatchMode: { type: "queue_after_active" },
        });
        yield* orchestrator.dispatch({
          ...fyi(threadId, "queued", "main moved"),
          commandId: CommandId.make("command:queued-as-fyi"),
        });
        const queued = (yield* orchestrator.getThreadProjection(threadId)).messages.find(
          (message) => message.id === MessageId.make("message:queued"),
        );
        assert.strictEqual(
          queued?.text,
          "Fix the flaky test",
          "an FYI with its id changes nothing",
        );
        assert.isUndefined(queued?.fyi);
      }),
    ),
);

it.effect(
  "a slash command, a provider continuation or a refused prompt leaves FYI messages to the next prompt",
  () =>
    runWithProvider("not-carried", ({ started, events, behaviour, cwd }) =>
      Effect.gen(function* () {
        const orchestrator = yield* Orchestrator.OrchestratorV2;
        const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
        const threadId = ThreadId.make("thread:fyi-not-carried");
        yield* startThread(threadId, cwd);
        yield* finishTurn(threadId, events);
        yield* orchestrator.dispatch(fyi(threadId, "note", "main moved"));

        const running = yield* waitFor(
          (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
        );
        yield* orchestrator.dispatch(send(threadId, "slash", "/review"));
        yield* worker.drain();
        yield* Fiber.join(running);
        assert.strictEqual(started[1]!.message.text, "/review");
        assert.strictEqual((yield* fyiItemOf(threadId, "note")).item.status, "pending");
        yield* finishTurn(threadId, events);

        const continued = yield* waitFor(
          (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
        );
        yield* orchestrator.dispatch({
          ...send(threadId, "continuation", "Background task completed."),
          dispatchMode: { type: "queue_after_active" },
          createdBy: "agent",
          creationSource: "provider",
        });
        yield* worker.drain();
        yield* Fiber.join(continued);
        assert.strictEqual(started[2]!.message.text, "Background task completed.");
        assert.strictEqual((yield* fyiItemOf(threadId, "note")).item.status, "pending");
        yield* finishTurn(threadId, events);

        behaviour.failStart = true;
        yield* orchestrator.dispatch(send(threadId, "refused", "Fix the flaky test"));
        yield* worker.drain();
        assert.lengthOf(started, 3, "the provider never took the prompt");
        assert.strictEqual((yield* fyiItemOf(threadId, "note")).state, "waiting");

        behaviour.failStart = false;
        yield* startTurn(threadId, "retried", "Fix the flaky test");
        assert.include(started[3]!.message.text, "main moved");
      }),
    ),
);

it.effect("a tool call while the turn starts gets no FYI that the prompt holds", () =>
  runWithProvider("start-tool-batch", ({ started, toolBatches, behaviour, events, cwd }) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("thread:fyi-start-tool-batch");
      yield* startThread(threadId, cwd);
      yield* finishTurn(threadId, events);
      yield* orchestrator.dispatch(fyi(threadId, "note", "main moved"));
      behaviour.toolBatchAtStart = true;
      yield* startTurn(threadId, "next", "Fix the flaky test");
      assert.include(started[1]!.message.text, "main moved");
      assert.deepStrictEqual(toolBatches, [undefined]);
    }),
  ),
);

it.effect("an FYI whose turn ends interrupted before any output waits for the next turn", () =>
  runWithProvider("interrupted", ({ started, events, cwd }) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const threadId = ThreadId.make("thread:fyi-interrupted");
      yield* startThread(threadId, cwd);
      yield* finishTurn(threadId, events);
      yield* orchestrator.dispatch(fyi(threadId, "note", "main moved"));
      yield* startTurn(threadId, "next", "Fix the flaky test");
      assert.include(started[1]!.message.text, "main moved");
      yield* finishTurn(threadId, events, "interrupted");
      assert.strictEqual((yield* fyiItemOf(threadId, "note")).state, "waiting");
      yield* startTurn(threadId, "again", "Go on");
      assert.include(started[2]!.message.text, "main moved");
    }),
  ),
);

it.effect.each([
  { by: "Edit from here", key: "edit" },
  { by: "the provider's own rewind", key: "rewind" },
])("an FYI whose turn $by rolls back waits again, shown where it was sent", ({ by, key }) =>
  runWithProvider(`rollback-${key}`, ({ started, events, cwd }) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const threadId = ThreadId.make(`thread:fyi-rollback-${key}`);
      yield* startThread(threadId, cwd);
      yield* finishTurn(threadId, events);
      yield* orchestrator.dispatch(fyi(threadId, "note", "main moved"));
      const sent = yield* fyiItemOf(threadId, "note");
      yield* startTurn(threadId, "next", "Fix the flaky test");
      assert.include(started[1]!.message.text, "main moved");
      yield* finishTurn(threadId, events);
      assert.strictEqual((yield* fyiItemOf(threadId, "note")).state, "delivered");

      const rolledBack = yield* waitFor(
        (event) =>
          event.type === "run.updated" &&
          event.payload.id === started[1]!.runId &&
          event.payload.status === "rolled_back",
      );
      const projection = yield* orchestrator.getThreadProjection(threadId);
      if (by === "Edit from here") {
        const checkpoint = projection.checkpoints.find(
          (candidate) => candidate.appRunOrdinal === projection.runs[0]!.ordinal,
        )!;
        yield* orchestrator.dispatch({
          type: "checkpoint.rollback",
          restoreFiles: false,
          commandId: CommandId.make("command:rollback"),
          threadId,
          scopeId: checkpoint.scopeId,
          checkpointId: checkpoint.id,
        });
        yield* worker.drain();
      } else {
        // Pi reports a rewind from the turn that ran it.
        yield* startTurn(threadId, "rewind", "Go back to the first answer");
        yield* Queue.offer(events, {
          type: "provider_thread.updated",
          driver: ProviderDriverKind.make("codex"),
          providerThread: projection.providerThreads[0]!,
          retainedNativeTurnIds: [`native:${started[0]!.attemptId}`],
        });
      }
      yield* Fiber.join(rolledBack);
      if (key === "rewind") yield* finishTurn(threadId, events);

      const returned = yield* fyiItemOf(threadId, "note");
      assert.strictEqual(returned.state, "waiting");
      const page = yield* orchestrator.getTimelinePage(threadId, { limit: 50, view: "messages" });
      assert.include(
        page.items.map((row) => row.sourceItemId),
        returned.item.id,
        "the timeline shows it",
      );
      assert.isNull(returned.item.runId);
      assert.isNull(returned.message.runId);
      assert.strictEqual(returned.item.ordinal, sent.item.ordinal, "keeps where it was sent");
      yield* startTurn(threadId, "again", "Go on");
      assert.include(started.at(-1)!.message.text, "main moved");
    }),
  ),
);

it.effect("a steering restart sends the restarted turn's FYI messages again", () =>
  runWithProvider("restart-active", ({ started, events, cwd }) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const threadId = ThreadId.make("thread:fyi-restart-active");
      yield* startThread(threadId, cwd);
      yield* finishTurn(threadId, events);
      yield* orchestrator.dispatch(fyi(threadId, "note", "main moved"));
      yield* startTurn(threadId, "next", "Fix the flaky test");
      assert.include(started[1]!.message.text, "main moved");
      const restarted = yield* waitFor(
        (event) =>
          event.type === "provider-turn.updated" &&
          event.payload.status === "running" &&
          event.payload.runAttemptId !== started[1]!.attemptId,
      );
      yield* orchestrator.dispatch({
        ...send(threadId, "restart", "Fix the other test"),
        dispatchMode: { type: "restart_active", targetRunId: started[1]!.runId },
      });
      yield* worker.drain();
      yield* Fiber.join(restarted);
      assert.lengthOf(started, 3);
      assert.strictEqual(started[2]!.runId, started[1]!.runId, "the restart keeps the run");
      assert.include(started[2]!.message.text, "main moved");
    }),
  ),
);

it.effect("a restart continuation that resumes natively leaves FYI messages waiting", () =>
  runWithProvider("restart", ({ started, events, cwd }) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const eventSink = yield* EventSink.EventSinkV2;
      const threadId = ThreadId.make("thread:fyi-restart");
      yield* startThread(threadId, cwd);
      yield* finishTurn(threadId, events);
      const [cut] = (yield* orchestrator.getThreadProjection(threadId)).runs;
      yield* eventSink.write({
        events: [
          {
            id: EventId.make("event:fyi-restart:cut"),
            type: "run.updated",
            threadId,
            runId: cut!.id,
            occurredAt: yield* DateTime.now,
            payload: { ...cut!, status: "cancelled" },
          },
        ],
      });
      yield* orchestrator.dispatch(fyi(threadId, "note", "main moved"));

      const running = yield* waitFor(
        (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
      );
      yield* orchestrator.dispatch({
        ...send(threadId, "continue", "Continue where you left off."),
        createdBy: "agent",
        creationSource: "server",
        restartContinuationOfRunId: cut!.id,
      });
      yield* worker.drain();
      yield* Fiber.join(running);
      assert.strictEqual(started[1]!.restartContinuationOfRunId, cut!.id);
      assert.strictEqual(started[1]!.message.text, "Continue where you left off.");
      const after = yield* fyiItemOf(threadId, "note");
      assert.isNull(after.item.runId);
      assert.strictEqual(after.item.status, "pending");
    }),
  ),
);

it.effect("the 6-hour wake starts a turn only while it is due, and again for an FYI it left", () =>
  runWithProvider("wake", ({ started, events, behaviour, cwd }) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const threadId = ThreadId.make("thread:fyi-wake");
      yield* startThread(threadId, cwd);
      yield* finishTurn(threadId, events);
      yield* orchestrator.dispatch(fyi(threadId, "first-note", "a".repeat(8_000)));
      yield* orchestrator.dispatch(fyi(threadId, "second-note", "b".repeat(8_000)));
      const [firstRun] = (yield* orchestrator.getThreadProjection(threadId)).runs;
      const wake = wakeCommand(threadId, firstRun!.completedAt!);

      const early = yield* Effect.flip(orchestrator.dispatch(wake));
      assert.instanceOf(early, Orchestrator.OrchestratorFyiWakeNotDueError);
      assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 1);

      yield* TestClock.adjust("6 hours");
      behaviour.failReads = true;
      const failed = yield* Effect.flip(orchestrator.dispatch(wake));
      behaviour.failReads = false;
      assert.notInstanceOf(failed, Orchestrator.OrchestratorFyiWakeNotDueError);
      assert.lengthOf((yield* orchestrator.getThreadProjection(threadId)).runs, 1);
      const running = yield* waitFor(
        (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
      );
      const woke = yield* orchestrator.dispatch(wake);
      assert.isUndefined(woke.replayed, "neither refusal left a receipt");
      yield* worker.drain();
      yield* Fiber.join(running);
      assert.lengthOf(started, 2);
      assert.isTrue(started[1]!.message.text.startsWith(`${FYI_HEADER}\n\n<fyi`));
      assert.isTrue(
        started[1]!.message.text.endsWith(
          `</fyi>\n\n1 more FYI message waits for later.\n\nUser message:\n${FYI_WAKE_TEXT}`,
        ),
      );
      const carried = yield* fyiItemOf(threadId, "first-note");
      assert.strictEqual(carried.state, "sent");
      assert.strictEqual(carried.item.runId, started[1]!.runId);
      assert.strictEqual((yield* fyiItemOf(threadId, "second-note")).state, "waiting");

      yield* finishTurn(threadId, events);
      assert.strictEqual((yield* fyiItemOf(threadId, "first-note")).state, "delivered");
      const wakeRun = (yield* orchestrator.getThreadProjection(threadId)).runs.find(
        (run) => run.id === started[1]!.runId,
      );
      const next = wakeCommand(threadId, wakeRun!.completedAt!);
      assert.deepInclude(yield* Effect.flip(orchestrator.dispatch(next)), {
        _tag: "OrchestratorFyiWakeNotDueError",
        reason: "not_yet",
      });
      yield* TestClock.adjust("6 hours");
      const wokeAgain = yield* orchestrator.dispatch(next);
      assert.isUndefined(wokeAgain.replayed, "the second wake has its own ids");
      yield* worker.drain();
      assert.lengthOf(started, 3);
      assert.isTrue(started[2]!.message.text.endsWith(`</fyi>\n\nUser message:\n${FYI_WAKE_TEXT}`));
      const second = yield* fyiItemOf(threadId, "second-note");
      assert.strictEqual(second.state, "sent");
      assert.strictEqual(second.item.runId, started[2]!.runId);
    }),
  ),
);

it.effect.each([
  { lastTurn: "a person stopped", key: "user-stop", after: "6 hours", outcome: "woken" },
  { lastTurn: "an agent stopped", key: "agent-stop", after: "6 hours", outcome: "woken" },
  {
    lastTurn: "hit a usage limit whose armed resume never runs",
    key: "armed-limit",
    after: "18 hours",
    outcome: "woken",
  },
  {
    lastTurn: "hit a usage limit that reset 1 hour ago",
    key: "limit",
    after: "13 hours",
    outcome: "not_yet",
  },
] as const)("the wake $after after the last turn $lastTurn: $outcome", ({ key, after, outcome }) =>
  runWithProvider(`ended-${key}`, ({ started, events, cwd }) =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
      const threadId = ThreadId.make(`thread:fyi-ended-${key}`);
      yield* startThread(threadId, cwd);
      const run = (yield* orchestrator.getThreadProjection(threadId)).runs[0]!;
      let idleFrom: DateTime.Utc;
      if (key === "user-stop" || key === "agent-stop") {
        const stopped = yield* waitFor(
          (event) =>
            event.type === "run.updated" &&
            event.payload.id === run.id &&
            event.payload.status === "interrupted",
        );
        yield* orchestrator.dispatch({
          type: "thread.stop",
          commandId: CommandId.make(`stop:${key}`),
          threadId,
          ...(key === "agent-stop" ? { reason: "Stopped by an agent" } : {}),
        });
        yield* worker.drain();
        yield* Fiber.join(stopped);
        idleFrom = yield* DateTime.now;
      } else {
        idleFrom = DateTime.add(yield* DateTime.now, { hours: 12 });
        const resetAt = DateTime.formatIso(idleFrom);
        yield* finishTurn(threadId, events, "completed", {
          class: "usage_limit",
          message: "Usage limit reached.",
          code: null,
          retryable: null,
          resetAt,
        });
        if (key === "armed-limit") {
          yield* orchestrator.dispatch({
            type: "thread.metadata.update",
            commandId: CommandId.make("arm-limit-resume"),
            threadId,
            limitRecovery: { runId: run.id, resetAt, autoResume: true },
          });
        }
      }
      yield* orchestrator.dispatch(fyi(threadId, "note", "main moved"));

      yield* TestClock.adjust(after);
      const wake = orchestrator.dispatch(wakeCommand(threadId, idleFrom));
      if (outcome === "woken") {
        yield* wake;
      } else {
        assert.deepInclude(yield* Effect.flip(wake), {
          _tag: "OrchestratorFyiWakeNotDueError",
          reason: outcome,
        });
      }
      yield* worker.drain();
      assert.lengthOf(started, outcome === "woken" ? 2 : 1);
    }),
  ),
);
