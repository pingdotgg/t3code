// @effect-diagnostics globalTimers:off
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { MigrationsLive } from "../../persistence/Migrations.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { BoardRegistry } from "../Services/BoardRegistry.ts";
import { ScriptCancelRegistry } from "../Services/ScriptCancelRegistry.ts";
import { StepExecutor, type StepExecutorShape } from "../Services/StepExecutor.ts";
import { WorkflowBoardSaveLocks } from "../Services/WorkflowBoardSaveLocks.ts";
import { WorkflowEngine } from "../Services/WorkflowEngine.ts";
import { WorkflowEventStore } from "../Services/WorkflowEventStore.ts";
import { WorkflowReadModel } from "../Services/WorkflowReadModel.ts";
import { WorkflowFoundationLive } from "../WorkflowFoundationLive.ts";
import { ApprovalGateLive } from "./ApprovalGate.ts";
import { BoardRegistryLive } from "./BoardRegistry.ts";
import { PredicateEvaluatorLive } from "./PredicateEvaluator.ts";
import { WorkflowBoardSaveLocksLive } from "./WorkflowBoardSaveLocks.ts";
import { WorkflowEventCommitterLive } from "./WorkflowEventCommitter.ts";
import { WorkflowEngineLayer } from "./WorkflowEngine.ts";
import { DeterministicWorkflowIds } from "./WorkflowIds.ts";
import { WorkflowReadModelLive } from "./WorkflowReadModel.ts";
import { WorkflowRoutingContextBuilderLive } from "./WorkflowRoutingContextBuilder.ts";

// A step that blocks forever so a ticket admitted into an auto lane keeps a
// running pipeline we can prove the external supersession path interrupts.
const blockingExecutor = Layer.succeed(StepExecutor, {
  execute: () => Effect.never,
} satisfies StepExecutorShape);

const layer = it.layer(
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
    Layer.provideMerge(DeterministicWorkflowIds),
    Layer.provideMerge(WorkflowFoundationLive),
    Layer.provideMerge(MigrationsLive),
    Layer.provideMerge(SqlitePersistenceMemory),
  ),
);

// inbox lane is WIP-limited (1) so a second create queues; work lane is auto so
// an admitted ticket starts a (blocking) pipeline we can supersede; done is the
// terminal lane work_source closes tickets into.
const definition = {
  name: "work source",
  lanes: [
    {
      key: "inbox",
      name: "Inbox",
      entry: "manual",
      wipLimit: 1,
    },
    {
      key: "work",
      name: "Work",
      entry: "auto",
      pipeline: [
        {
          key: "code",
          type: "agent",
          agent: { instance: "claude_main", model: "sonnet" },
          instruction: "do it",
        },
      ],
    },
    { key: "done", name: "Done", entry: "manual", terminal: true },
  ],
};

// The committer holds the board save lock + an open transaction once per chunk;
// the unlocked engine ops assume that context. This mirrors how Task 9's syncer
// will drive them — fetch the lock + sql from context and wrap the body.
const inLockAndTx = <A, E>(boardId: string, body: Effect.Effect<A, E, SqlClient.SqlClient>) =>
  Effect.gen(function* () {
    const saveLocks = yield* WorkflowBoardSaveLocks;
    const sql = yield* SqlClient.SqlClient;
    return yield* saveLocks.withSaveLock(boardId as never, sql.withTransaction(body));
  });

layer("WorkflowEngine work_source unlocked ops", (it) => {
  it.effect("createTicketAndEnterUnlocked admits into an empty lane", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register("b-ws-empty" as never, definition);
      const engine = yield* WorkflowEngine;
      const read = yield* WorkflowReadModel;
      const store = yield* WorkflowEventStore;

      const result = yield* inLockAndTx(
        "b-ws-empty",
        engine.createTicketAndEnterUnlocked({
          boardId: "b-ws-empty" as never,
          title: "First",
          description: "from a work source",
          destinationLane: "inbox" as never,
        }),
      );

      assert.equal(result.outcome, "moved");

      const detail = yield* read.getTicketDetail(result.ticketId);
      assert.equal(detail?.ticket.currentLaneKey, "inbox");
      assert.equal(detail?.ticket.title, "First");
      assert.equal(detail?.ticket.description, "from a work source");

      const events = yield* Stream.runCollect(store.readByTicket(result.ticketId)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      );
      assert.isDefined(events.find((event) => event.type === "TicketCreated"));
      assert.isDefined(events.find((event) => event.type === "TicketMovedToLane"));
    }),
  );

  it.effect("createTicketAndEnterUnlocked queues when the WIP-1 lane is occupied", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register("b-ws-wip" as never, definition);
      const engine = yield* WorkflowEngine;
      const read = yield* WorkflowReadModel;
      const store = yield* WorkflowEventStore;

      const first = yield* inLockAndTx(
        "b-ws-wip",
        engine.createTicketAndEnterUnlocked({
          boardId: "b-ws-wip" as never,
          title: "Occupant",
          destinationLane: "inbox" as never,
        }),
      );
      assert.equal(first.outcome, "moved");

      const second = yield* inLockAndTx(
        "b-ws-wip",
        engine.createTicketAndEnterUnlocked({
          boardId: "b-ws-wip" as never,
          title: "Queued",
          destinationLane: "inbox" as never,
        }),
      );
      assert.equal(second.outcome, "queued");

      const detail = yield* read.getTicketDetail(second.ticketId);
      assert.equal(detail?.ticket.currentLaneKey, "inbox");
      assert.equal(detail?.ticket.queuedAt !== null, true);

      const events = yield* Stream.runCollect(store.readByTicket(second.ticketId)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      );
      assert.isDefined(events.find((event) => event.type === "TicketCreated"));
      assert.isDefined(events.find((event) => event.type === "TicketQueued"));
    }),
  );

  it.effect("closeTicketFromSourceUnlocked moves to the closed lane and records work_source", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register("b-ws-close" as never, definition);
      const engine = yield* WorkflowEngine;
      const read = yield* WorkflowReadModel;
      const store = yield* WorkflowEventStore;

      const created = yield* inLockAndTx(
        "b-ws-close",
        engine.createTicketAndEnterUnlocked({
          boardId: "b-ws-close" as never,
          title: "Close me",
          destinationLane: "inbox" as never,
        }),
      );

      yield* inLockAndTx(
        "b-ws-close",
        engine.closeTicketFromSourceUnlocked(created.ticketId, "done" as never),
      );

      const detail = yield* read.getTicketDetail(created.ticketId);
      assert.equal(detail?.ticket.currentLaneKey, "done");

      const events = yield* Stream.runCollect(store.readByTicket(created.ticketId)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      );
      const decision = events.find((event) => event.type === "TicketRouteDecided");
      assert.isDefined(decision);
      if (decision?.type === "TicketRouteDecided") {
        assert.equal(decision.payload.source, "work_source");
        assert.equal(decision.payload.toLane, "done");
        assert.equal(decision.payload.fromLane, "inbox");
      }
      const externalMove = events.find(
        (event) =>
          event.type === "TicketMovedToLane" &&
          event.payload.reason === "external" &&
          event.payload.toLane === ("done" as string),
      );
      assert.isDefined(externalMove);

      const decisions = yield* read.listTicketRouteDecisions(created.ticketId);
      assert.isDefined(decisions.find((row) => row.source === "work_source"));
    }),
  );

  it.effect("closeTicketFromSourceUnlocked supersedes running work via the external path", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register("b-ws-supersede" as never, definition);
      const engine = yield* WorkflowEngine;
      const read = yield* WorkflowReadModel;
      const sql = yield* SqlClient.SqlClient;

      const created = yield* inLockAndTx(
        "b-ws-supersede",
        engine.createTicketAndEnterUnlocked({
          boardId: "b-ws-supersede" as never,
          title: "Running work",
          destinationLane: "inbox" as never,
        }),
      );

      // Seed a pending dispatch outbox row standing in for in-flight work. The
      // external supersession path (which closeTicketFromSourceUnlocked reuses)
      // tombstones pending/started rows to 'confirmed' so restart recovery never
      // re-dispatches the superseded work.
      yield* sql`
        INSERT INTO workflow_dispatch_outbox (
          dispatch_id, ticket_id, step_run_id, thread_id, provider_instance,
          model, instruction, worktree_path, status, created_at
        ) VALUES (
          'dispatch-ws-1', ${created.ticketId}, 'step-ws-1', 'thread-ws-1', 'claude_main',
          'sonnet', 'do it', '/tmp/wt', 'pending', '2026-06-13T00:00:00.000Z'
        )
      `;

      yield* inLockAndTx(
        "b-ws-supersede",
        engine.closeTicketFromSourceUnlocked(created.ticketId, "done" as never),
      );

      const live = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM workflow_dispatch_outbox
        WHERE ticket_id = ${created.ticketId} AND status IN ('pending', 'started')
      `;
      assert.equal(live[0]?.count ?? 0, 0);

      const detail = yield* read.getTicketDetail(created.ticketId);
      assert.equal(detail?.ticket.currentLaneKey, "done");
    }),
  );

  it.effect("editTicketFieldsUnlocked appends a TicketEdited event", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register("b-ws-edit" as never, definition);
      const engine = yield* WorkflowEngine;
      const read = yield* WorkflowReadModel;
      const store = yield* WorkflowEventStore;

      const created = yield* inLockAndTx(
        "b-ws-edit",
        engine.createTicketAndEnterUnlocked({
          boardId: "b-ws-edit" as never,
          title: "Old title",
          destinationLane: "inbox" as never,
        }),
      );

      yield* inLockAndTx(
        "b-ws-edit",
        engine.editTicketFieldsUnlocked(created.ticketId, {
          title: "New title",
          description: "New description",
        }),
      );

      const detail = yield* read.getTicketDetail(created.ticketId);
      assert.equal(detail?.ticket.title, "New title");
      assert.equal(detail?.ticket.description, "New description");

      const events = yield* Stream.runCollect(store.readByTicket(created.ticketId)).pipe(
        Effect.map((chunk) => Array.from(chunk)),
      );
      assert.isDefined(events.find((event) => event.type === "TicketEdited"));
    }),
  );

  it.effect(
    "editTicketFieldsUnlocked does not blank the stored title for a whitespace-only title",
    () =>
      Effect.gen(function* () {
        const registry = yield* BoardRegistry;
        yield* registry.register("b-ws-blank" as never, definition);
        const engine = yield* WorkflowEngine;
        const read = yield* WorkflowReadModel;
        const store = yield* WorkflowEventStore;

        const created = yield* inLockAndTx(
          "b-ws-blank",
          engine.createTicketAndEnterUnlocked({
            boardId: "b-ws-blank" as never,
            title: "Keep me",
            destinationLane: "inbox" as never,
          }),
        );

        // A whitespace-only title must be OMITTED (mirrors locked editTicket):
        // with no other field, nothing changes and no event is emitted; the
        // stored title stays intact rather than being overwritten to "".
        yield* inLockAndTx(
          "b-ws-blank",
          engine.editTicketFieldsUnlocked(created.ticketId, { title: "   " }),
        );

        const detail = yield* read.getTicketDetail(created.ticketId);
        assert.equal(detail?.ticket.title, "Keep me");

        const events = yield* Stream.runCollect(store.readByTicket(created.ticketId)).pipe(
          Effect.map((chunk) => Array.from(chunk)),
        );
        assert.isUndefined(events.find((event) => event.type === "TicketEdited"));

        // A whitespace-only title alongside a real description still drops the
        // title but applies the description.
        yield* inLockAndTx(
          "b-ws-blank",
          engine.editTicketFieldsUnlocked(created.ticketId, {
            title: "  ",
            description: "real desc",
          }),
        );
        const after = yield* read.getTicketDetail(created.ticketId);
        assert.equal(after?.ticket.title, "Keep me");
        assert.equal(after?.ticket.description, "real desc");
      }),
  );

  it.effect(
    "Fix 1: editTicketFieldsUnlocked WRITES an empty-string description (clear), distinct from undefined (leave)",
    () =>
      Effect.gen(function* () {
        const registry = yield* BoardRegistry;
        yield* registry.register("b-ws-clear" as never, definition);
        const engine = yield* WorkflowEngine;
        const read = yield* WorkflowReadModel;
        const store = yield* WorkflowEventStore;

        const created = yield* inLockAndTx(
          "b-ws-clear",
          engine.createTicketAndEnterUnlocked({
            boardId: "b-ws-clear" as never,
            title: "Title",
            description: "Has a body",
            destinationLane: "inbox" as never,
          }),
        );
        const before = yield* read.getTicketDetail(created.ticketId);
        assert.equal(before?.ticket.description, "Has a body");

        // A PROVIDED empty-string description is a valid CLEAR: it must emit a
        // TicketEdited{description:""} and the projection must show "" — NOT keep
        // the old body and NOT be dropped like an empty title.
        yield* inLockAndTx(
          "b-ws-clear",
          engine.editTicketFieldsUnlocked(created.ticketId, { description: "" }),
        );

        const after = yield* read.getTicketDetail(created.ticketId);
        assert.equal(after?.ticket.description, "");

        const events = yield* Stream.runCollect(store.readByTicket(created.ticketId)).pipe(
          Effect.map((chunk) => Array.from(chunk)),
        );
        const edited = events.filter((event) => event.type === "TicketEdited");
        assert.isAbove(edited.length, 0);
      }),
  );

  it.effect("withBoardAdmissionLock mutually excludes bodies for the same board", () =>
    Effect.gen(function* () {
      const engine = yield* WorkflowEngine;
      const inside = yield* Ref.make(0);
      const maxConcurrent = yield* Ref.make(0);
      const firstEntered = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();

      // Body A enters the admission lock, signals it is inside, then blocks on
      // `release`. If the lock did NOT mutually exclude, body B would enter
      // concurrently and push the observed concurrency above 1.
      const bodyA = engine.withBoardAdmissionLock(
        "b-admit-mutex" as never,
        Effect.gen(function* () {
          const n = yield* Ref.updateAndGet(inside, (c) => c + 1);
          yield* Ref.update(maxConcurrent, (m) => Math.max(m, n));
          yield* Deferred.succeed(firstEntered, undefined);
          yield* Deferred.await(release);
          yield* Ref.update(inside, (c) => c - 1);
        }),
      );

      const bodyB = engine.withBoardAdmissionLock(
        "b-admit-mutex" as never,
        Effect.gen(function* () {
          const n = yield* Ref.updateAndGet(inside, (c) => c + 1);
          yield* Ref.update(maxConcurrent, (m) => Math.max(m, n));
          yield* Ref.update(inside, (c) => c - 1);
        }),
      );

      const fiberA = yield* bodyA.pipe(Effect.forkScoped);
      yield* Deferred.await(firstEntered);
      // B is launched while A is provably still inside the lock.
      const fiberB = yield* bodyB.pipe(Effect.forkScoped);
      // Give B a chance to (wrongly) enter if the lock were not exclusive.
      yield* Effect.yieldNow;
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(fiberA);
      yield* Fiber.join(fiberB);

      assert.equal(yield* Ref.get(maxConcurrent), 1);
    }),
  );

  it.effect(
    "withBoardAdmissionLock serializes an unlocked admit against the public path: exactly one admitted into a WIP-1 lane",
    () =>
      Effect.gen(function* () {
        const registry = yield* BoardRegistry;
        yield* registry.register("b-admit-race" as never, definition);
        const engine = yield* WorkflowEngine;
        const read = yield* WorkflowReadModel;

        // Seed one ticket sitting (admitted) in a NON-target lane so the public
        // path can move it into the WIP-1 `inbox` lane. The unlocked path
        // creates a second ticket destined for the same `inbox` lane.
        const mover = yield* inLockAndTx(
          "b-admit-race",
          engine.createTicketAndEnterUnlocked({
            boardId: "b-admit-race" as never,
            title: "Mover",
            destinationLane: "done" as never,
          }),
        );

        // PUBLIC path: moveTicket wraps its WIP read-decide in the admission
        // lock (admission OUTER) and takes the save lock at commit (INNER).
        const publicAdmit = engine.moveTicket(mover.ticketId, "inbox" as never);

        // UNLOCKED path mirrors the source committer: admission lock (OUTER) ->
        // save lock (INNER) -> transaction, then the unlocked create+enter.
        const unlockedAdmit = engine.withBoardAdmissionLock(
          "b-admit-race" as never,
          inLockAndTx(
            "b-admit-race",
            engine.createTicketAndEnterUnlocked({
              boardId: "b-admit-race" as never,
              title: "Syncer",
              destinationLane: "inbox" as never,
            }),
          ),
        );

        // Run them concurrently. Because both serialize their WIP read-decide
        // under the SAME per-board admission semaphore, exactly one wins
        // admission into the WIP-1 lane; the other is queued. Without the shared
        // admission lock both could read occupancy=0 and both admit.
        yield* Effect.all([publicAdmit, unlockedAdmit], { concurrency: "unbounded" });

        const admittedCount = yield* read.countAdmittedInLane(
          "b-admit-race" as never,
          "inbox" as never,
        );
        assert.equal(admittedCount, 1);
      }),
  );
});

// Fix 1 (stale-token start guard). recoverBoardWip / runLane snapshot a ticket's
// lane+token, then start its pipeline LATER. A user/source move in between can
// change the ticket's current_lane_entry_token, leaving the snapshot stale.
// startPipeline must re-read the live projection and SKIP a start whose
// lane/token no longer matches. We prove it by decorating the read model so
// runLane is handed a STALE token while the live projection (which the guard
// reads via raw SQL) still holds the real, current token: the guard must skip,
// so no pipeline run is ever created for the stale token.
it.effect("startPipeline skips a stale-token start whose ticket has moved on", () =>
  Effect.gen(function* () {
    const staleToken = yield* Ref.make<{
      readonly ticketId: string;
      readonly token: string;
    } | null>(null);

    // Decorator: requires the real WorkflowReadModel and re-publishes it,
    // overriding getTicketDetail to swap in a stale token for the targeted
    // ticket. Everything else delegates unchanged.
    const StaleReadModel = Layer.effect(
      WorkflowReadModel,
      Effect.gen(function* () {
        const base = yield* WorkflowReadModel;
        const override: typeof base.getTicketDetail = (ticketId) =>
          Effect.gen(function* () {
            const detail = yield* base.getTicketDetail(ticketId);
            const stale = yield* Ref.get(staleToken);
            if (detail === null || stale === null || (ticketId as string) !== stale.ticketId) {
              return detail;
            }
            return {
              ...detail,
              ticket: { ...detail.ticket, currentLaneEntryToken: stale.token },
            };
          });
        return { ...base, getTicketDetail: override } satisfies typeof base;
      }),
    ).pipe(Layer.provide(WorkflowReadModelLive));

    const testLayer = WorkflowEngineLayer.pipe(
      Layer.provide(StaleReadModel),
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
      Layer.provideMerge(DeterministicWorkflowIds),
      Layer.provideMerge(WorkflowFoundationLive),
      Layer.provideMerge(MigrationsLive),
      Layer.provideMerge(SqlitePersistenceMemory),
    );

    yield* Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register("b-stale-start" as never, definition);
      const engine = yield* WorkflowEngine;
      const read = yield* WorkflowReadModel;
      const sql = yield* SqlClient.SqlClient;

      // Admit a ticket into the auto `work` lane (start dropped under the
      // unlocked path). It now holds the real, current token in `work`.
      const created = yield* inLockAndTx(
        "b-stale-start",
        engine.createTicketAndEnterUnlocked({
          boardId: "b-stale-start" as never,
          title: "Moved on",
          destinationLane: "work" as never,
        }),
      );

      // Point the decorator at this ticket with a token that does NOT match the
      // live projection — modelling a move that re-tokened the ticket after the
      // snapshot but before the start.
      yield* Ref.set(staleToken, {
        ticketId: created.ticketId as string,
        token: "stale-entry-token",
      });

      // runLane reads the (stale) detail and asks startPipeline to start the
      // stale token. The guard re-reads the live token and skips.
      yield* engine.runLane(created.ticketId);
      yield* Effect.yieldNow;

      const staleRuns = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_pipeline_run
        WHERE ticket_id = ${created.ticketId as string}
          AND lane_entry_token = 'stale-entry-token'
      `;
      assert.equal(staleRuns[0]?.count ?? 0, 0);

      // No pipeline run at all was created from the stale start.
      const anyRuns = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_pipeline_run
        WHERE ticket_id = ${created.ticketId as string}
      `;
      assert.equal(anyRuns[0]?.count ?? 0, 0);

      // With the stale override cleared, the ticket is still legitimately
      // admitted in `work`: runLane now starts the real, current token.
      yield* Ref.set(staleToken, null);
      const liveDetail = yield* read.getTicketDetail(created.ticketId);
      assert.equal(liveDetail?.ticket.currentLaneKey, "work");
      yield* engine.runLane(created.ticketId);
      yield* Effect.yieldNow;
      const liveRuns = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_pipeline_run
        WHERE ticket_id = ${created.ticketId as string}
          AND lane_entry_token = ${liveDetail?.ticket.currentLaneEntryToken as string}
      `;
      assert.isAbove(liveRuns[0]?.count ?? 0, 0);
    }).pipe(Effect.provide(testLayer));
  }),
);
