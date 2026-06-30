// @effect-diagnostics globalTimers:off
import { assert, it } from "@effect/vitest";
import type { BoardTicketView } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
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
import { WorkflowEventStoreError } from "../Services/Errors.ts";
import { ScriptCancelRegistry } from "../Services/ScriptCancelRegistry.ts";
import { StepExecutor, type StepExecutorShape } from "../Services/StepExecutor.ts";
import { WorkflowBoardEvents } from "../Services/WorkflowBoardEvents.ts";
import { WorkflowEngine } from "../Services/WorkflowEngine.ts";
import { WorkflowEventStore } from "../Services/WorkflowEventStore.ts";
import { WorkflowReadModel } from "../Services/WorkflowReadModel.ts";
import {
  WorkflowSourceCommitter,
  type ReconcileLanes,
  type SourceDelta,
  type SourceItemFields,
} from "../Services/WorkflowSourceCommitter.ts";
import { WorkflowFoundationLive } from "../WorkflowFoundationLive.ts";
import { ApprovalGateLive } from "./ApprovalGate.ts";
import { BoardRegistryLive } from "./BoardRegistry.ts";
import { PredicateEvaluatorLive } from "./PredicateEvaluator.ts";
import { WorkflowBoardSaveLocksLive } from "./WorkflowBoardSaveLocks.ts";
import { WorkflowEventCommitterLive } from "./WorkflowEventCommitter.ts";
import { WorkflowEngineLayer } from "./WorkflowEngine.ts";
import { DeterministicWorkflowIds } from "./WorkflowIds.ts";
import { WorkflowRoutingContextBuilderLive } from "./WorkflowRoutingContextBuilder.ts";
import { WorkflowSourceCommitterLive } from "./WorkflowSourceCommitter.ts";

// A step that blocks forever so a ticket admitted into an auto lane keeps a
// running pipeline (lets us prove the post-tx pipeline-start path runs).
const blockingExecutor = Layer.succeed(StepExecutor, {
  execute: () => Effect.never,
} satisfies StepExecutorShape);

const layer = it.layer(
  WorkflowSourceCommitterLive.pipe(
    Layer.provideMerge(WorkflowEngineLayer),
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

// inbox is WIP-1 (a second create queues), work is auto (admitted tickets start
// a blocking pipeline), done is the terminal lane closes route into.
const definition = {
  name: "work source committer",
  lanes: [
    { key: "inbox", name: "Inbox", entry: "manual", wipLimit: 1 },
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

const lanes: ReconcileLanes = {
  destinationLane: "inbox" as never,
  closedLane: "done" as never,
};

const item = (over: Partial<SourceItemFields> = {}): SourceItemFields => ({
  sourceId: "src-1",
  provider: "github_issues",
  externalId: "issue-1",
  title: "Upstream issue",
  description: "body",
  contentHash: "hash-v1",
  providerVersion: "v1",
  metadata: { provider: "github_issues", url: "https://example/1", labels: ["bug"] },
  ...over,
});

interface MappingRow {
  readonly ticketId: string;
  readonly contentHash: string;
  readonly providerVersion: string | null;
  readonly lifecycle: string;
  readonly syncStatus: string;
}

const readMapping = (boardId: string, ext: SourceItemFields) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<MappingRow>`
      SELECT ticket_id AS "ticketId", content_hash AS "contentHash",
             provider_version AS "providerVersion", lifecycle AS "lifecycle",
             sync_status AS "syncStatus"
      FROM work_source_mapping
      WHERE board_id = ${boardId} AND source_id = ${ext.sourceId}
        AND provider = ${ext.provider} AND external_id = ${ext.externalId}
      LIMIT 1
    `;
    return rows[0] ?? null;
  });

const countMappings = (boardId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM work_source_mapping WHERE board_id = ${boardId}
    `;
    return rows[0]?.count ?? 0;
  });

layer("WorkflowSourceCommitter.reconcileChunk", (it) => {
  it.effect("create: a new delta creates a ticket + mapping row in the same tx", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register("b-create" as never, definition);
      const committer = yield* WorkflowSourceCommitter;
      const read = yield* WorkflowReadModel;

      const ext = item();
      yield* committer.reconcileChunk("b-create" as never, lanes, [{ _tag: "new", item: ext }]);

      const mapping = yield* readMapping("b-create", ext);
      assert.isNotNull(mapping);
      assert.equal(mapping?.contentHash, "hash-v1");
      assert.equal(mapping?.lifecycle, "open");
      assert.equal(mapping?.syncStatus, "active");

      const detail = yield* read.getTicketDetail(mapping?.ticketId as never);
      assert.equal(detail?.ticket.currentLaneKey, "inbox");
      assert.equal(detail?.ticket.title, "Upstream issue");
      assert.equal(detail?.ticket.description, "body");
    }),
  );

  it.effect("idempotent create: the same new delta twice yields exactly one ticket + mapping", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register("b-idem" as never, definition);
      const committer = yield* WorkflowSourceCommitter;

      const ext = item();
      yield* committer.reconcileChunk("b-idem" as never, lanes, [{ _tag: "new", item: ext }]);
      // Re-run with the SAME new delta (simulating a stale out-of-lock diff).
      yield* committer.reconcileChunk("b-idem" as never, lanes, [{ _tag: "new", item: ext }]);

      assert.equal(yield* countMappings("b-idem"), 1);

      const sql = yield* SqlClient.SqlClient;
      const tickets = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_ticket WHERE board_id = 'b-idem'
      `;
      assert.equal(tickets[0]?.count ?? 0, 1);
    }),
  );

  it.effect(
    "change: differing content_hash edits the ticket + bumps the mapping; same hash is a no-op",
    () =>
      Effect.gen(function* () {
        const registry = yield* BoardRegistry;
        yield* registry.register("b-change" as never, definition);
        const committer = yield* WorkflowSourceCommitter;
        const read = yield* WorkflowReadModel;
        const store = yield* WorkflowEventStore;

        const ext = item();
        yield* committer.reconcileChunk("b-change" as never, lanes, [{ _tag: "new", item: ext }]);
        const created = yield* readMapping("b-change", ext);
        const ticketId = created?.ticketId as string;

        // Same hash → no write.
        yield* committer.reconcileChunk("b-change" as never, lanes, [
          { _tag: "changed", item: ext, ticketId },
        ]);
        let events = yield* Stream.runCollect(store.readByTicket(ticketId as never)).pipe(
          Effect.map((chunk) => Array.from(chunk)),
        );
        assert.isUndefined(events.find((event) => event.type === "TicketEdited"));

        // Differing hash → edit + mapping bump.
        const changed = item({
          title: "Renamed issue",
          description: "new body",
          contentHash: "hash-v2",
          providerVersion: "v2",
        });
        yield* committer.reconcileChunk("b-change" as never, lanes, [
          { _tag: "changed", item: changed, ticketId },
        ]);

        const detail = yield* read.getTicketDetail(ticketId as never);
        assert.equal(detail?.ticket.title, "Renamed issue");
        assert.equal(detail?.ticket.description, "new body");

        const mapping = yield* readMapping("b-change", ext);
        assert.equal(mapping?.contentHash, "hash-v2");
        assert.equal(mapping?.providerVersion, "v2");

        events = yield* Stream.runCollect(store.readByTicket(ticketId as never)).pipe(
          Effect.map((chunk) => Array.from(chunk)),
        );
        assert.isDefined(events.find((event) => event.type === "TicketEdited"));
      }),
  );

  it.effect(
    "close: a closed delta routes to closedLane with source work_source + mapping lifecycle closed",
    () =>
      Effect.gen(function* () {
        const registry = yield* BoardRegistry;
        yield* registry.register("b-close" as never, definition);
        const committer = yield* WorkflowSourceCommitter;
        const read = yield* WorkflowReadModel;

        const ext = item();
        yield* committer.reconcileChunk("b-close" as never, lanes, [{ _tag: "new", item: ext }]);
        const created = yield* readMapping("b-close", ext);
        const ticketId = created?.ticketId as string;

        yield* committer.reconcileChunk("b-close" as never, lanes, [
          { _tag: "closed", item: ext, ticketId },
        ]);

        const detail = yield* read.getTicketDetail(ticketId as never);
        assert.equal(detail?.ticket.currentLaneKey, "done");

        const mapping = yield* readMapping("b-close", ext);
        assert.equal(mapping?.lifecycle, "closed");

        const decisions = yield* read.listTicketRouteDecisions(ticketId as never);
        assert.isDefined(decisions.find((row) => row.source === "work_source"));
      }),
  );

  it.effect(
    "orphan: a missing delta marks sync_status orphaned; confirmedDeleted also closes",
    () =>
      Effect.gen(function* () {
        const registry = yield* BoardRegistry;
        yield* registry.register("b-orphan" as never, definition);
        const committer = yield* WorkflowSourceCommitter;
        const read = yield* WorkflowReadModel;

        // Orphan-only path.
        const a = item({ externalId: "issue-a" });
        yield* committer.reconcileChunk("b-orphan" as never, lanes, [{ _tag: "new", item: a }]);
        const mappedA = yield* readMapping("b-orphan", a);
        yield* committer.reconcileChunk("b-orphan" as never, lanes, [
          { _tag: "missing", item: a, ticketId: mappedA?.ticketId as string },
        ]);
        const orphanA = yield* readMapping("b-orphan", a);
        assert.equal(orphanA?.syncStatus, "orphaned");
        assert.equal(orphanA?.lifecycle, "open");
        const detailA = yield* read.getTicketDetail(mappedA?.ticketId as never);
        assert.equal(detailA?.ticket.currentLaneKey, "inbox");

        // confirmedDeleted path → also terminal route + lifecycle closed.
        const b = item({ externalId: "issue-b" });
        yield* committer.reconcileChunk("b-orphan" as never, lanes, [{ _tag: "new", item: b }]);
        const mappedB = yield* readMapping("b-orphan", b);
        yield* committer.reconcileChunk("b-orphan" as never, lanes, [
          {
            _tag: "missing",
            item: b,
            ticketId: mappedB?.ticketId as string,
            confirmedDeleted: true,
          },
        ]);
        const orphanB = yield* readMapping("b-orphan", b);
        assert.equal(orphanB?.syncStatus, "orphaned");
        assert.equal(orphanB?.lifecycle, "closed");
        const detailB = yield* read.getTicketDetail(mappedB?.ticketId as never);
        assert.equal(detailB?.ticket.currentLaneKey, "done");
      }),
  );

  it.effect("WIP serialization: a second create into a WIP-1 lane already at capacity queues", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register("b-wip" as never, definition);
      const committer = yield* WorkflowSourceCommitter;
      const read = yield* WorkflowReadModel;

      const occupant = item({ externalId: "wip-1", title: "Occupant" });
      const queued = item({ externalId: "wip-2", title: "Queued" });
      // Both into the WIP-1 inbox lane via the committer (admission lock path).
      yield* committer.reconcileChunk("b-wip" as never, lanes, [
        { _tag: "new", item: occupant },
        { _tag: "new", item: queued },
      ]);

      const admitted = yield* read.countAdmittedInLane("b-wip" as never, "inbox" as never);
      assert.equal(admitted, 1);

      const queuedMapping = yield* readMapping("b-wip", queued);
      const queuedDetail = yield* read.getTicketDetail(queuedMapping?.ticketId as never);
      assert.equal(queuedDetail?.ticket.currentLaneKey, "inbox");
      assert.equal(queuedDetail?.ticket.queuedAt !== null, true);
    }),
  );

  it.effect(
    "post-tx pipeline start: a create into an auto lane starts the pipeline after the chunk",
    () =>
      Effect.gen(function* () {
        const registry = yield* BoardRegistry;
        yield* registry.register("b-pipeline" as never, definition);
        const committer = yield* WorkflowSourceCommitter;
        const sql = yield* SqlClient.SqlClient;

        // Destination = the auto `work` lane: createTicketAndEnterUnlocked drops the
        // pipeline start inside the chunk tx; recoverBoardWip (post-tx) starts it.
        const autoLanes: ReconcileLanes = {
          destinationLane: "work" as never,
          closedLane: "done" as never,
        };
        const ext = item({ externalId: "auto-1" });
        yield* committer.reconcileChunk("b-pipeline" as never, autoLanes, [
          { _tag: "new", item: ext },
        ]);

        const mapping = yield* readMapping("b-pipeline", ext);
        const runs = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_pipeline_run
        WHERE ticket_id = ${mapping?.ticketId as string}
      `;
        assert.isAbove(runs[0]?.count ?? 0, 0);
      }),
  );

  // Fix 4: a chunk whose destinationLane/closedLane does not exist on the
  // CURRENT board definition fails with a typed WorkflowEventStoreError and
  // creates/moves nothing.
  it.effect("validate lanes: a missing destination lane fails the chunk; nothing is created", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register("b-badlane" as never, definition);
      const committer = yield* WorkflowSourceCommitter;
      const sql = yield* SqlClient.SqlClient;

      const badLanes: ReconcileLanes = {
        destinationLane: "ghost" as never,
        closedLane: "done" as never,
      };
      const ext = item({ externalId: "bad-1" });
      const exit = yield* committer
        .reconcileChunk("b-badlane" as never, badLanes, [{ _tag: "new", item: ext }])
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(exit));

      assert.equal(yield* countMappings("b-badlane"), 0);
      const tickets = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_ticket WHERE board_id = 'b-badlane'
      `;
      assert.equal(tickets[0]?.count ?? 0, 0);
    }),
  );

  it.effect("validate lanes: a missing closed lane fails the chunk; nothing is created", () =>
    Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register("b-badclosed" as never, definition);
      const committer = yield* WorkflowSourceCommitter;
      const sql = yield* SqlClient.SqlClient;

      const badLanes: ReconcileLanes = {
        destinationLane: "inbox" as never,
        closedLane: "ghost" as never,
      };
      const ext = item({ externalId: "bad-2" });
      const exit = yield* committer
        .reconcileChunk("b-badclosed" as never, badLanes, [{ _tag: "new", item: ext }])
        .pipe(Effect.exit);
      assert.isTrue(Exit.isFailure(exit));

      assert.equal(yield* countMappings("b-badclosed"), 0);
      const tickets = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_ticket WHERE board_id = 'b-badclosed'
      `;
      assert.equal(tickets[0]?.count ?? 0, 0);
    }),
  );
});

// ---------------------------------------------------------------------------
// Fixes 2 (post-tx provider cancel), 3 (no orphan on UNIQUE), 6 (post-tx
// publish). Each uses a fresh layer so DeterministicWorkflowIds counters start
// clean (Fix 3 predicts the first ticket id) and a recording ProviderService /
// WorkflowBoardEvents captures the post-tx side effects.
// ---------------------------------------------------------------------------

interface ProviderCall {
  readonly kind: "interrupt" | "stop";
  readonly threadId: string;
}

// Decorates the real engine so recoverBoardWip FAILS post-commit — proves the
// committer's publish + provider-cancel still run and reconcileChunk does not
// fail. Requires the real engine under the same tag (provided via Layer.provide)
// and re-publishes it with only recoverBoardWip overridden to fail.
const failingRecoverEngineLayer = Layer.effect(
  WorkflowEngine,
  Effect.gen(function* () {
    const base = yield* WorkflowEngine;
    return {
      ...base,
      recoverBoardWip: () =>
        new WorkflowEventStoreError({ message: "boom: recoverBoardWip failed" }),
    } satisfies typeof base;
  }),
).pipe(Layer.provide(WorkflowEngineLayer));

const makeCommitterLayer = (
  providerCalls: Ref.Ref<ReadonlyArray<ProviderCall>>,
  published: Ref.Ref<ReadonlyArray<string>>,
  engineLayer: typeof WorkflowEngineLayer = WorkflowEngineLayer,
) =>
  WorkflowSourceCommitterLive.pipe(
    Layer.provideMerge(engineLayer),
    Layer.provideMerge(WorkflowEventCommitterLive),
    Layer.provideMerge(
      Layer.succeed(ScriptCancelRegistry, {
        register: () => Effect.void,
        unregister: () => Effect.void,
        cancel: () => Effect.void,
      }),
    ),
    Layer.provideMerge(blockingExecutor),
    Layer.provideMerge(
      Layer.succeed(ProviderService, {
        startSession: () => Effect.die("unused"),
        sendTurn: () => Effect.die("unused"),
        interruptTurn: (input) =>
          Ref.update(providerCalls, (calls) => [
            ...calls,
            { kind: "interrupt" as const, threadId: input.threadId as string },
          ]),
        respondToRequest: () => Effect.die("unused"),
        respondToUserInput: () => Effect.die("unused"),
        stopSession: (input) =>
          Ref.update(providerCalls, (calls) => [
            ...calls,
            { kind: "stop" as const, threadId: input.threadId as string },
          ]),
        listSessions: () => Effect.succeed([]),
        getCapabilities: () => Effect.die("unused"),
        getInstanceInfo: () => Effect.die("unused"),
        rollbackConversation: () => Effect.die("unused"),
        streamEvents: Stream.empty,
      } satisfies ProviderServiceShape),
    ),
    Layer.provideMerge(
      Layer.succeed(WorkflowBoardEvents, {
        publish: (ticket: BoardTicketView) =>
          Ref.update(published, (ids) => [...ids, ticket.ticketId as string]),
        stream: () => Stream.empty,
        subscribe: () => Effect.succeed(Stream.empty),
      }),
    ),
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

it.effect("Fix 2: a closed delta with running provider work cancels the session POST-commit", () =>
  Effect.gen(function* () {
    const providerCalls = yield* Ref.make<ReadonlyArray<ProviderCall>>([]);
    const published = yield* Ref.make<ReadonlyArray<string>>([]);
    yield* Effect.gen(function* () {
      const registry = yield* BoardRegistry;
      yield* registry.register("b-cancel" as never, definition);
      const committer = yield* WorkflowSourceCommitter;
      const sql = yield* SqlClient.SqlClient;

      const ext = item({ externalId: "cancel-1" });
      yield* committer.reconcileChunk("b-cancel" as never, lanes, [{ _tag: "new", item: ext }]);
      const created = yield* readMapping("b-cancel", ext);
      const ticketId = created?.ticketId as string;

      // Seed an in-flight provider dispatch row for the ticket. The in-tx close
      // tombstones it (DB), and the committer cancels the provider session
      // POST-tx using the snapshot captured before the tombstone.
      yield* sql`
        INSERT INTO workflow_dispatch_outbox (
          dispatch_id, ticket_id, step_run_id, thread_id, turn_id, provider_instance,
          model, instruction, worktree_path, status, created_at, started_at
        ) VALUES (
          'dispatch-cancel-1', ${ticketId}, 'step-cancel-1', 'thread-cancel-1',
          'turn-cancel-1', 'codex', 'gpt-5.5', 'cancel me', '/tmp/wt', 'started',
          '2026-06-13T00:00:00.000Z', '2026-06-13T00:00:00.000Z'
        )
      `;

      yield* committer.reconcileChunk("b-cancel" as never, lanes, [
        { _tag: "closed", item: ext, ticketId },
      ]);

      // The provider session was interrupted + stopped (post-commit).
      const calls = yield* Ref.get(providerCalls);
      assert.deepEqual(calls, [
        { kind: "interrupt", threadId: "thread-cancel-1" },
        { kind: "stop", threadId: "thread-cancel-1" },
      ]);

      // The dispatch row was tombstoned in-tx (no live pending/started rows).
      const live = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM workflow_dispatch_outbox
        WHERE ticket_id = ${ticketId} AND status IN ('pending', 'started')
      `;
      assert.equal(live[0]?.count ?? 0, 0);

      const detail = yield* (yield* WorkflowReadModel).getTicketDetail(ticketId as never);
      assert.equal(detail?.ticket.currentLaneKey, "done");
    }).pipe(Effect.provide(makeCommitterLayer(providerCalls, published)));
  }),
);

it.effect(
  "Fix 2: a later failing delta rolls back the close WITHOUT cancelling the provider mid-tx",
  () =>
    Effect.gen(function* () {
      const providerCalls = yield* Ref.make<ReadonlyArray<ProviderCall>>([]);
      const published = yield* Ref.make<ReadonlyArray<string>>([]);
      yield* Effect.gen(function* () {
        const registry = yield* BoardRegistry;
        yield* registry.register("b-rollback" as never, definition);
        const committer = yield* WorkflowSourceCommitter;
        const sql = yield* SqlClient.SqlClient;
        const read = yield* WorkflowReadModel;

        const closing = item({ externalId: "rollback-close" });
        yield* committer.reconcileChunk("b-rollback" as never, lanes, [
          { _tag: "new", item: closing },
        ]);
        const created = yield* readMapping("b-rollback", closing);
        const ticketId = created?.ticketId as string;

        yield* sql`
        INSERT INTO workflow_dispatch_outbox (
          dispatch_id, ticket_id, step_run_id, thread_id, turn_id, provider_instance,
          model, instruction, worktree_path, status, created_at, started_at
        ) VALUES (
          'dispatch-rollback-1', ${ticketId}, 'step-rollback-1', 'thread-rollback-1',
          'turn-rollback-1', 'codex', 'gpt-5.5', 'cancel me', '/tmp/wt', 'started',
          '2026-06-13T00:00:00.000Z', '2026-06-13T00:00:00.000Z'
        )
      `;

        // A LATER `new` delta whose ticket_id collides: pre-insert a mapping row
        // whose ticket_id equals the id the next created ticket WILL receive, so
        // its mapping INSERT hits the UNIQUE(ticket_id) index and fails the tx.
        // The re-read (by external key) misses, so the create proceeds to the
        // failing insert. This forces a chunk rollback AFTER the close applied
        // in-tx.
        const failing = item({ externalId: "rollback-new" });
        const nextTicketId = yield* sql<{ readonly value: string }>`
        SELECT 'ticket-' || (
          COALESCE(MAX(CAST(SUBSTR(ticket_id, 8) AS INTEGER)), 0) + 1
        ) AS value
        FROM projection_ticket WHERE ticket_id LIKE 'ticket-%'
      `.pipe(Effect.map((rows) => rows[0]?.value as string));
        yield* sql`
        INSERT INTO work_source_mapping (
          mapping_id, board_id, source_id, provider, external_id, ticket_id,
          content_hash, lifecycle, sync_status, source_metadata_json,
          created_at, last_synced_at
        ) VALUES (
          'mapping-collide', 'b-rollback', 'other-src', 'other-prov', 'other-ext',
          ${nextTicketId}, 'h', 'open', 'active', '{}',
          '2026-06-13T00:00:00.000Z', '2026-06-13T00:00:00.000Z'
        )
      `;

        const exit = yield* committer
          .reconcileChunk("b-rollback" as never, lanes, [
            { _tag: "closed", item: closing, ticketId },
            { _tag: "new", item: failing },
          ])
          .pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(exit));

        // The close's DB change rolled back: the ticket is NOT in `done`.
        const detail = yield* read.getTicketDetail(ticketId as never);
        assert.equal(detail?.ticket.currentLaneKey, "inbox");
        // The dispatch tombstone rolled back too.
        const live = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM workflow_dispatch_outbox
        WHERE ticket_id = ${ticketId} AND status IN ('pending', 'started')
      `;
        assert.equal(live[0]?.count ?? 0, 1);
        // Critically: the provider session was NOT cancelled, because the
        // cancellation only runs post-tx and the tx rolled back.
        assert.deepEqual(yield* Ref.get(providerCalls), []);
      }).pipe(Effect.provide(makeCommitterLayer(providerCalls, published)));
    }),
);

it.effect(
  "Fix 3: a UNIQUE violation on the mapping insert rolls back the chunk; no orphan ticket",
  () =>
    Effect.gen(function* () {
      const providerCalls = yield* Ref.make<ReadonlyArray<ProviderCall>>([]);
      const published = yield* Ref.make<ReadonlyArray<string>>([]);
      yield* Effect.gen(function* () {
        const registry = yield* BoardRegistry;
        yield* registry.register("b-orphan-guard" as never, definition);
        const committer = yield* WorkflowSourceCommitter;
        const sql = yield* SqlClient.SqlClient;

        // Pre-seed a mapping row whose ticket_id is the one the FIRST created
        // ticket will get (ticket-1 on this fresh, deterministic layer), under a
        // DIFFERENT external key so the in-tx re-read for our delta misses. The
        // create then collides on UNIQUE(ticket_id) — the violation must NOT be
        // swallowed, rolling back the just-created ticket.
        yield* sql`
        INSERT INTO work_source_mapping (
          mapping_id, board_id, source_id, provider, external_id, ticket_id,
          content_hash, lifecycle, sync_status, source_metadata_json,
          created_at, last_synced_at
        ) VALUES (
          'mapping-pre', 'b-orphan-guard', 'pre-src', 'pre-prov', 'pre-ext',
          'ticket-1', 'h', 'open', 'active', '{}',
          '2026-06-13T00:00:00.000Z', '2026-06-13T00:00:00.000Z'
        )
      `;

        const ext = item({ externalId: "orphan-guard-1" });
        const exit = yield* committer
          .reconcileChunk("b-orphan-guard" as never, lanes, [{ _tag: "new", item: ext }])
          .pipe(Effect.exit);
        assert.isTrue(Exit.isFailure(exit));

        // No orphan ticket survives: the only mapping is the pre-seeded one, and
        // no ticket exists for our delta's external key.
        assert.equal(yield* countMappings("b-orphan-guard"), 1);
        const tickets = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS count FROM projection_ticket WHERE board_id = 'b-orphan-guard'
      `;
        assert.equal(tickets[0]?.count ?? 0, 0);
        // Our delta's mapping was never created.
        assert.isNull(yield* readMapping("b-orphan-guard", ext));
      }).pipe(Effect.provide(makeCommitterLayer(providerCalls, published)));
    }),
);

it.effect(
  "Fix 6: created / changed / closed tickets are published to WorkflowBoardEvents post-tx",
  () =>
    Effect.gen(function* () {
      const providerCalls = yield* Ref.make<ReadonlyArray<ProviderCall>>([]);
      const published = yield* Ref.make<ReadonlyArray<string>>([]);
      yield* Effect.gen(function* () {
        const registry = yield* BoardRegistry;
        yield* registry.register("b-publish" as never, definition);
        const committer = yield* WorkflowSourceCommitter;

        // Create.
        const ext = item({ externalId: "publish-1" });
        yield* committer.reconcileChunk("b-publish" as never, lanes, [{ _tag: "new", item: ext }]);
        const created = yield* readMapping("b-publish", ext);
        const ticketId = created?.ticketId as string;
        assert.include(yield* Ref.get(published), ticketId);

        // Reset and exercise a change publish.
        yield* Ref.set(published, []);
        const changed = item({ externalId: "publish-1", contentHash: "hash-v2", title: "Renamed" });
        yield* committer.reconcileChunk("b-publish" as never, lanes, [
          { _tag: "changed", item: changed, ticketId },
        ]);
        assert.include(yield* Ref.get(published), ticketId);

        // Reset and exercise a close publish.
        yield* Ref.set(published, []);
        yield* committer.reconcileChunk("b-publish" as never, lanes, [
          { _tag: "closed", item: ext, ticketId },
        ]);
        assert.include(yield* Ref.get(published), ticketId);
      }).pipe(Effect.provide(makeCommitterLayer(providerCalls, published)));
    }),
);

it.effect(
  "post-commit ordering: a failing recoverBoardWip does NOT suppress publish + provider-cancel for a committed close",
  () =>
    Effect.gen(function* () {
      const providerCalls = yield* Ref.make<ReadonlyArray<ProviderCall>>([]);
      const published = yield* Ref.make<ReadonlyArray<string>>([]);
      yield* Effect.gen(function* () {
        const registry = yield* BoardRegistry;
        yield* registry.register("b-recover-fail" as never, definition);
        const committer = yield* WorkflowSourceCommitter;
        const sql = yield* SqlClient.SqlClient;
        const read = yield* WorkflowReadModel;

        const ext = item({ externalId: "recover-fail-1" });
        yield* committer.reconcileChunk("b-recover-fail" as never, lanes, [
          { _tag: "new", item: ext },
        ]);
        const created = yield* readMapping("b-recover-fail", ext);
        const ticketId = created?.ticketId as string;

        // In-flight provider work on the ticket.
        yield* sql`
          INSERT INTO workflow_dispatch_outbox (
            dispatch_id, ticket_id, step_run_id, thread_id, turn_id, provider_instance,
            model, instruction, worktree_path, status, created_at, started_at
          ) VALUES (
            'dispatch-recover-fail-1', ${ticketId}, 'step-recover-fail-1', 'thread-recover-fail-1',
            'turn-recover-fail-1', 'codex', 'gpt-5.5', 'cancel me', '/tmp/wt', 'started',
            '2026-06-13T00:00:00.000Z', '2026-06-13T00:00:00.000Z'
          )
        `;

        // The close commits; recoverBoardWip then FAILS post-commit. The
        // committer must still publish + cancel the provider session, and
        // reconcileChunk must NOT fail (recoverBoardWip is backstopped).
        yield* Ref.set(published, []);
        const exit = yield* committer
          .reconcileChunk("b-recover-fail" as never, lanes, [
            { _tag: "closed", item: ext, ticketId },
          ])
          .pipe(Effect.exit);
        assert.isTrue(Exit.isSuccess(exit));

        // Provider cancellation STILL ran (independent of recoverBoardWip).
        assert.deepEqual(yield* Ref.get(providerCalls), [
          { kind: "interrupt", threadId: "thread-recover-fail-1" },
          { kind: "stop", threadId: "thread-recover-fail-1" },
        ]);

        // The closed ticket's view was STILL published.
        assert.include(yield* Ref.get(published), ticketId);

        // The close itself durably landed (it committed before recovery failed).
        const detail = yield* read.getTicketDetail(ticketId as never);
        assert.equal(detail?.ticket.currentLaneKey, "done");
      }).pipe(
        Effect.provide(makeCommitterLayer(providerCalls, published, failingRecoverEngineLayer)),
      );
    }),
);
