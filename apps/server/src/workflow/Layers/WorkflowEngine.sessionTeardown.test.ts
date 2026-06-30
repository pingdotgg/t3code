// @effect-diagnostics globalTimers:off
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { MigrationsLive } from "../../persistence/Migrations.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { BoardRegistry } from "../Services/BoardRegistry.ts";
import { ScriptCancelRegistry } from "../Services/ScriptCancelRegistry.ts";
import { StepExecutor, type StepExecutorShape } from "../Services/StepExecutor.ts";
import { WorkflowAgentSessionStore } from "../Services/WorkflowAgentSessionStore.ts";
import { WorkflowBoardSaveLocks } from "../Services/WorkflowBoardSaveLocks.ts";
import { WorkflowEngine } from "../Services/WorkflowEngine.ts";
import { WorkflowFoundationLive } from "../WorkflowFoundationLive.ts";
import { ApprovalGateLive } from "./ApprovalGate.ts";
import { BoardRegistryLive } from "./BoardRegistry.ts";
import { PredicateEvaluatorLive } from "./PredicateEvaluator.ts";
import { WorkflowBoardSaveLocksLive } from "./WorkflowBoardSaveLocks.ts";
import { WorkflowEventCommitterLive } from "./WorkflowEventCommitter.ts";
import { WorkflowEngineLayer } from "./WorkflowEngine.ts";
import { DeterministicWorkflowIds } from "./WorkflowIds.ts";
import { WorkflowRoutingContextBuilderLive } from "./WorkflowRoutingContextBuilder.ts";

// A step that never resolves so an admitted ticket keeps a running pipeline; the
// teardown tests never start a pipeline (terminal/manual lanes), so this is just
// a placeholder so the engine layer resolves a StepExecutor.
const blockingExecutor = Layer.succeed(StepExecutor, {
  execute: () => Effect.never,
} satisfies StepExecutorShape);

// Records every stopSession call so the tests can prove best-effort provider
// teardown ran for the ticket's stored agent threads when it lands in a terminal
// lane (or its board is deleted).
const makeRecordingProvider = (calls: Ref.Ref<ReadonlyArray<string>>) =>
  Layer.succeed(ProviderService, {
    startSession: () => Effect.die("unused"),
    sendTurn: () => Effect.die("unused"),
    interruptTurn: () => Effect.die("unused"),
    respondToRequest: () => Effect.die("unused"),
    respondToUserInput: () => Effect.die("unused"),
    stopSession: (input) => Ref.update(calls, (threads) => [...threads, input.threadId as string]),
    listSessions: () => Effect.succeed([]),
    getCapabilities: () => Effect.die("unused"),
    getInstanceInfo: () => Effect.die("unused"),
    rollbackConversation: () => Effect.die("unused"),
    streamEvents: Stream.empty,
  } satisfies ProviderServiceShape);

const makeLayer = (calls: Ref.Ref<ReadonlyArray<string>>) =>
  WorkflowEngineLayer.pipe(
    Layer.provideMerge(WorkflowEventCommitterLive),
    Layer.provideMerge(
      Layer.succeed(ScriptCancelRegistry, {
        register: () => Effect.void,
        unregister: () => Effect.void,
        cancel: () => Effect.void,
      }),
    ),
    Layer.provideMerge(blockingExecutor),
    Layer.provideMerge(ApprovalGateLive),
    Layer.provideMerge(BoardRegistryLive),
    Layer.provideMerge(PredicateEvaluatorLive),
    Layer.provideMerge(WorkflowRoutingContextBuilderLive),
    Layer.provideMerge(WorkflowBoardSaveLocksLive),
    Layer.provideMerge(makeRecordingProvider(calls)),
    Layer.provideMerge(DeterministicWorkflowIds),
    Layer.provideMerge(WorkflowFoundationLive),
    Layer.provideMerge(MigrationsLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  );

// inbox is a manual non-terminal start lane; done is the terminal lane the
// teardown must fire on.
const definition = {
  name: "session teardown",
  lanes: [
    { key: "inbox", name: "Inbox", entry: "manual" },
    { key: "done", name: "Done", entry: "manual", terminal: true },
  ],
};

const inLockAndTx = <A, E>(boardId: string, body: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.gen(function* () {
    const saveLocks = yield* WorkflowBoardSaveLocks;
    const sql = yield* SqlClient.SqlClient;
    return yield* saveLocks.withSaveLock(boardId as never, sql.withTransaction(body));
  });

it.effect(
  "terminal entry via the normal (manual) move tears down the ticket's stored agent sessions",
  () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<string>>([]);

      yield* Effect.gen(function* () {
        const registry = yield* BoardRegistry;
        yield* registry.register("b-teardown-normal" as never, definition);
        const engine = yield* WorkflowEngine;
        const sessions = yield* WorkflowAgentSessionStore;

        const ticketId = yield* engine.createTicket({
          boardId: "b-teardown-normal" as never,
          title: "Has a session",
          initialLane: "inbox" as never,
        });

        // Record a stored per-agent session as if a prior `continueSession` step
        // had resumed against a stable thread.
        yield* sessions.upsert(ticketId, "inbox" as never, "agent-a", "thread-teardown-1");
        assert.equal((yield* sessions.listByTicket(ticketId)).length, 1);

        yield* engine.moveTicket(ticketId, "done" as never);

        // deleteByTicket: the stored row is gone after landing in the terminal lane.
        assert.equal((yield* sessions.listByTicket(ticketId)).length, 0);
        // best-effort stopSession: the thread was stopped before deletion.
        assert.deepEqual(yield* Ref.get(calls), ["thread-teardown-1"]);
      }).pipe(Effect.provide(makeLayer(calls)));
    }),
);

it.effect(
  "closeTicketFromSourceUnlocked into a terminal lane deletes stored sessions in-tx but DEFERS the live stopSession (never runs it inside the chunk transaction)",
  () =>
    Effect.gen(function* () {
      const calls = yield* Ref.make<ReadonlyArray<string>>([]);

      yield* Effect.gen(function* () {
        const registry = yield* BoardRegistry;
        yield* registry.register("b-teardown-close" as never, definition);
        const engine = yield* WorkflowEngine;
        const sessions = yield* WorkflowAgentSessionStore;

        const created = yield* inLockAndTx(
          "b-teardown-close",
          engine.createTicketAndEnterUnlocked({
            boardId: "b-teardown-close" as never,
            title: "Close me",
            destinationLane: "inbox" as never,
          }),
        );

        yield* sessions.upsert(created.ticketId, "inbox" as never, "agent-a", "thread-teardown-2");
        assert.equal((yield* sessions.listByTicket(created.ticketId)).length, 1);

        // The source committer SNAPSHOTS the stored threads in-tx (before the
        // close deletes the rows) so it can stop them after the chunk commits —
        // `provider.stopSession` is a non-rollbackable live side effect that must
        // not run inside the chunk transaction. Mirror that here.
        const snapshot = yield* inLockAndTx(
          "b-teardown-close",
          Effect.gen(function* () {
            const threads = yield* engine.terminalAgentSessionThreadsForTicket(created.ticketId);
            yield* engine.closeTicketFromSourceUnlocked(created.ticketId, "done" as never);
            return threads;
          }),
        );

        // tx-safe deleteByTicket ran in-band inside the chunk transaction: the row
        // is gone.
        assert.equal((yield* sessions.listByTicket(created.ticketId)).length, 0);
        // The snapshot captured the thread before deletion so the live stop can be
        // deferred to the committer's post-commit phase.
        assert.deepEqual(snapshot, ["thread-teardown-2"]);
        // CRITICAL: the live stopSession was NOT invoked on the in-tx path —
        // deferred to post-commit, unlike the public-move path which stops in-band.
        assert.deepEqual(yield* Ref.get(calls), []);

        // Post-commit (outside any chunk tx): the committer replays the snapshot
        // through stopAgentSessionsForTicket, which is when the live stop fires.
        yield* engine.stopAgentSessionsForTicket(snapshot);
        assert.deepEqual(yield* Ref.get(calls), ["thread-teardown-2"]);
      }).pipe(Effect.provide(makeLayer(calls)));
    }),
);

it.effect("a non-terminal move never tears down stored agent sessions", () =>
  Effect.gen(function* () {
    const calls = yield* Ref.make<ReadonlyArray<string>>([]);

    yield* Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      // Two non-terminal lanes so the move below stays out of a terminal lane.
      yield* registry.register("b-teardown-noop" as never, {
        name: "no teardown",
        lanes: [
          { key: "inbox", name: "Inbox", entry: "manual" },
          { key: "review", name: "Review", entry: "manual" },
        ],
      });
      const engine = yield* WorkflowEngine;
      const sessions = yield* WorkflowAgentSessionStore;

      const ticketId = yield* engine.createTicket({
        boardId: "b-teardown-noop" as never,
        title: "Stays open",
        initialLane: "inbox" as never,
      });
      yield* sessions.upsert(ticketId, "inbox" as never, "agent-a", "thread-noop");

      yield* engine.moveTicket(ticketId, "review" as never);

      // The session row survives a non-terminal move and no stopSession fired.
      assert.equal((yield* sessions.listByTicket(ticketId)).length, 1);
      assert.deepEqual(yield* Ref.get(calls), []);
    }).pipe(Effect.provide(makeLayer(calls)));
  }),
);
