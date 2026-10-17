// @effect-diagnostics nodeBuiltinImport:off
/**
 * Phase 0 G4 probe (disposable experiment, not feature implementation).
 *
 * Simulates the storage decisions in PLANNING.md §5.2 without building the
 * feature: authoritative Civilization-style rows in the host SQLite database,
 * no foreign keys into disposable host projection rows, a per-citizen
 * watermark of the last applied host lifecycle sequence, and a feature-owned
 * schema ledger that never touches `effect_sql_migrations`.
 *
 * What this file proves:
 * - a core projection rebuild preserves feature rows and watermarks;
 * - lifecycle replay/catch-up is idempotent through the watermark, closes an
 *   epoch at most once per transition, and never rerolls identity;
 * - feature state appends no application events (no new event discriminants);
 * - cascading or restrictive foreign keys into rebuilt projections lose or
 *   block feature state, which is why the chosen shape has none;
 * - missing/corrupt feature state fails closed instead of silently rebuilding;
 * - a consistent snapshot restore keeps host and feature state together, and
 *   a reopen cannot replay pre-snapshot transitions.
 *
 * Limits (recorded in experiments/phase-0/E01-g4-recovery.md): same-transaction
 * composition with host commits is G3 work; client capability negotiation and
 * admin surfaces are Phase 1. Promote or delete after the Phase 0 review.
 */

import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EventId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "../persistence/Migrations.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.4",
} satisfies ModelSelection;

function makeThread(threadId: ThreadId, now: DateTime.Utc): OrchestrationV2AppThread {
  return {
    createdBy: "user",
    creationSource: "web",
    id: threadId,
    projectId: ProjectId.make(`project:${threadId}`),
    title: `Thread ${threadId}`,
    providerInstanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: threadId,
    },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

function threadCreatedEvent(input: {
  readonly id: string;
  readonly thread: OrchestrationV2AppThread;
  readonly now: DateTime.Utc;
}): OrchestrationV2DomainEvent {
  return {
    id: EventId.make(input.id),
    type: "thread.created",
    threadId: input.thread.id,
    providerInstanceId,
    occurredAt: input.now,
    payload: input.thread,
  };
}

type LifecycleEventType =
  | "thread.settled"
  | "thread.unsettled"
  | "thread.archived"
  | "thread.unarchived"
  | "thread.deleted";

function threadLifecycleEvent(input: {
  readonly id: string;
  readonly type: LifecycleEventType;
  readonly thread: OrchestrationV2AppThread;
  readonly now: DateTime.Utc;
}): OrchestrationV2DomainEvent {
  const base = { ...input.thread, updatedAt: input.now };
  const payload: OrchestrationV2AppThread =
    input.type === "thread.settled"
      ? { ...base, settledOverride: "settled", settledAt: input.now }
      : input.type === "thread.unsettled"
        ? { ...base, settledOverride: null, settledAt: null, unsettledAt: input.now }
        : input.type === "thread.archived"
          ? { ...base, archivedAt: input.now }
          : input.type === "thread.unarchived"
            ? { ...base, archivedAt: null }
            : { ...base, deletedAt: input.now };
  return {
    id: EventId.make(input.id),
    type: input.type,
    threadId: input.thread.id,
    providerInstanceId,
    occurredAt: input.now,
    payload,
  };
}

// The probe's copy of the future feature schema. A real feature would create
// these from its own versioned initializer; `CREATE TABLE IF NOT EXISTS` keeps
// the probe idempotent. `thread_id` is deliberately a plain column: no foreign
// key into `orchestration_v2_projection_threads`, which the core rebuild
// deletes and repopulates.
const ensureProbeSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`CREATE TABLE IF NOT EXISTS civilization_probe_schema (
    version INTEGER NOT NULL,
    created_at TEXT NOT NULL
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS civilization_probe_citizens (
    thread_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    birth_sequence INTEGER NOT NULL,
    last_applied_sequence INTEGER NOT NULL,
    epoch INTEGER NOT NULL DEFAULT 0,
    closed_at TEXT
  )`;
  yield* sql`CREATE TABLE IF NOT EXISTS civilization_probe_draws (
    thread_id TEXT PRIMARY KEY,
    draw_count INTEGER NOT NULL
  )`;
  yield* sql`INSERT INTO civilization_probe_schema (version, created_at)
    SELECT 1, 'phase-0' WHERE NOT EXISTS (SELECT 1 FROM civilization_probe_schema)`;
});

const enrollCitizen = (threadId: ThreadId, name: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const eventStore = yield* EventStore.EventStoreV2;
    // Enrollment snapshots the current host sequence: history before the
    // citizen existed is never replayed onto it.
    const birthSequence = yield* eventStore.latestSequence();
    yield* sql.withTransaction(
      Effect.gen(function* () {
        yield* sql`INSERT INTO civilization_probe_draws (thread_id, draw_count)
          VALUES (${threadId}, 1)`;
        yield* sql`INSERT INTO civilization_probe_citizens (
          thread_id, name, birth_sequence, last_applied_sequence, epoch, closed_at
        ) VALUES (${threadId}, ${name}, ${birthSequence}, ${birthSequence}, 0, NULL)`;
      }),
    );
  });

const probeStatus = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const tables = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'table'
      AND name IN (
        'civilization_probe_schema',
        'civilization_probe_citizens',
        'civilization_probe_draws'
      )
  `;
  if (tables.length < 3) return "unavailable";
  const versions = yield* sql<{ readonly version: number }>`
    SELECT version FROM civilization_probe_schema LIMIT 1
  `;
  if (versions.length !== 1 || versions[0]?.version !== 1) return "unavailable";
  const corrupt = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count FROM civilization_probe_citizens
    WHERE name IS NULL OR TRIM(name) = '' OR last_applied_sequence IS NULL
  `;
  if ((corrupt[0]?.count ?? 0) > 0) return "unavailable";
  return "active";
});

const CLOSING_LIFECYCLE_EVENTS = new Set<LifecycleEventType>([
  "thread.settled",
  "thread.archived",
  "thread.deleted",
]);

/**
 * Applies host lifecycle transitions newer than the citizen's watermark in one
 * transaction and advances the watermark only where it moves the transition.
 * The guarded `UPDATE ... WHERE last_applied_sequence < sequence` is the
 * idempotence mechanism a rebuild or restart relies on.
 */
const runLifecycleCatchUp = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    if ((yield* probeStatus) === "unavailable") return { applied: 0, status: "unavailable" };
    const applied = yield* sql.withTransaction(
      Effect.gen(function* () {
        const watermarks = yield* sql<{ readonly last_applied_sequence: number }>`
          SELECT last_applied_sequence FROM civilization_probe_citizens
          WHERE thread_id = ${threadId}
        `;
        const watermark = watermarks[0]?.last_applied_sequence;
        if (watermark === undefined) return 0;
        const transitions = yield* sql<{
          readonly sequence: number;
          readonly event_type: string;
          readonly occurred_at: string;
        }>`
          SELECT sequence, event_type, occurred_at
          FROM orchestration_events
          WHERE application_event_version = 2
            AND aggregate_kind = 'thread'
            AND stream_id = ${threadId}
            AND sequence > ${watermark}
            AND event_type IN (
              'thread.settled',
              'thread.unsettled',
              'thread.archived',
              'thread.unarchived',
              'thread.deleted'
            )
          ORDER BY sequence ASC
        `;
        let count = 0;
        for (const transition of transitions) {
          const closes = CLOSING_LIFECYCLE_EVENTS.has(transition.event_type as LifecycleEventType);
          const changed = yield* sql<{ readonly thread_id: string }>`
            UPDATE civilization_probe_citizens
            SET last_applied_sequence = ${transition.sequence},
                epoch = epoch + ${closes ? 1 : 0},
                closed_at = CASE
                  WHEN ${closes ? 1 : 0} = 1 THEN COALESCE(closed_at, ${transition.occurred_at})
                  ELSE closed_at
                END
            WHERE thread_id = ${threadId}
              AND last_applied_sequence < ${transition.sequence}
            RETURNING thread_id
          `;
          count += changed.length;
        }
        return count;
      }),
    );
    return { applied, status: "active" as const };
  });

type CitizenRow = {
  readonly thread_id: string;
  readonly name: string;
  readonly birth_sequence: number;
  readonly last_applied_sequence: number;
  readonly epoch: number;
  readonly closed_at: string | null;
};

const readCitizens = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<CitizenRow>`
    SELECT thread_id, name, birth_sequence, last_applied_sequence, epoch, closed_at
    FROM civilization_probe_citizens
    ORDER BY thread_id ASC
  `;
  return [...rows];
});

const readDraws = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly thread_id: string; readonly draw_count: number }>`
    SELECT thread_id, draw_count FROM civilization_probe_draws ORDER BY thread_id ASC
  `;
  return [...rows];
});

const makeProbeLayer = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>) => {
  const eventStoreProvided = EventStore.layer.pipe(Layer.provideMerge(database));
  const projectionStoreProvided = ProjectionStore.layer.pipe(Layer.provideMerge(database));
  const stores = Layer.mergeAll(database, eventStoreProvided, projectionStoreProvided);
  return Layer.mergeAll(
    stores,
    EventSink.layer.pipe(Layer.provide(stores)),
    ProjectionMaintenance.layer.pipe(Layer.provide(stores)),
  );
};

const layerMemory = makeProbeLayer(SqlitePersistence.layerMemory);

const makeFileLayer = (dbPath: string) =>
  makeProbeLayer(SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer)));

it.effect("preserves feature-owned rows and watermarks through a core projection rebuild", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const eventStore = yield* EventStore.EventStoreV2;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:g4:preserve");
    const thread = makeThread(threadId, now);

    yield* sink.write({
      events: [threadCreatedEvent({ id: "event:g4:preserve:created", thread, now })],
    });
    yield* ensureProbeSchema;
    yield* enrollCitizen(threadId, "Ada");
    const sequenceBeforeFeatureWork = yield* eventStore.latestSequence();

    yield* sink.write({
      events: [
        threadLifecycleEvent({
          id: "event:g4:preserve:settled",
          type: "thread.settled",
          thread,
          now,
        }),
      ],
    });
    const applied = yield* runLifecycleCatchUp(threadId);
    assert.equal(applied.applied, 1);
    assert.equal(
      yield* eventStore.latestSequence(),
      sequenceBeforeFeatureWork + 1,
      "feature writes append no application events",
    );

    const sequenceBeforeRebuild = yield* eventStore.latestSequence();
    const citizensBefore = yield* readCitizens;
    const drawsBefore = yield* readDraws;
    assert.equal(citizensBefore[0]?.epoch, 1);
    assert.isNotNull(citizensBefore[0]?.closed_at);

    assert.isTrue((yield* maintenance.verify).valid);
    assert.isTrue((yield* maintenance.rebuild).valid);

    assert.deepEqual(yield* readCitizens, citizensBefore, "rebuild rerolled or dropped citizens");
    assert.deepEqual(yield* readDraws, drawsBefore, "rebuild redrew names");
    assert.equal(
      yield* eventStore.latestSequence(),
      sequenceBeforeRebuild,
      "rebuild or feature state appended application events",
    );
    // Restart-shaped catch-up: nothing newer than the watermark can apply.
    assert.equal((yield* runLifecycleCatchUp(threadId)).applied, 0);
    assert.deepEqual(yield* readCitizens, citizensBefore);
  }).pipe(Effect.provide(Layer.fresh(layerMemory))),
);

it.effect("closes each lifecycle transition once across settle, return, rebuild and delete", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:g4:idempotent");
    const thread = makeThread(threadId, now);
    const transition = (id: string, type: LifecycleEventType) =>
      threadLifecycleEvent({ id, type, thread, now });

    yield* sink.write({
      events: [threadCreatedEvent({ id: "event:g4:idempotent:created", thread, now })],
    });
    yield* ensureProbeSchema;
    yield* enrollCitizen(threadId, "Bram");

    yield* sink.write({ events: [transition("event:g4:idempotent:settled-1", "thread.settled")] });
    assert.equal((yield* runLifecycleCatchUp(threadId)).applied, 1);
    let citizen = (yield* readCitizens)[0];
    assert.equal(citizen?.epoch, 1);
    assert.isNotNull(citizen?.closed_at);

    // Return keeps identity and cannot reopen the closed epoch.
    yield* sink.write({
      events: [transition("event:g4:idempotent:unsettled", "thread.unsettled")],
    });
    assert.equal((yield* runLifecycleCatchUp(threadId)).applied, 1);
    citizen = (yield* readCitizens)[0];
    assert.equal(citizen?.epoch, 1, "return must not reopen the closed epoch");
    assert.isNotNull(citizen?.closed_at);

    // A later settlement closes the new epoch.
    yield* sink.write({ events: [transition("event:g4:idempotent:settled-2", "thread.settled")] });
    assert.equal((yield* runLifecycleCatchUp(threadId)).applied, 1);
    citizen = (yield* readCitizens)[0];
    assert.equal(citizen?.epoch, 2);

    // A rebuild in between must not make any of it apply twice.
    const beforeRebuild = yield* readCitizens;
    assert.isTrue((yield* maintenance.rebuild).valid);
    assert.equal((yield* runLifecycleCatchUp(threadId)).applied, 0);
    assert.deepEqual(yield* readCitizens, beforeRebuild);

    yield* sink.write({ events: [transition("event:g4:idempotent:archived", "thread.archived")] });
    assert.equal((yield* runLifecycleCatchUp(threadId)).applied, 1);
    assert.equal((yield* readCitizens)[0]?.epoch, 3);
    yield* sink.write({ events: [transition("event:g4:idempotent:deleted", "thread.deleted")] });
    assert.equal((yield* runLifecycleCatchUp(threadId)).applied, 1);
    assert.equal((yield* readCitizens)[0]?.epoch, 4);

    assert.isTrue((yield* maintenance.rebuild).valid);
    assert.equal((yield* runLifecycleCatchUp(threadId)).applied, 0);
    assert.equal((yield* readCitizens)[0]?.epoch, 4, "rebuild and replay must not double-close");
  }).pipe(Effect.provide(Layer.fresh(layerMemory))),
);

it.effect("a cascading foreign key into rebuilt projections silently deletes feature rows", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:g4:cascade");
    const thread = makeThread(threadId, now);

    yield* sink.write({
      events: [threadCreatedEvent({ id: "event:g4:cascade:created", thread, now })],
    });
    yield* ensureProbeSchema;
    yield* enrollCitizen(threadId, "Cora");
    const foreignKeys = yield* sql<{ readonly foreign_keys: number }>`PRAGMA foreign_keys`;
    assert.equal(foreignKeys[0]?.foreign_keys, 1, "probe needs FK enforcement to be meaningful");

    yield* sql`CREATE TABLE civilization_probe_cascade (
      thread_id TEXT PRIMARY KEY
        REFERENCES orchestration_v2_projection_threads(thread_id) ON DELETE CASCADE,
      payload TEXT NOT NULL
    )`;
    yield* sql`INSERT INTO civilization_probe_cascade (thread_id, payload)
      VALUES (${threadId}, 'feature data')`;

    assert.isTrue((yield* maintenance.rebuild).valid);
    const cascaded = yield* sql<{ readonly thread_id: string }>`
      SELECT thread_id FROM civilization_probe_cascade
    `;
    assert.equal(cascaded.length, 0, "the rebuild must not have resurrected cascaded rows");
    // The FK-free citizen row survived the same rebuild, and membership still
    // resolves through an authoritative join instead of a constraint.
    assert.deepEqual(
      (yield* readCitizens).map((row) => row.thread_id),
      [threadId],
    );
    const membership = yield* sql<{
      readonly thread_id: string;
      readonly deleted_at: string | null;
    }>`
      SELECT citizen.thread_id, host.deleted_at
      FROM civilization_probe_citizens AS citizen
      LEFT JOIN orchestration_v2_projection_threads AS host
        ON host.thread_id = citizen.thread_id
    `;
    assert.deepEqual([...membership], [{ thread_id: threadId, deleted_at: null }]);
  }).pipe(Effect.provide(Layer.fresh(layerMemory))),
);

it.effect("a restrictive foreign key into rebuilt projections blocks the rebuild", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:g4:restrict");
    const thread = makeThread(threadId, now);

    yield* sink.write({
      events: [threadCreatedEvent({ id: "event:g4:restrict:created", thread, now })],
    });
    yield* ensureProbeSchema;
    yield* enrollCitizen(threadId, "Dara");
    yield* sql`CREATE TABLE civilization_probe_fk_restrict (
      thread_id TEXT PRIMARY KEY REFERENCES orchestration_v2_projection_threads(thread_id),
      payload TEXT NOT NULL
    )`;
    yield* sql`INSERT INTO civilization_probe_fk_restrict (thread_id, payload)
      VALUES (${threadId}, 'feature data')`;

    const exit = yield* Effect.exit(maintenance.rebuild);
    assert.isTrue(Exit.isFailure(exit), "a restrictive FK must make the rebuild fail loudly");
    // The failed rebuild transaction rolled back; host and feature state stay usable.
    assert.isTrue((yield* maintenance.verify).valid);
    assert.deepEqual(
      (yield* readCitizens).map((row) => row.thread_id),
      [threadId],
    );

    // The shipped shape has no such constraint; recovery then works and keeps
    // the feature rows.
    yield* sql`DROP TABLE civilization_probe_fk_restrict`;
    assert.isTrue((yield* maintenance.rebuild).valid);
    assert.deepEqual(
      (yield* readCitizens).map((row) => row.thread_id),
      [threadId],
    );
  }).pipe(Effect.provide(Layer.fresh(layerMemory))),
);

it.effect("fails closed and rerolls nothing when feature state is missing or corrupt", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:g4:fail-closed");
    const thread = makeThread(threadId, now);

    yield* sink.write({
      events: [threadCreatedEvent({ id: "event:g4:fail-closed:created", thread, now })],
    });
    yield* ensureProbeSchema;
    yield* enrollCitizen(threadId, "Eve");
    const healthy = yield* readCitizens;
    const draws = yield* readDraws;
    assert.equal(yield* probeStatus, "active");

    // Missing tables: the feature reports unavailable and refuses to guess.
    yield* sql`DROP TABLE civilization_probe_citizens`;
    assert.equal(yield* probeStatus, "unavailable");
    assert.equal((yield* runLifecycleCatchUp(threadId)).applied, 0);
    const missingRows = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count FROM civilization_probe_draws
    `;
    assert.equal(missingRows[0]?.count, draws.length, "unavailable state must not write");
    assert.isTrue((yield* maintenance.verify).valid);
    assert.isTrue((yield* maintenance.rebuild).valid);
    assert.equal((yield* runLifecycleCatchUp(threadId)).applied, 0);

    // Explicit re-initialization is a new empty generation, never a silent
    // reconstruction of the lost identities.
    yield* ensureProbeSchema;
    assert.equal(yield* probeStatus, "active");
    const afterRegeneration = yield* readCitizens;
    assert.equal(afterRegeneration.length, 0, "lost names must not be resynthesized");
    assert.deepEqual(yield* readDraws, draws, "regeneration must not redraw or rewrite");

    // Corrupt identity row: decode refuses instead of treating it as a fresh
    // citizen that needs a new draw.
    const secondThreadId = ThreadId.make("thread:g4:fail-closed-two");
    yield* enrollCitizen(secondThreadId, "Faythe");
    yield* sql`UPDATE civilization_probe_citizens SET name = ''
      WHERE thread_id = ${secondThreadId}`;
    assert.equal(yield* probeStatus, "unavailable");
    assert.equal((yield* runLifecycleCatchUp(secondThreadId)).applied, 0);
    const corruptRow = yield* sql<{ readonly name: string | null }>`
      SELECT name FROM civilization_probe_citizens WHERE thread_id = ${secondThreadId}
    `;
    assert.equal(corruptRow[0]?.name, "", "corrupt state must not be rewritten or redrawn");
    assert.equal(healthy[0]?.name, "Eve");
  }).pipe(Effect.provide(Layer.fresh(layerMemory))),
);

it.effect("restores host and feature state together from a snapshot and keeps watermarks", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-civ-g4-restore-"));
  const dbPath = NodePath.join(tempDir, "state.sqlite");
  const snapshotPath = NodePath.join(tempDir, "snapshot.sqlite");
  const restoredPath = NodePath.join(tempDir, "restored.sqlite");

  const t1 = ThreadId.make("thread:g4:snapshot:one");
  const t2 = ThreadId.make("thread:g4:snapshot:two");

  return Effect.gen(function* () {
    let snapshotSequence = 0;
    let snapshotCitizens: ReadonlyArray<CitizenRow> = [];

    // Phase A: original database accumulates state, snapshots, then writes past it.
    yield* Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const eventStore = yield* EventStore.EventStoreV2;
      const sql = yield* SqlClient.SqlClient;
      const now = yield* DateTime.now;
      const thread1 = makeThread(t1, now);
      const thread2 = makeThread(t2, now);
      yield* sink.write({
        events: [
          threadCreatedEvent({ id: "event:g4:snapshot:created-one", thread: thread1, now }),
          threadCreatedEvent({ id: "event:g4:snapshot:created-two", thread: thread2, now }),
        ],
      });
      yield* ensureProbeSchema;
      yield* enrollCitizen(t1, "Ada");
      yield* enrollCitizen(t2, "Bram");
      yield* sink.write({
        events: [
          threadLifecycleEvent({
            id: "event:g4:snapshot:settle-one",
            type: "thread.settled",
            thread: thread1,
            now,
          }),
        ],
      });
      assert.equal((yield* runLifecycleCatchUp(t1)).applied, 1);

      snapshotSequence = yield* eventStore.latestSequence();
      snapshotCitizens = yield* readCitizens;
      yield* sql`VACUUM INTO ${snapshotPath}`;
      // Copy immediately: the snapshot file is closed and clean at this point.
      NodeFS.copyFileSync(snapshotPath, restoredPath);

      // Post-snapshot work that a crash without a checkpoint would lose.
      yield* sink.write({
        events: [
          threadLifecycleEvent({
            id: "event:g4:snapshot:settle-two",
            type: "thread.settled",
            thread: thread2,
            now,
          }),
        ],
      });
      assert.equal((yield* runLifecycleCatchUp(t2)).applied, 1);
      assert.isAbove(yield* eventStore.latestSequence(), snapshotSequence);
    }).pipe(Effect.provide(makeFileLayer(dbPath)));

    // Phase B: reopen the original; post-snapshot state persisted across close.
    yield* Effect.gen(function* () {
      const eventStore = yield* EventStore.EventStoreV2;
      assert.isAbove(yield* eventStore.latestSequence(), snapshotSequence);
      const citizens = yield* readCitizens;
      assert.equal(citizens.find((row) => row.thread_id === t2)?.epoch, 1);
    }).pipe(Effect.provide(makeFileLayer(dbPath)));

    // Phase C: the snapshot holds exactly the pre-crash state, nothing rerolled.
    yield* Effect.gen(function* () {
      const eventStore = yield* EventStore.EventStoreV2;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      assert.equal(yield* eventStore.latestSequence(), snapshotSequence);
      assert.deepEqual(yield* readCitizens, snapshotCitizens);
      assert.isTrue((yield* maintenance.verify).valid);
      assert.isTrue((yield* maintenance.rebuild).valid);
      assert.equal((yield* runLifecycleCatchUp(t1)).applied, 0);
      assert.equal((yield* runLifecycleCatchUp(t2)).applied, 0);
      assert.deepEqual(yield* readCitizens, snapshotCitizens);
    }).pipe(Effect.provide(makeFileLayer(snapshotPath)));

    // Phase D: restore from the copy; only post-restore transitions apply, once.
    yield* Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const now = yield* DateTime.now;
      const thread2 = makeThread(t2, now);
      assert.equal((yield* runLifecycleCatchUp(t2)).applied, 0);
      assert.equal((yield* readCitizens).find((row) => row.thread_id === t2)?.epoch, 0);
      yield* sink.write({
        events: [
          threadLifecycleEvent({
            id: "event:g4:snapshot:post-restore-settle-two",
            type: "thread.settled",
            thread: thread2,
            now,
          }),
        ],
      });
      assert.equal((yield* runLifecycleCatchUp(t2)).applied, 1);
      assert.isTrue((yield* maintenance.rebuild).valid);
      assert.equal((yield* runLifecycleCatchUp(t2)).applied, 0);
      const restored = yield* readCitizens;
      assert.equal(restored.find((row) => row.thread_id === t2)?.epoch, 1);
      assert.deepEqual(
        restored.map((row) => row.name),
        snapshotCitizens.map((row) => row.name),
      );
    }).pipe(Effect.provide(makeFileLayer(restoredPath)));
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

it.effect("compacts superseded host events without disturbing feature state", () =>
  Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    const threadId = ThreadId.make("thread:g4:compaction");
    const thread = makeThread(threadId, now);
    const transition = (id: string, type: LifecycleEventType) =>
      threadLifecycleEvent({ id, type, thread, now });

    yield* sink.write({
      events: [threadCreatedEvent({ id: "event:g4:compaction:created", thread, now })],
    });
    yield* ensureProbeSchema;
    yield* enrollCitizen(threadId, "Hale");
    yield* sink.write({ events: [transition("event:g4:compaction:settled-1", "thread.settled")] });
    assert.equal((yield* runLifecycleCatchUp(threadId)).applied, 1);
    yield* sink.write({
      events: [transition("event:g4:compaction:unsettled", "thread.unsettled")],
    });
    assert.equal((yield* runLifecycleCatchUp(threadId)).applied, 1);
    yield* sink.write({ events: [transition("event:g4:compaction:settled-2", "thread.settled")] });
    assert.equal((yield* runLifecycleCatchUp(threadId)).applied, 1);

    const beforeCompaction = yield* readCitizens;
    assert.equal(beforeCompaction[0]?.epoch, 2);
    const summary = yield* maintenance.compactEventStore;
    assert.isAtLeast(summary.deletedEventCount, 2);

    const deletedStillPresent = yield* sql<{ readonly event_id: string }>`
      SELECT event_id FROM orchestration_events
      WHERE event_id IN (
        'event:g4:compaction:settled-1',
        'event:g4:compaction:unsettled'
      )
    `;
    assert.equal(deletedStillPresent.length, 0, "compaction should have removed superseded state");

    // The watermark already covered the deleted transitions, so nothing needs
    // them: compaction changes neither feature rows nor catch-up behavior.
    assert.deepEqual(yield* readCitizens, beforeCompaction);
    assert.equal((yield* runLifecycleCatchUp(threadId)).applied, 0);
    assert.isTrue((yield* maintenance.rebuild).valid);
    assert.equal((yield* runLifecycleCatchUp(threadId)).applied, 0);
  }).pipe(Effect.provide(Layer.fresh(layerMemory))),
);

it.effect("keeps feature schema out of the host migration ledger", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const readLedger = Effect.gen(function* () {
      const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
        SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id ASC
      `;
      return rows.map((row) => [row.migration_id, row.name] as const);
    });

    assert.deepStrictEqual(yield* readLedger, [...migrationManifest]);
    yield* ensureProbeSchema;
    yield* enrollCitizen(ThreadId.make("thread:g4:ledger"), "Gale");

    // The feature schema never enters the host ledger, so an upstream restart
    // runs its own migrator untouched and ignores the feature tables.
    assert.deepStrictEqual(yield* readLedger, [...migrationManifest]);
    assert.deepStrictEqual(yield* runMigrations(), []);
    const integrity = yield* sql<{ readonly integrity_check: string }>`PRAGMA integrity_check`;
    assert.equal(integrity[0]?.integrity_check, "ok");
    assert.deepEqual(
      (yield* readCitizens).map((row) => row.thread_id),
      ["thread:g4:ledger"],
    );
  }).pipe(Effect.provide(Layer.fresh(layerMemory))),
);
