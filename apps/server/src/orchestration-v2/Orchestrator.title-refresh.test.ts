import { assert, describe, it } from "@effect/vitest";
import {
  CommandId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  ThreadId,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2ProviderTurn,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";

import { SqlitePersistenceMemory } from "../persistence/Layers/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as EffectOutbox from "./EffectOutbox.ts";
import * as EffectWorker from "./EffectWorker.ts";
import * as Orchestrator from "./Orchestrator.ts";
import type { ProviderAdapterV2Event, ProviderAdapterV2Shape } from "./ProviderAdapter.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import { makeOrchestratorV2ReplayLayerWithRegistry } from "./testkit/ProviderReplayHarness.ts";
import { checkpointWorkspace } from "./testkit/ReplayFixtureWorkspace.ts";

const driver = ProviderDriverKind.make("codex");
const instanceId = ProviderInstanceId.make("codex");
const modelSelection = { instanceId, model: "test-model" };
const firstMessageId = MessageId.make("message:first");

/**
 * Runs a thread's first turn to the given ending while a follow-up waits in
 * the queue. The follow-up starting proves the terminal-run reaction finished.
 */
const runFirstTurn = Effect.fn("runFirstTurn")(function* (input: {
  readonly name: string;
  readonly text: string;
  readonly ending: "completed" | "interrupted";
  readonly renameDuringRun?: boolean;
  readonly steerRestartDuringRun?: boolean;
}) {
  const cwd = yield* checkpointWorkspace(`title-refresh-${input.name}`);
  const events = yield* Queue.unbounded<ProviderAdapterV2Event>();
  const startedTurns = new Map<
    string,
    { readonly providerTurn: OrchestrationV2ProviderTurn; readonly runOrdinal: number }
  >();
  const adapter: ProviderAdapterV2Shape = {
    instanceId,
    driver,
    getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
    planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" }),
    openSession: (session) =>
      Effect.gen(function* () {
        const now = yield* DateTime.now;
        return {
          instanceId,
          driver,
          providerSessionId: session.providerSessionId,
          providerSession: {
            id: session.providerSessionId,
            driver,
            providerInstanceId: instanceId,
            status: "ready",
            cwd,
            model: modelSelection.model,
            capabilities: CodexProviderCapabilitiesV2,
            createdAt: now,
            updatedAt: now,
            lastError: null,
          },
          events: Stream.fromQueue(events),
          ensureThread: ({ threadId }) =>
            Effect.succeed({
              id: ProviderThreadId.make(`provider-thread:${threadId}`),
              driver,
              providerInstanceId: instanceId,
              providerSessionId: session.providerSessionId,
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
          startTurn: (turn) => {
            const providerTurn = {
              id: ProviderTurnId.make(`provider-turn:${turn.attemptId}`),
              providerThreadId: turn.providerThread.id,
              nodeId: turn.rootNodeId,
              runAttemptId: turn.attemptId,
              nativeTurnRef: { driver, nativeId: `native:${turn.attemptId}`, strength: "strong" },
              ordinal: turn.providerTurnOrdinal,
              status: "running",
              startedAt: now,
              completedAt: null,
            } as const;
            startedTurns.set(providerTurn.id, { providerTurn, runOrdinal: turn.runOrdinal });
            return Queue.offer(events, {
              type: "provider_turn.updated",
              driver,
              providerTurn,
            }).pipe(Effect.asVoid);
          },
          steerTurn: () => Effect.die("unused"),
          // A steering restart interrupts the running turn before starting the next one.
          interruptTurn: ({ providerTurnId }) => {
            const turn = startedTurns.get(providerTurnId)!;
            return Queue.offerAll(events, [
              {
                type: "provider_turn.updated",
                driver,
                providerTurn: { ...turn.providerTurn, status: "interrupted", completedAt: now },
              },
              {
                type: "turn.terminal",
                driver,
                providerThreadId: turn.providerTurn.providerThreadId,
                providerTurnId,
                runOrdinal: turn.runOrdinal,
                status: "interrupted",
                failure: null,
                threadDisposition: "reusable",
              },
            ]).pipe(Effect.asVoid);
          },
          respondToRuntimeRequest: () => Effect.void,
          readThreadSnapshot: () => Effect.die("unused"),
          rollbackThread: () => Effect.die("unused"),
          forkThread: () => Effect.die("unused"),
        };
      }),
  };
  const database = SqlitePersistenceMemory;
  const layer = Layer.mergeAll(
    makeOrchestratorV2ReplayLayerWithRegistry(
      { name: `title-refresh-${input.name}` },
      ProviderAdapterRegistry.makeSingleLayer(adapter),
      { databaseLayer: database, runEffectWorker: false },
    ),
    EffectOutbox.layer.pipe(Layer.provide(database)),
  );

  return yield* Effect.gen(function* () {
    const orchestrator = yield* Orchestrator.OrchestratorV2;
    const worker = yield* EffectWorker.OrchestrationEffectWorkerV2;
    const outbox = yield* EffectOutbox.EffectOutboxV2;
    const threadId = ThreadId.make(`thread:title-refresh-${input.name}`);
    const watch = (predicate: (event: OrchestrationV2DomainEvent) => boolean) =>
      orchestrator.streamDomainEvents.pipe(
        Stream.filter(predicate),
        Stream.take(1),
        Stream.runDrain,
        Effect.forkScoped,
      );

    yield* orchestrator.dispatch({
      type: "thread.create",
      commandId: CommandId.make("create"),
      threadId,
      projectId: ProjectId.make("project:title-refresh"),
      title: "New thread",
      modelSelection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: cwd,
      createdBy: "user",
      creationSource: "web",
    });
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("first"),
      threadId,
      messageId: firstMessageId,
      text: input.text,
      attachments: [],
      titleSeed: input.text,
      dispatchMode: { type: "start_immediately" },
      createdBy: "user",
      creationSource: "web",
    });
    const markerAfterDispatch = (yield* orchestrator.getThreadProjection(threadId)).thread
      .titleRefreshMessageId;
    const running = yield* watch(
      (event) => event.type === "provider-turn.updated" && event.payload.status === "running",
    );
    yield* worker.drain();
    yield* Fiber.join(running);

    if (input.steerRestartDuringRun === true) {
      const runs = (yield* orchestrator.getThreadProjection(threadId)).runs;
      const restarted = yield* watch(
        (event) =>
          event.type === "provider-turn.updated" &&
          event.payload.status === "running" &&
          event.payload.runAttemptId !== runs[0]!.activeAttemptId,
      );
      yield* orchestrator.dispatch({
        type: "message.dispatch",
        commandId: CommandId.make("steer"),
        threadId,
        messageId: MessageId.make("message:steer"),
        text: "Also handle negative readings",
        attachments: [],
        dispatchMode: { type: "restart_active", targetRunId: runs[0]!.id },
        createdBy: "user",
        creationSource: "web",
      });
      yield* worker.drain();
      yield* Fiber.join(restarted);
    }
    if (input.renameDuringRun === true) {
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("rename"),
        threadId,
        title: "Renamed by user",
      });
    }
    yield* orchestrator.dispatch({
      type: "message.dispatch",
      commandId: CommandId.make("follow-up"),
      threadId,
      messageId: MessageId.make("message:follow-up"),
      text: "Then summarize it",
      attachments: [],
      dispatchMode: { type: "queue_after_active" },
      createdBy: "user",
      creationSource: "web",
    });
    const followUpStarted = yield* watch(
      (event) =>
        event.type === "run.updated" &&
        event.payload.userMessageId === MessageId.make("message:follow-up") &&
        event.payload.status === "starting",
    );

    const started = yield* orchestrator.getThreadProjection(threadId);
    const firstRunId = started.messages.find((message) => message.id === firstMessageId)!.runId;
    const firstRun = started.runs.find((run) => run.id === firstRunId)!;
    const turn = started.providerTurns.find(
      (candidate) => candidate.runAttemptId === firstRun.activeAttemptId,
    )!;
    const ended = yield* watch(
      (event) =>
        event.type === "run.updated" &&
        event.payload.id === firstRun.id &&
        event.payload.status === (input.ending === "completed" ? "waiting" : "interrupted"),
    );
    yield* Queue.offer(events, {
      type: "provider_turn.updated",
      driver,
      providerTurn: { ...turn, status: input.ending, completedAt: yield* DateTime.now },
    });
    yield* Queue.offer(events, {
      type: "turn.terminal",
      driver,
      providerThreadId: turn.providerThreadId,
      providerTurnId: turn.id,
      runOrdinal: firstRun.ordinal,
      status: input.ending,
      failure: null,
      threadDisposition: "reusable",
    });
    // Checkpoint capture settles a completed run; its terminal event then
    // reaches the orchestrator, which starts the queued follow-up last.
    yield* Fiber.join(ended);
    yield* worker.drain();
    yield* Fiber.join(followUpStarted);

    const refreshCommandId = CommandId.make(`command:system:title-refresh:${firstRun.id}`);
    return {
      markerAfterDispatch,
      refreshCommandId,
      thread: (yield* orchestrator.getThreadProjection(threadId)).thread,
      refreshEffects: (yield* outbox.listByCommandId(refreshCommandId)).map(
        (effect) => effect.request,
      ),
    };
  }).pipe(Effect.provide(layer));
});

describe("first-run title refresh", () => {
  it.effect.each(["$wayfinder 769", "/review"])(
    "regenerates the title after a first run started with %s",
    (text) =>
      Effect.scoped(
        Effect.gen(function* () {
          const result = yield* runFirstTurn({
            name: `bare-${text.slice(1)}`,
            text,
            ending: "completed",
          });
          assert.equal(result.markerAfterDispatch, firstMessageId);
          assert.isNull(result.thread.titleRefreshMessageId);
          assert.equal(result.thread.titleRegeneration?.requestId, result.refreshCommandId);
          assert.deepEqual(result.refreshEffects, [
            { type: "thread-title.generate", kind: { type: "regenerate" } },
          ]);
        }),
      ),
  );

  it.effect.each(["Fix the failing parser", "$wayfinder fix the parser"])(
    "keeps the initial title flow alone for %s",
    (text) =>
      Effect.scoped(
        Effect.gen(function* () {
          const result = yield* runFirstTurn({
            name: `prompt-${text.length}`,
            text,
            ending: "completed",
          });
          assert.isUndefined(result.markerAfterDispatch);
          // The initial generation is still the only title request.
          assert.equal(result.thread.titleRegeneration?.requestId, CommandId.make("first"));
          assert.deepEqual(result.refreshEffects, []);
        }),
      ),
  );

  it.effect("keeps a rename made during the first run", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const result = yield* runFirstTurn({
          name: "rename",
          text: "$wayfinder 769",
          ending: "completed",
          renameDuringRun: true,
        });
        assert.equal(result.thread.title, "Renamed by user");
        assert.isNull(result.thread.titleRefreshMessageId);
        assert.isNull(result.thread.titleRegeneration);
        assert.deepEqual(result.refreshEffects, []);
      }),
    ),
  );

  it.effect("regenerates the title after a steering restart of the first run", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const result = yield* runFirstTurn({
          name: "steer-restart",
          text: "$wayfinder 769",
          ending: "completed",
          steerRestartDuringRun: true,
        });
        assert.isNull(result.thread.titleRefreshMessageId);
        assert.deepEqual(result.refreshEffects, [
          { type: "thread-title.generate", kind: { type: "regenerate" } },
        ]);
      }),
    ),
  );

  it.effect("forgets the refresh when the first run is interrupted", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const result = yield* runFirstTurn({
          name: "interrupted",
          text: "$wayfinder 769",
          ending: "interrupted",
        });
        assert.isNull(result.thread.titleRefreshMessageId);
        assert.equal(result.thread.titleRegeneration?.requestId, CommandId.make("first"));
        assert.deepEqual(result.refreshEffects, []);
      }),
    ),
  );
});
