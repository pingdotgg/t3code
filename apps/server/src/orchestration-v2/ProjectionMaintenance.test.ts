import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as NetService from "@t3tools/shared/Net";
import {
  CommandId,
  EventId,
  type OrchestrationV2AppThread,
  OrchestrationV2RunStatus,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Predicate from "effect/Predicate";
import * as Queue from "effect/Queue";
import * as EffectScheduler from "effect/Scheduler";
import * as Schema from "effect/Schema";
import * as TestClock from "effect/testing/TestClock";
import * as TestConsole from "effect/testing/TestConsole";
import * as Tracer from "effect/Tracer";
import { Command } from "effect/cli";
import * as SqlClient from "effect/sql/SqlClient";

import { cli } from "../binCli.ts";
import { layerFromPath, layerMemory } from "../persistence/Sqlite.ts";
import * as Scheduler from "../scheduling/Scheduler.ts";
import { ServerActivation } from "../serverActivation.ts";
import { PersistedServerRuntimeState } from "../serverRuntimeState.ts";
import * as CommandReceiptStore from "./CommandReceiptStore.ts";
import * as EventSink from "./EventSink.ts";
import * as EventStore from "./EventStore.ts";
import * as LegacyV1ThreadImporter from "./legacy/LegacyV1ThreadImporter.ts";
import * as ProjectionMaintenance from "./ProjectionMaintenance.ts";
import * as ProjectionStore from "./ProjectionStore.ts";

const isRunStatus = Schema.is(OrchestrationV2RunStatus);

const encodePersistedServerRuntimeState = Schema.encodeEffect(
  Schema.fromJsonString(PersistedServerRuntimeState),
);

const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
  Layer.provideMerge(layerMemory),
);
const sink = EventSink.layer.pipe(Layer.provide(stores));
const TestLayer = Layer.mergeAll(
  stores,
  sink,
  CommandReceiptStore.layer.pipe(Layer.provide(stores)),
  ProjectionMaintenance.layer.pipe(Layer.provide(stores)),
  LegacyV1ThreadImporter.layer.pipe(Layer.provide(Layer.merge(stores, sink))),
);

const seedThread = Effect.fnUntraced(function* (id: string) {
  const eventSink = yield* EventSink.EventSinkV2;
  const now = yield* DateTime.now;
  const thread: OrchestrationV2AppThread = {
    id: ThreadId.make(id),
    projectId: ProjectId.make(`project:${id}`),
    createdBy: "user",
    creationSource: "web",
    title: "Maintenance fixture",
    providerInstanceId: ProviderInstanceId.make("codex"),
    modelSelection: { instanceId: ProviderInstanceId.make("codex"), model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: ThreadId.make(id) },
    forkedFrom: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
  yield* eventSink.write({
    events: [
      {
        id: EventId.make(`${id}:created`),
        type: "thread.created",
        threadId: thread.id,
        occurredAt: now,
        payload: thread,
      },
      ...["old", "latest"].map((title) => ({
        id: EventId.make(`${id}:${title}`),
        type: "thread.metadata-updated" as const,
        threadId: thread.id,
        occurredAt: now,
        payload: { ...thread, title },
      })),
    ],
  });
  return thread;
});

const eventCount = Effect.fnUntraced(function* (threadId: ThreadId) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly count: number }>`
    SELECT COUNT(*) AS count FROM orchestration_events WHERE stream_id = ${threadId}
  `;
  return rows[0]!.count;
});

const withWorker = Effect.fnUntraced(function* () {
  const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
  yield* Layer.build(
    ProjectionMaintenance.workerLive.pipe(
      Layer.provide(Layer.succeed(ProjectionMaintenance.ProjectionMaintenanceV2, maintenance)),
      Layer.provide(Scheduler.layer),
    ),
  );
});

const captureSweeps = Effect.gen(function* () {
  const receipts = yield* Queue.unbounded<string>();
  const logger = Logger.make(({ message }) => {
    const text = String(message);
    if (
      text.includes("Projection maintenance completed") ||
      text.includes("Projection integrity verification failed") ||
      text.includes("Scheduler source failed")
    ) {
      Queue.offerUnsafe(receipts, text);
    }
  });
  return { receipts, layer: Logger.layer([logger], { mergeWithExisting: false }) };
});

it.effect("drops the whole imported V1 history and rebuilds the transcript from V2 events", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const importer = yield* LegacyV1ThreadImporter.LegacyV1ThreadImporter;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    const threadId = ThreadId.make("thread:maintenance-import");
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      INSERT INTO projection_threads (
        thread_id, project_id, title, model_selection_json, runtime_mode, interaction_mode,
        created_at, updated_at
      ) VALUES (${threadId}, 'project:maintenance-import', 'Imported thread',
        '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', 'default', ${now}, ${now})
    `;
    yield* sql`
      INSERT INTO projection_thread_messages (
        message_id, thread_id, role, text, attachments_json, is_streaming, created_at, updated_at
      ) VALUES ('message:maintenance-import', ${threadId}, 'user', 'Keep this transcript', '[]', 0, ${now}, ${now})
    `;
    yield* sql`
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type,
        occurred_at, actor_kind, payload_json, metadata_json, application_event_version
      ) VALUES ('event:maintenance-import:v1', 'thread', ${threadId}, 1,
        'thread.message-appended', ${now}, 'user', '{}', '{}', 1)
    `;
    assert.equal((yield* importer.reconcileShells).importedThreadCount, 1);
    yield* importer.ensureTranscript(threadId);
    const before = yield* projections.getThreadProjection(threadId);
    assert.equal(before.thread.historyOrigin, "v1_import");
    assert.equal(before.messages[0]?.text, "Keep this transcript");
    const verification = yield* maintenance.verify;
    assert.isTrue(verification.valid);

    // Exercise a legacy tail above the V2 projection cursor as well as imported history below it.
    yield* sql`
      INSERT INTO orchestration_events (
        event_id, aggregate_kind, stream_id, stream_version, event_type,
        occurred_at, actor_kind, payload_json, metadata_json, application_event_version
      ) SELECT 'event:maintenance-import:tail', 'thread', ${threadId}, MAX(stream_version) + 1,
        'thread.message-appended', ${now}, 'user', '{}', '{}', 1
      FROM orchestration_events WHERE stream_id = ${threadId}
    `;
    // Sequence is INTEGER PRIMARY KEY AUTOINCREMENT, so deleting the highest row does not
    // let SQLite hand its sequence out again. Compaction may therefore drop every imported
    // V1 row, including the one that used to be the table's MAX(sequence).
    assert.equal((yield* maintenance.compactEventStore).deletedEventCount, 2);
    assert.lengthOf(
      yield* sql`SELECT sequence FROM orchestration_events WHERE application_event_version = 1`,
      0,
    );
    assert.deepEqual(yield* maintenance.verify, verification);
    assert.isTrue((yield* maintenance.rebuild).valid);
    assert.deepEqual(yield* projections.getThreadProjection(threadId), before);

    const sink = yield* EventSink.EventSinkV2;
    yield* sink.write({
      events: [
        {
          id: EventId.make("event:maintenance-import:next"),
          type: "thread.visited",
          threadId,
          occurredAt: DateTime.makeUnsafe(now),
          payload: before.thread,
        },
      ],
    });
    yield* maintenance.compactEventStore;
    assert.lengthOf(
      yield* sql`SELECT sequence FROM orchestration_events WHERE application_event_version = 1`,
      0,
    );
    assert.isTrue((yield* maintenance.verify).valid);
    assert.isTrue((yield* maintenance.rebuild).valid);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("deduplicates a V2 command after compaction deletes its superseded event", () =>
  Effect.gen(function* () {
    const thread = yield* seedThread("thread:maintenance-receipt");
    const sink = yield* EventSink.EventSinkV2;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const receipts = yield* CommandReceiptStore.CommandReceiptStoreV2;
    const now = yield* DateTime.now;
    const commandId = CommandId.make("command:maintenance-receipt");
    const input = {
      commandId,
      threadId: thread.id,
      commandType: "thread.metadata.update",
      acceptedAt: now,
      events: [
        {
          id: EventId.make("event:maintenance-receipt"),
          type: "thread.metadata-updated" as const,
          threadId: thread.id,
          occurredAt: now,
          payload: { ...thread, title: "Receipt retained" },
        },
      ],
      effects: [],
    };
    const original = yield* sink.commitCommand(input);
    yield* sink.write({
      events: [
        {
          ...input.events[0]!,
          id: EventId.make("event:maintenance-receipt:superseding"),
          payload: { ...thread, title: "Superseding update" },
        },
      ],
    });
    yield* maintenance.compactEventStore;
    const sql = yield* SqlClient.SqlClient;
    assert.lengthOf(
      yield* sql`SELECT sequence FROM orchestration_events WHERE event_id = ${input.events[0]!.id}`,
      0,
    );
    const beforeRetry = yield* eventCount(thread.id);
    const replay = yield* sink.commitCommand(input);
    assert.deepEqual(replay.storedEvents, []);
    assert.equal(replay.receipt.resultSequence, original.receipt.resultSequence);
    assert.deepEqual(yield* receipts.getByCommandId(commandId), Option.some(original.receipt));
    assert.equal(yield* eventCount(thread.id), beforeRetry);
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    assert.equal(
      (yield* projections.getThreadProjection(thread.id)).thread.title,
      "Superseding update",
    );
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("verifies and repairs drift through the CLI and refuses a running server", () =>
  Effect.gen(function* () {
    const thread = yield* seedThread("thread:maintenance-cli");
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const testRoot = path.join(process.cwd(), ".t3");
    yield* fs.makeDirectory(testRoot, { recursive: true });
    const baseDir = yield* fs.makeTempDirectoryScoped({
      directory: testRoot,
      prefix: "projections-",
    });
    const stateDir = path.join(baseDir, "userdata");
    yield* fs.makeDirectory(stateDir);
    const dbPath = path.join(stateDir, "statev2.sqlite");
    const sql = yield* SqlClient.SqlClient;
    yield* sql`VACUUM INTO ${dbPath}`;
    const run = (action: "verify" | "rebuild") =>
      Command.runWith(cli, { version: "0.0.0" })([
        "projections",
        action,
        "--base-dir",
        baseDir,
      ]).pipe(
        // Each CLI process has its own stores, separate from the in-memory fixture.
        Effect.provideService(Layer.CurrentMemoMap, Layer.makeMemoMapUnsafe()),
      );
    const onDisk = layerFromPath(dbPath);
    yield* run("verify");
    yield* Effect.scoped(
      Effect.gen(function* () {
        const diskSql = yield* SqlClient.SqlClient;
        yield* diskSql`UPDATE orchestration_v2_projection_threads SET payload_json = '{}' WHERE thread_id = ${thread.id}`;
      }).pipe(Effect.provide(onDisk)),
    );
    const verifyFailure = yield* run("verify").pipe(Effect.flip);
    assert.isTrue(Predicate.isTagged("ProjectionVerificationFailedError")(verifyFailure));
    // The failure names the affected thread and the action that repairs it.
    assert.include(verifyFailure.message, thread.id);
    assert.include(verifyFailure.message, "t3 projections rebuild");
    yield* run("rebuild");
    yield* run("verify");
    const lines = (yield* TestConsole.logLines).filter(
      (line): line is string => typeof line === "string" && line.startsWith("{"),
    );
    assert.lengthOf(lines, 4);
    assert.include(String(lines[1]), '"valid": false');
    assert.include(String(lines[1]), thread.id);
    assert.include(String(lines[2]), '"valid": true');
    yield* Effect.scoped(
      Effect.gen(function* () {
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        assert.equal((yield* projections.getThreadProjection(thread.id)).thread.title, "latest");
      }).pipe(Effect.provide(Layer.fresh(ProjectionStore.layer.pipe(Layer.provide(onDisk))))),
    );
    yield* fs.writeFileString(
      path.join(stateDir, "server-runtime.json"),
      yield* encodePersistedServerRuntimeState({
        version: 1,
        pid: process.pid,
        port: 3773,
        origin: "http://localhost:3773",
        startedAt: DateTime.formatIso(yield* DateTime.now),
      }),
    );
    for (const action of ["verify", "rebuild"] as const) {
      assert.isTrue(
        Predicate.isTagged("ProjectionServerRunningError")(yield* run(action).pipe(Effect.flip)),
      );
    }
  }).pipe(
    Effect.provide([
      TestLayer,
      NodeServices.layer,
      NetService.layer,
      TestConsole.layer,
      ConfigProvider.layer(ConfigProvider.fromUnknown({})),
    ]),
  ),
);

it.effect("protects unfinished runs, effects, and runtime requests until they settle", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const thread = yield* seedThread("thread:maintenance-busy");
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      INSERT INTO orchestration_v2_legacy_imports
        (thread_id, source_updated_at, shell_imported_at, transcript_imported_at)
      VALUES (${thread.id}, ${now}, ${now}, ${now})
    `;
    yield* sql`
      INSERT INTO orchestration_command_receipts
        (command_id, aggregate_kind, aggregate_id, accepted_at, result_sequence, status, command_type)
      VALUES ('command:maintenance-busy:legacy', 'thread', ${thread.id}, ${now}, 1, 'accepted', 'legacy')
    `;
    yield* sql`
      INSERT INTO orchestration_v2_projection_runs
        (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
      VALUES ('run:maintenance-busy', ${thread.id}, 1, 'codex', 'queued', ${now}, '{}')
    `;
    // The last status is deliberately absent from OrchestrationV2RunStatus. Any status the
    // contract adds later must block compaction until this list names it, never permit deletion.
    assert.isFalse(isRunStatus("awaiting_input"));
    for (const status of [
      "preparing",
      "queued",
      "starting",
      "running",
      "waiting",
      "awaiting_input",
    ]) {
      yield* sql`UPDATE orchestration_v2_projection_runs SET status = ${status} WHERE thread_id = ${thread.id}`;
      const summary = yield* maintenance.compactEventStore;
      assert.equal(summary.deletedEventCount, 0);
      assert.equal(summary.deletedReceiptCount, 0);
    }
    yield* sql`UPDATE orchestration_v2_projection_runs SET status = 'completed' WHERE thread_id = ${thread.id}`;
    yield* sql`
      INSERT INTO orchestration_v2_effect_outbox
        (effect_id, command_id, thread_id, effect_type, payload_json, status, available_at, created_at, updated_at)
      VALUES ('effect:maintenance-busy', 'command:maintenance-busy', ${thread.id}, 'terminal.cleanup',
        '{}', 'pending', ${now}, ${now}, ${now})
    `;
    for (const status of ["pending", "running"]) {
      yield* sql`UPDATE orchestration_v2_effect_outbox SET status = ${status} WHERE thread_id = ${thread.id}`;
      const summary = yield* maintenance.compactEventStore;
      assert.equal(summary.deletedEventCount, 0);
      assert.equal(summary.deletedReceiptCount, 0);
    }
    yield* sql`UPDATE orchestration_v2_effect_outbox SET status = 'succeeded' WHERE thread_id = ${thread.id}`;
    yield* sql`
      INSERT INTO orchestration_v2_projection_runtime_requests
        (runtime_request_id, thread_id, node_id, kind, status, created_at, payload_json)
      VALUES ('request:maintenance-busy', ${thread.id}, 'node:maintenance-busy', 'approval', 'pending', ${now}, '{}')
    `;
    const protectedSummary = yield* maintenance.compactEventStore;
    assert.equal(protectedSummary.deletedEventCount, 0);
    assert.equal(protectedSummary.deletedReceiptCount, 0);
    assert.equal(yield* eventCount(thread.id), 3);
    yield* sql`UPDATE orchestration_v2_projection_runtime_requests SET status = 'resolved' WHERE thread_id = ${thread.id}`;
    const settledSummary = yield* maintenance.compactEventStore;
    assert.equal(settledSummary.deletedEventCount, 1);
    assert.equal(settledSummary.deletedReceiptCount, 1);
    assert.equal(yield* eventCount(thread.id), 2);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect(
  "parks maintenance until server activation, then runs hourly instead of on every tick",
  () =>
    Effect.gen(function* () {
      const thread = yield* seedThread("thread:maintenance-schedule");
      const { receipts, layer } = yield* captureSweeps;
      const activation = yield* Deferred.make<void>();
      yield* Effect.gen(function* () {
        yield* withWorker();
        yield* TestClock.adjust("10 seconds");
        assert.equal(yield* eventCount(thread.id), 3);
        yield* Deferred.succeed(activation, undefined);
        assert.include(yield* Queue.take(receipts), "Projection maintenance completed");
        assert.equal(yield* eventCount(thread.id), 2);
        const sink = yield* EventSink.EventSinkV2;
        const now = yield* DateTime.now;
        yield* sink.write({
          events: ["next-old", "next-latest"].map((title) => ({
            id: EventId.make(`${thread.id}:${title}`),
            type: "thread.metadata-updated" as const,
            threadId: thread.id,
            occurredAt: now,
            payload: { ...thread, title },
          })),
        });
        yield* TestClock.adjust("3595 seconds");
        assert.equal(yield* eventCount(thread.id), 4);
        yield* TestClock.adjust("5 seconds");
        assert.include(yield* Queue.take(receipts), "Projection maintenance completed");
        assert.equal(yield* eventCount(thread.id), 2);
      }).pipe(
        Effect.provide(layer),
        Effect.provideService(ServerActivation, Deferred.await(activation)),
      );
    }).pipe(Effect.provide(TestLayer)),
);

it.effect("rechecks unfinished work after compaction discovery yields", () =>
  Effect.gen(function* () {
    const thread = yield* seedThread("thread:maintenance-start-race");
    const sql = yield* SqlClient.SqlClient;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const discovered = yield* Deferred.make<void>();
    const tracer = Tracer.make({
      span(options) {
        const span = new Tracer.NativeSpan(options);
        const end = span.end.bind(span);
        span.end = (endTime, exit) => {
          end(endTime, exit);
          const query = span.attributes.get("db.query.text");
          // Coupled to the `event` alias in compactEventStore's discovery query. Renaming that
          // alias would leave this matcher dead: the test would still pass while racing nothing.
          if (typeof query === "string" && query.includes("FROM orchestration_events AS event")) {
            Deferred.doneUnsafe(discovered, Effect.void);
          }
        };
        return span;
      },
    });
    const startedWork = yield* Effect.gen(function* () {
      yield* Deferred.await(discovered);
      const now = DateTime.formatIso(yield* DateTime.now);
      yield* sql`
        INSERT INTO orchestration_v2_projection_runs
          (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
        VALUES ('run:maintenance-start-race', ${thread.id}, 1, 'codex', 'queued', ${now}, '{}')
      `;
    }).pipe(Effect.forkScoped);
    const summary = yield* maintenance.compactEventStore.pipe(
      Effect.withTracer(tracer),
      Effect.provideService(EffectScheduler.MaxOpsBeforeYield, Number.POSITIVE_INFINITY),
    );
    yield* Fiber.join(startedWork);
    assert.equal(summary.deletedEventCount, 0);
    assert.equal(yield* eventCount(thread.id), 3);
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("unregisters maintenance when its scope closes", () =>
  Effect.gen(function* () {
    const thread = yield* seedThread("thread:maintenance-lifetime");
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const { receipts, layer } = yield* captureSweeps;
    yield* Effect.gen(function* () {
      yield* Effect.scoped(
        Layer.build(
          ProjectionMaintenance.workerLive.pipe(
            Layer.provide(
              Layer.succeed(ProjectionMaintenance.ProjectionMaintenanceV2, maintenance),
            ),
          ),
        ).pipe(Effect.andThen(Queue.take(receipts))),
      );
      assert.equal(yield* eventCount(thread.id), 2);
      const sink = yield* EventSink.EventSinkV2;
      const now = yield* DateTime.now;
      yield* sink.write({
        events: [
          {
            id: EventId.make("event:maintenance-lifetime:next"),
            type: "thread.visited",
            threadId: thread.id,
            occurredAt: now,
            payload: thread,
          },
        ],
      });
      yield* TestClock.adjust("1 hour");
      assert.equal(yield* eventCount(thread.id), 3);
    }).pipe(Effect.provide(Layer.merge(Scheduler.layer, layer)));
  }).pipe(Effect.provide(TestLayer)),
);

it.effect(
  "reports drift without compacting or rebuilding and resumes after an explicit repair",
  () =>
    Effect.gen(function* () {
      const thread = yield* seedThread("thread:maintenance-drift");
      const sql = yield* SqlClient.SqlClient;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = '{}' WHERE thread_id = ${thread.id}`;
      const { receipts, layer } = yield* captureSweeps;
      yield* Effect.gen(function* () {
        yield* withWorker();
        assert.include(yield* Queue.take(receipts), "Projection integrity verification failed");
        assert.equal(yield* eventCount(thread.id), 3);
        assert.deepEqual((yield* maintenance.verify).unreadableThreadIds, [thread.id]);
        assert.isTrue((yield* maintenance.rebuild).valid);
        yield* TestClock.adjust("1 day");
        // The daily slot re-verifies, passes on the repaired projection, and compacts. The hourly
        // slots in between compact without verifying, so only the last receipt proves the repair.
        const day = yield* Queue.takeAll(receipts);
        assert.include(day.at(-1)!, "Projection maintenance completed");
        assert.equal(yield* eventCount(thread.id), 2);
      }).pipe(Effect.provide(layer));
    }).pipe(Effect.provide(TestLayer)),
);

it.effect("compacts within an hour after each repeated invalid verification", () =>
  Effect.gen(function* () {
    const thread = yield* seedThread("thread:maintenance-persistent-drift");
    const sql = yield* SqlClient.SqlClient;
    const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
    const sink = yield* EventSink.EventSinkV2;
    yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = '{}' WHERE thread_id = ${thread.id}`;
    const { receipts, layer } = yield* captureSweeps;
    yield* Effect.gen(function* () {
      yield* withWorker();
      assert.include(yield* Queue.take(receipts), "Projection integrity verification failed");
      assert.equal(yield* eventCount(thread.id), 3);
      yield* TestClock.adjust("3595 seconds");
      assert.equal(yield* Queue.size(receipts), 0);
      assert.equal(yield* eventCount(thread.id), 3);
      yield* TestClock.adjust("5 seconds");
      assert.include(yield* Queue.take(receipts), "Projection maintenance completed");
      assert.equal(yield* eventCount(thread.id), 2);
      assert.isFalse((yield* maintenance.verify).valid);

      // A second daily failure must not stop the following hourly compaction either.
      yield* TestClock.adjust("23 hours");
      const daily = yield* Queue.takeAll(receipts);
      assert.include(daily.at(-1)!, "Projection integrity verification failed");
      assert.lengthOf(
        daily.filter((line) => line.includes("Projection integrity verification failed")),
        1,
      );
      const now = yield* DateTime.now;
      yield* sink.write({
        events: [
          {
            id: EventId.make(`${thread.id}:next`),
            type: "thread.visited",
            threadId: thread.id,
            occurredAt: now,
            payload: thread,
          },
        ],
      });
      // EventSink repairs this projection while writing, so restore persistent drift.
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = '{}' WHERE thread_id = ${thread.id}`;
      assert.equal(yield* eventCount(thread.id), 3);
      yield* TestClock.adjust("1 hour");
      assert.include(yield* Queue.take(receipts), "Projection maintenance completed");
      assert.equal(yield* eventCount(thread.id), 2);
      assert.isFalse((yield* maintenance.verify).valid);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("keeps compaction hourly while verification runs daily", () =>
  Effect.gen(function* () {
    const thread = yield* seedThread("thread:maintenance-verify-cadence");
    const sql = yield* SqlClient.SqlClient;
    const { receipts, layer } = yield* captureSweeps;
    yield* Effect.gen(function* () {
      yield* withWorker();
      assert.include(yield* Queue.take(receipts), "Projection maintenance completed");
      assert.equal(yield* eventCount(thread.id), 2);
      yield* sql`UPDATE orchestration_v2_projection_threads SET payload_json = '{}' WHERE thread_id = ${thread.id}`;
      // Every hourly slot up to a day later compacts without re-verifying, so the drift is
      // not noticed yet.
      yield* TestClock.adjust("23 hours");
      const hourly = yield* Queue.takeAll(receipts);
      assert.isAbove(hourly.length, 20);
      assert.isTrue(hourly.every((line) => line.includes("Projection maintenance completed")));
      // The slot one day after the first sweep verifies, reports the drift, and skips compaction.
      yield* TestClock.adjust("1 hour");
      const daily = yield* Queue.takeAll(receipts);
      assert.lengthOf(
        daily.filter((line) => line.includes("Projection integrity verification failed")),
        1,
      );
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(TestLayer)),
);

it.effect("logs a database failure and retries on the next daily verification", () =>
  Effect.gen(function* () {
    const thread = yield* seedThread("thread:maintenance-error");
    const sql = yield* SqlClient.SqlClient;
    yield* sql`DROP INDEX orchestration_events_v2_created_threads_idx`;
    const { receipts, layer } = yield* captureSweeps;
    yield* Effect.gen(function* () {
      yield* withWorker();
      assert.include(yield* Queue.take(receipts), "Scheduler source failed");
      assert.equal(yield* eventCount(thread.id), 3);
      yield* sql`
        CREATE INDEX orchestration_events_v2_created_threads_idx ON orchestration_events(stream_id)
        WHERE application_event_version = 2 AND aggregate_kind = 'thread' AND event_type = 'thread.created'
      `;
      yield* TestClock.adjust("1 day");
      assert.include(yield* Queue.take(receipts), "Projection maintenance completed");
      assert.equal(yield* eventCount(thread.id), 2);
    }).pipe(Effect.provide(layer));
  }).pipe(Effect.provide(TestLayer)),
);
