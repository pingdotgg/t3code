import { assert, it } from "@effect/vitest";
import {
  EventId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type ModelSelection,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import * as Statement from "effect/sql/Statement";
import * as Tracer from "effect/Tracer";
import * as TestClock from "effect/testing/TestClock";
import * as NodeServices from "@effect/platform-node/NodeServices";

import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const modelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
} satisfies ModelSelection;
const providerInstanceId = modelSelection.instanceId;
const projectId = ProjectId.make("project:lockwait");

/**
 * A fixed timestamp for the writer's row.
 *
 * The read does not care when the row was written, and a fixed epoch keeps the
 * test free of wall-clock reads.
 */
const FIXED_EPOCH = "2026-01-01T00:00:00.000Z";

/** How long a blocked read is given before it is called blocked. */
const BLOCKED_TIMEOUT = "3 seconds";

/**
 * Print a measurement to the test output.
 *
 * `Effect.log` on its own is swallowed by the test runner, and the effect
 * language service rejects `console.log` inside Effect code. The measurement is
 * the point of the test, so it has to be readable in the output.
 */
const printMeasurement = (message: string) =>
  Effect.sync(() => {
    // @effect-diagnostics-next-line globalConsoleInEffect:off - the measurement is the test's output, and the test runner captures the console.
    console.log(message);
  });

/**
 * The scope the writer's row is written under.
 *
 * The writer's transaction is open while the read runs, so its row is
 * uncommitted and invisible to the reader. That is how the test knows the
 * write was still in flight when the read ran.
 */
const HELD_WRITE_SCOPE = "lockwait-held-write";

/**
 * A writer that HOLDS the write lock while the read runs.
 *
 * This is the case that matters: the writer's transaction is open, so the
 * write lock is held, and a read on the writer connection has to wait for it.
 * A read on the reader connection does not, because the reader is a separate
 * connection with its own lock and WAL lets it read the last committed
 * snapshot.
 *
 * The lock is HELD, not merely held for a while. A writer that streams
 * inserts and finishes leaves a window in which the read happens after the
 * writes are done, and the test would then be measuring a read with no write
 * load in it - which is the mistake this shape exists to avoid.
 */
const withWriteLockHeld = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
): Effect.Effect<
  { readonly value: A; readonly heldForMs: number; readonly uncommittedRows: number },
  E | SqlError,
  R | SqlClient.SqlClient
> =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const lockHeld = yield* Deferred.make<void>();
    const release = yield* Deferred.make<void>();
    const writer = yield* sql
      .withTransaction(
        Effect.gen(function* () {
          // A real write, with the table's own columns. A row that does not
          // insert is not write load. The id is fixed because the database is
          // created for this test alone, so it is unique in it.
          yield* sql`INSERT INTO orchestration_v2_projection_checkpoints (
            checkpoint_id, thread_id, scope_id, run_id, node_id, ordinal_within_scope,
            status, captured_at, payload_json
          ) VALUES (
            ${"lockwait-checkpoint"}, ${"lockwait-thread"}, ${HELD_WRITE_SCOPE}, ${"run"}, ${"node"},
            1, 'captured', ${FIXED_EPOCH}, '{}'
          )`;
          yield* Deferred.succeed(lockHeld, undefined);
          yield* Deferred.await(release);
        }),
      )
      .pipe(
        // If the write fails, the lock is never held and the read would be
        // measuring nothing. Release the reader instead of leaving it to time
        // out, and let the writer's own exit report the failure below.
        Effect.tapError(() => Deferred.succeed(lockHeld, undefined)),
        Effect.forkChild({ startImmediately: true }),
      );
    yield* Deferred.await(lockHeld);
    // The write lock is held from here until the effect finishes.
    const started = yield* Clock.currentTimeMillis;
    const value = yield* effect;
    const heldForMs = (yield* Clock.currentTimeMillis) - started;
    // The writer's row is still uncommitted, so the reader cannot see it. That
    // is the proof that the write was in flight for the whole read - the
    // elapsed time cannot show it, because the clock has 1 ms resolution.
    const uncommittedRows = yield* sql<{ readonly count: number }>`
      SELECT COUNT(*) AS count
      FROM orchestration_v2_projection_checkpoints
      WHERE scope_id = ${HELD_WRITE_SCOPE}
    `.pipe(NodeSqliteClient.readOnly);
    yield* Deferred.succeed(release, undefined);
    // Joining the writer propagates its failure, so a row that did not insert
    // fails the test rather than passing as write load.
    yield* Fiber.join(writer);
    return { value, heldForMs, uncommittedRows: uncommittedRows[0]?.count ?? -1 };
  });

const createThread = (threadId: ThreadId) =>
  Effect.gen(function* () {
    const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
    const now = yield* DateTime.now;
    yield* projectionStore.apply({
      id: EventId.make(`event:${threadId}:created`),
      type: "thread.created",
      threadId,
      occurredAt: now,
      payload: {
        createdBy: "user",
        creationSource: "web",
        id: threadId,
        projectId,
        title: threadId,
        providerInstanceId,
        modelSelection,
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        activeProviderThreadId: null,
        lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
        forkedFrom: null,
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        lastVisitedAt: null,
        deletedAt: null,
      } as never,
    });
  });

/**
 * The read, while a writer holds the write lock.
 *
 * This is the case that was measured in the field: a busy host whose writer is
 * behind, and MCP reads that have to wait for the write lock.
 */
const measureReadUnderWriteLock = Effect.fn("measureReadUnderWriteLock")(function* (
  threadId: ThreadId,
) {
  const projectionStore = yield* ProjectionStore.ProjectionStoreV2;
  const acquired: Array<{ readonly connection: string; readonly lockWaitMs: number }> = [];
  const tracer = Tracer.make({
    span: (spanOptions) => {
      const span = new Tracer.NativeSpan(spanOptions);
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        end(endTime, exit);
        const connection = span.attributes.get("db.connection");
        if (typeof connection === "string") {
          acquired.push({
            connection,
            lockWaitMs: Number(span.attributes.get("db.lock_wait_ms") ?? 0),
          });
        }
      };
      return span;
    },
  });

  const measured = yield* withWriteLockHeld(
    projectionStore
      .getThreadRecords(threadId, ["runs"])
      .pipe(
        Effect.provideService(Statement.SpanPropagationEnabled, true),
        Effect.withTracer(tracer),
      ),
  );

  return {
    acquired,
    heldForMs: measured.heldForMs,
    uncommittedRows: measured.uncommittedRows,
    value: measured.value,
  };
});

/**
 * The same read, but on the writer connection.
 *
 * This is the "before": the read that ran on the writer, where it had to wait
 * for the write lock the writer was holding. It is the store's own first read,
 * on the connection the change moves it off.
 */
const measureReadOnWriterConnection = Effect.fn("measureReadOnWriterConnection")(function* (
  threadId: ThreadId,
) {
  const sql = yield* SqlClient.SqlClient;
  const acquired: Array<{ readonly connection: string; readonly lockWaitMs: number }> = [];
  const tracer = Tracer.make({
    span: (spanOptions) => {
      const span = new Tracer.NativeSpan(spanOptions);
      const end = span.end.bind(span);
      span.end = (endTime, exit) => {
        end(endTime, exit);
        const connection = span.attributes.get("db.connection");
        if (typeof connection === "string") {
          acquired.push({
            connection,
            lockWaitMs: Number(span.attributes.get("db.lock_wait_ms") ?? 0),
          });
        }
      };
      return span;
    },
  });

  // The read is bounded, because on the writer connection it cannot finish
  // while the writer holds the lock: that is the point, and the bound is what
  // lets the test say so instead of hanging.
  const measured = yield* withWriteLockHeld(
    sql
      .withTransaction(
        sql<{ readonly payload_json: string }>`
          SELECT payload_json
          FROM orchestration_v2_projection_threads
          WHERE thread_id = ${threadId}
          LIMIT 1
        `,
      )
      .pipe(
        Effect.provideService(Statement.SpanPropagationEnabled, true),
        Effect.withTracer(tracer),
        Effect.timeout(BLOCKED_TIMEOUT),
        Effect.exit,
      ),
  );

  return { acquired, heldForMs: measured.heldForMs, value: measured.value };
});

it.effect("the projection read completes while a writer holds the write lock", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-lockwait-" });
    const database = SqlitePersistence.layerFromPath(path.join(home, "statev2.sqlite"));
    const storeLayer = Layer.mergeAll(
      ProjectionStore.layer.pipe(Layer.provideMerge(database)),
      database,
    ).pipe(Layer.provideMerge(NodeServices.layer));

    const threadId = ThreadId.make("thread:lockwait:reader");
    const { acquired, heldForMs, uncommittedRows } = yield* Effect.gen(function* () {
      yield* createThread(threadId);
      return yield* measureReadUnderWriteLock(threadId);
    }).pipe(Effect.provide(storeLayer), TestClock.withLive);

    // The read ran on the reader connection, and it ran to completion while
    // the writer was holding the write lock. That is the whole point: the
    // reader has its own connection and its own lock.
    assert.deepEqual(
      acquired.map((entry) => entry.connection),
      ["reader"],
    );
    assert.equal(acquired.length, 1);
    // The lock wait is reported, so the before/after can be compared on the
    // same measure the server logs.
    assert.isAtLeast(acquired[0]?.lockWaitMs ?? -1, 0);
    // The write lock was held for the whole read. That is true by
    // construction - the writer holds its transaction until the read has
    // finished - and the elapsed time does not prove it, because the clock has
    // 1 ms resolution and a fast read can finish inside the same
    // millisecond. What proves it is that the writer's row was still
    // uncommitted, and so invisible to the reader, when the read finished.
    assert.isAtLeast(heldForMs, 0);
    assert.equal(uncommittedRows, 0);
    yield* printMeasurement(
      `MEASURE read-on-reader: connection=${acquired[0]?.connection} lock_wait_ms=${acquired[0]?.lockWaitMs} lock_held_for_ms=${heldForMs} uncommitted_rows_visible=${uncommittedRows}`,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("the same read on the writer connection is blocked by the write lock", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const home = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-lockwait-writer-" });
    const database = SqlitePersistence.layerFromPath(path.join(home, "statev2.sqlite"));
    const storeLayer = Layer.mergeAll(
      ProjectionStore.layer.pipe(Layer.provideMerge(database)),
      database,
    ).pipe(Layer.provideMerge(NodeServices.layer));

    const threadId = ThreadId.make("thread:lockwait:writer");
    const { acquired, heldForMs, value } = yield* Effect.gen(function* () {
      yield* createThread(threadId);
      return yield* measureReadOnWriterConnection(threadId);
    }).pipe(Effect.provide(storeLayer), TestClock.withLive);

    // It did not complete, and the failure is the TIMEOUT and not some other
    // SQL error: the read could not even ACQUIRE the connection, because the
    // writer held the write lock, so there is no `db.connection` span to
    // report - the acquisition never finished. That is the "before" the
    // change fixes.
    const exit = value as Exit.Exit<unknown, unknown>;
    assert.equal(exit._tag, "Failure");
    // A read that failed for some other reason would not have waited for the
    // bound, so the failure has to BE the timeout.
    const error = Exit.isFailure(exit)
      ? Cause.findErrorOption(exit.cause).pipe(Option.getOrElse(() => undefined))
      : undefined;
    assert.isTrue(Cause.isTimeoutError(error), "expected a timeout, got " + String(error));
    // It waited for the bound, with the lock held the whole time.
    assert.isAtLeast(heldForMs, 2_000);
    assert.deepEqual(acquired, []);
    yield* printMeasurement(
      `MEASURE read-on-writer: outcome=TimeoutError lock_held_for_ms=${heldForMs} connections_acquired=${acquired.length}`,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
