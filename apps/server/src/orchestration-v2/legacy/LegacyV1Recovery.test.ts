// @effect-diagnostics nodeBuiltinImport:off -- Test fixtures use isolated native SQLite files.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import { EventId, ThreadId } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as TestConsole from "effect/testing/TestConsole";
import { Command } from "effect/unstable/cli";
import { threadsCommand } from "../../cli/threads.ts";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../../persistence/Migrations.ts";
import * as SqlitePersistence from "../../persistence/Layers/Sqlite.ts";
import * as EventStore from "../EventStore.ts";
import * as EventSink from "../EventSink.ts";
import * as ProjectionStore from "../ProjectionStore.ts";
import * as ProjectionMaintenance from "../ProjectionMaintenance.ts";
import * as LegacyImport from "./LegacyV1ThreadImporter.ts";
import * as Recovery from "./LegacyV1Recovery.ts";

const isRecoveryError = Schema.is(Recovery.LegacyV1RecoveryError);
const timestamp = "2026-01-01T00:00:00.000Z";
const later = "2026-02-01T00:00:00.000Z";
const withTarget = (target: string) => {
  const stores = Layer.mergeAll(EventStore.layer, ProjectionStore.layer).pipe(
    Layer.provideMerge(SqlitePersistence.makeSqlitePersistenceLive(target)),
  );
  const sink = EventSink.layer.pipe(Layer.provideMerge(stores));
  return Layer.mergeAll(
    sink,
    LegacyImport.layer.pipe(Layer.provide(sink)),
    ProjectionMaintenance.layer.pipe(Layer.provide(stores)),
  );
};

const fixture = Effect.fn(function* () {
  const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-recovery-test-"));
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => NodeFS.rmSync(directory, { recursive: true, force: true })),
  );
  const source = NodePath.join(directory, "state.sqlite");
  const target = NodePath.join(directory, "statev2.sqlite");
  const output = NodePath.join(directory, "recovered.sqlite");
  yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 54 });
    yield* sql`INSERT INTO projection_projects (project_id, title, workspace_root, scripts_json, created_at, updated_at)
      VALUES ('project', 'Project', '/tmp/project', '[]', ${timestamp}, ${timestamp})`;
    for (const id of ["shared", "diverged", "deleted", "edited", "pending"]) {
      yield* sql`INSERT INTO projection_threads (thread_id, project_id, title, model_selection_json,
        runtime_mode, interaction_mode, created_at, updated_at)
        VALUES (${id}, 'project', ${id}, '{"instanceId":"codex","model":"gpt-5.4"}',
        'full-access', 'default', ${timestamp}, ${timestamp})`;
      for (let index = 0; index < 4; index++) {
        yield* sql`INSERT INTO projection_thread_messages (message_id, thread_id, role, text,
          is_streaming, created_at, updated_at) VALUES (${`${id}-${index}`}, ${id},
          ${index % 2 ? "assistant" : "user"}, ${`old ${index}`}, 0,
          ${`2026-01-0${index + 1}T00:00:00.000Z`}, ${timestamp})`;
      }
    }
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: source })));
  yield* Effect.tryPromise(async () => {
    const db = new NodeSqlite.DatabaseSync(source, { readOnly: true });
    try {
      await NodeSqlite.backup(db, target);
    } finally {
      db.close();
    }
  });
  yield* Effect.gen(function* () {
    const importer = yield* LegacyImport.LegacyV1ThreadImporter;
    const sink = yield* EventSink.EventSinkV2;
    const projections = yield* ProjectionStore.ProjectionStoreV2;
    yield* importer.reconcileShells;
    for (const id of ["shared", "diverged", "deleted", "edited"])
      yield* importer.ensureTranscript(ThreadId.make(id));
    const shared = yield* projections.getThreadProjection(ThreadId.make("shared"));
    yield* sink.write({
      events: [
        {
          id: EventId.make("v2:settle"),
          type: "thread.metadata-updated",
          threadId: shared.thread.id,
          occurredAt: DateTime.makeUnsafe(later),
          payload: { ...shared.thread, title: "V2 title", settledOverride: "settled" },
        },
      ],
    });
    const diverged = yield* projections.getThreadProjection(ThreadId.make("diverged"));
    yield* sink.write({
      events: LegacyImport.messageEvents({
        message_id: "v2-message",
        thread_id: "diverged",
        role: "assistant",
        text: "V2 continuation",
        attachments_json: null,
        is_streaming: 0,
        created_at: later,
        updated_at: later,
        ordinal: 5,
      }).map((event) => ({ ...event, id: EventId.make(`native:${event.id}`) })),
    });
    const deleted = yield* projections.getThreadProjection(ThreadId.make("deleted"));
    yield* sink.write({
      events: [
        {
          id: EventId.make("v2:delete"),
          type: "thread.metadata-updated",
          threadId: deleted.thread.id,
          occurredAt: DateTime.makeUnsafe(later),
          payload: { ...deleted.thread, deletedAt: DateTime.makeUnsafe(later) },
        },
      ],
    });
    // A genuine V2-only thread must survive recovery, including its native transcript.
    yield* sink.write({
      events: [
        {
          id: EventId.make("native:create"),
          type: "thread.created",
          threadId: ThreadId.make("v2-only"),
          occurredAt: DateTime.makeUnsafe(later),
          payload: {
            ...diverged.thread,
            id: ThreadId.make("v2-only"),
            title: "V2 only",
            lineage: { ...diverged.thread.lineage, rootThreadId: ThreadId.make("v2-only") },
          },
        },
      ],
    });
  }).pipe(Effect.provide(withTarget(target)));
  const db = new NodeSqlite.DatabaseSync(source);
  try {
    db.prepare(
      "INSERT INTO projection_projects (project_id,title,workspace_root,scripts_json,created_at,updated_at) VALUES ('new-project','New project','/tmp/new-project','[]',?,?)",
    ).run(later, later);
    db.prepare(
      "INSERT INTO projection_threads (thread_id,project_id,title,model_selection_json,runtime_mode,interaction_mode,created_at,updated_at) VALUES ('new-thread','new-project','New thread','{\"instanceId\":\"codex\",\"model\":\"gpt-5.4\"}','full-access','default',?,?)",
    ).run(later, later);
    for (const id of ["shared", "diverged", "deleted", "new-thread"]) {
      db.prepare(
        "INSERT INTO projection_thread_messages (message_id,thread_id,role,text,is_streaming,created_at,updated_at) VALUES (?,?,'user','Stable continuation',0,?,?)",
      ).run(`${id}-new`, id, later, later);
    }
    db.prepare(
      "UPDATE projection_thread_messages SET text='Stable edited message' WHERE message_id='edited-1'",
    ).run();
    db.prepare(
      "INSERT INTO projection_thread_messages (message_id,thread_id,role,text,is_streaming,created_at,updated_at) VALUES ('reasoning','new-thread','reasoning','reasoning text',0,?,?)",
    ).run(later, later);
  } finally {
    db.close();
  }
  return { source, target, output, directory };
});

it.effect(
  "recovers both versions, preserves metadata, separates conflicts, hydrates pending imports and is idempotent",
  () =>
    Effect.gen(function* () {
      const files = yield* fixture();
      const recovery = yield* Recovery.LegacyV1Recovery;
      const sourceBytes = NodeFS.readFileSync(files.source);
      const targetBytes = NodeFS.readFileSync(files.target);
      const plan = yield* recovery.recover({ source: files.source, target: files.target });
      assert.equal(NodeFS.existsSync(files.output), false);
      assert.equal(plan.importedProjects, 1);
      assert.equal(plan.excludedReasoningMessages, 1);
      assert.deepEqual(plan.threads.map((row) => [row.sourceThreadId, row.action]).sort(), [
        ["deleted", "copy"],
        ["diverged", "copy"],
        ["edited", "copy"],
        ["new-thread", "import"],
        ["pending", "append"],
        ["shared", "append"],
      ]);
      yield* Command.runWith(threadsCommand, { version: "0.0.0" })([
        "recover-v1",
        "--source",
        files.source,
        "--target",
        files.target,
        "--output",
        files.output,
      ]).pipe(Effect.provide(TestConsole.layer));
      assert.deepEqual(NodeFS.readFileSync(files.source), sourceBytes);
      assert.deepEqual(NodeFS.readFileSync(files.target), targetBytes);
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const shared = yield* projections.getThreadProjection(ThreadId.make("shared"));
        assert.equal(shared.thread.title, "V2 title");
        assert.equal(shared.thread.settledOverride, "settled");
        assert.deepEqual(
          shared.messages.map((m) => m.text),
          ["old 0", "old 1", "old 2", "old 3", "Stable continuation"],
        );
        assert.equal(
          (yield* projections.getThreadProjection(ThreadId.make("pending"))).messages.length,
          4,
        );
        assert.equal(
          (yield* projections.getThreadProjection(ThreadId.make("diverged"))).messages.at(-1)?.text,
          "V2 continuation",
        );
        assert.equal(
          (yield* projections.getThreadProjection(ThreadId.make("v2-only"))).thread.title,
          "V2 only",
        );
        assert.isNotNull(
          (yield* projections.getThreadProjection(ThreadId.make("deleted"))).thread.deletedAt,
        );
        for (const copied of plan.threads.filter((row) => row.action === "copy")) {
          const recovered = yield* projections.getThreadProjection(
            ThreadId.make(copied.targetThreadId),
          );
          assert.include(recovered.thread.title, "recovered from Stable");
          assert.equal(recovered.messages.length, copied.messageCount);
        }
        assert.equal(
          (yield* sql<{ n: number }>`SELECT COUNT(*) AS n FROM orchestration_v2_effect_outbox`)[0]
            ?.n,
          0,
        );
        const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
        assert.equal((yield* maintenance.verify).valid, true);
        assert.equal((yield* maintenance.rebuild).valid, true);
        assert.equal(
          (yield* projections.getThreadProjection(ThreadId.make("shared"))).messages.length,
          5,
        );
      }).pipe(Effect.provide(withTarget(files.output)));
      const second = yield* recovery.recover({ source: files.source, target: files.output });
      assert.deepEqual(second.threads, []);
    }).pipe(
      Effect.provide(Recovery.layer.pipe(Layer.provideMerge(NodeServices.layer))),
      Effect.scoped,
    ),
);

it.effect(
  "recovers an earlier-dated Stable message without changing existing timeline positions",
  () =>
    Effect.gen(function* () {
      const files = yield* fixture();
      const db = new NodeSqlite.DatabaseSync(files.source);
      try {
        db.prepare(
          "INSERT INTO projection_thread_messages (message_id,thread_id,role,text,is_streaming,created_at,updated_at) VALUES ('interleaved','shared','user','Earlier Stable work',0,'2026-01-02T12:00:00.000Z',?)",
        ).run(later);
      } finally {
        db.close();
      }
      const sourceBytes = NodeFS.readFileSync(files.source);
      const targetBytes = NodeFS.readFileSync(files.target);
      yield* (yield* Recovery.LegacyV1Recovery).recover(files);
      assert.deepEqual(NodeFS.readFileSync(files.source), sourceBytes);
      assert.deepEqual(NodeFS.readFileSync(files.target), targetBytes);
      yield* Effect.gen(function* () {
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        const shared = yield* projections.getThreadProjection(ThreadId.make("shared"));
        assert.deepEqual(
          shared.messages.map((message) => message.text),
          ["old 0", "old 1", "old 2", "old 3", "Earlier Stable work", "Stable continuation"],
        );
        const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
        assert.equal((yield* maintenance.rebuild).valid, true);
        assert.deepEqual(
          (yield* projections.getThreadProjection(ThreadId.make("shared"))).messages.map(
            (message) => message.text,
          ),
          shared.messages.map((message) => message.text),
        );
      }).pipe(Effect.provide(withTarget(files.output)));
    }).pipe(
      Effect.provide(Recovery.layer.pipe(Layer.provideMerge(NodeServices.layer))),
      Effect.scoped,
    ),
);

it.effect("preserves V2 pinning, ordering and snoozing while appending Stable work", () =>
  Effect.gen(function* () {
    const files = yield* fixture();
    yield* Effect.gen(function* () {
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const shared = yield* projections.getThreadProjection(ThreadId.make("shared"));
      const payload = {
        ...shared.thread,
        pinnedAt: DateTime.makeUnsafe(later),
        pinOrderKey: "a0",
        activeOrderKey: "a1",
        snoozedUntil: DateTime.makeUnsafe("2026-04-01T00:00:00.000Z"),
      };
      const sink = yield* EventSink.EventSinkV2;
      for (const type of [
        "thread.pinned",
        "thread.pin-reordered",
        "thread.active-reordered",
        "thread.snoozed",
      ] as const) {
        yield* sink.write({
          events: [
            {
              id: EventId.make(`native:${type}`),
              type,
              threadId: shared.thread.id,
              occurredAt: DateTime.makeUnsafe(later),
              payload,
            },
          ],
        });
      }
    }).pipe(Effect.provide(withTarget(files.target)));
    const report = yield* (yield* Recovery.LegacyV1Recovery).recover(files);
    assert.equal(
      report.threads.find((thread) => thread.sourceThreadId === "shared")?.action,
      "append",
    );
    yield* Effect.gen(function* () {
      const shared = yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadProjection(
        ThreadId.make("shared"),
      );
      assert.equal(shared.messages.at(-1)?.text, "Stable continuation");
      assert.equal(shared.thread.pinOrderKey, "a0");
      assert.equal(shared.thread.activeOrderKey, "a1");
      assert.equal(DateTime.formatIso(shared.thread.pinnedAt!), later);
      assert.equal(DateTime.formatIso(shared.thread.snoozedUntil!), "2026-04-01T00:00:00.000Z");
    }).pipe(Effect.provide(withTarget(files.output)));
  }).pipe(
    Effect.provide(Recovery.layer.pipe(Layer.provideMerge(NodeServices.layer))),
    Effect.scoped,
  ),
);

it.effect(
  "refuses existing outputs and unsafe paths and leaves inputs unchanged on invalid attachments",
  () =>
    Effect.gen(function* () {
      const files = yield* fixture();
      const recovery = yield* Recovery.LegacyV1Recovery;
      const same = yield* recovery.recover({ ...files, output: files.target }).pipe(Effect.result);
      assert.equal(same._tag, "Failure");
      NodeFS.writeFileSync(files.output, "leave me alone");
      const exists = yield* recovery.recover(files).pipe(Effect.result);
      assert.equal(exists._tag, "Failure");
      assert.equal(NodeFS.readFileSync(files.output, "utf8"), "leave me alone");
      NodeFS.unlinkSync(files.output);
      const db = new NodeSqlite.DatabaseSync(files.source);
      db.prepare(
        "UPDATE projection_thread_messages SET attachments_json='[{\"broken\":true}]' WHERE message_id='new-thread-new'",
      ).run();
      db.close();
      const sourceBytes = NodeFS.readFileSync(files.source);
      const targetBytes = NodeFS.readFileSync(files.target);
      const invalid = yield* recovery.recover(files).pipe(Effect.result);
      assert.equal(invalid._tag, "Failure");
      if (invalid._tag === "Failure") assert.isTrue(isRecoveryError(invalid.failure));
      assert.equal(NodeFS.existsSync(files.output), false);
      assert.deepEqual(NodeFS.readFileSync(files.source), sourceBytes);
      assert.deepEqual(NodeFS.readFileSync(files.target), targetBytes);
    }).pipe(
      Effect.provide(Recovery.layer.pipe(Layer.provideMerge(NodeServices.layer))),
      Effect.scoped,
    ),
);

it.effect(
  "recovers later Stable additions after an earlier recovery without duplicating prior copies",
  () =>
    Effect.gen(function* () {
      const files = yield* fixture();
      const recovery = yield* Recovery.LegacyV1Recovery;
      const first = yield* recovery.recover(files);
      const db = new NodeSqlite.DatabaseSync(files.source);
      try {
        for (const id of ["shared", "new-thread", "diverged", "deleted", "edited"]) {
          db.prepare(
            "INSERT INTO projection_thread_messages (message_id,thread_id,role,text,is_streaming,created_at,updated_at) VALUES (?,?,'user','More Stable work',0,?,?)",
          ).run(`${id}-next`, id, "2026-03-01T00:00:00.000Z", "2026-03-01T00:00:00.000Z");
        }
      } finally {
        db.close();
      }
      const laterPlan = yield* recovery.recover({ source: files.source, target: files.output });
      assert.deepEqual(
        laterPlan.threads
          .map((thread) => [thread.sourceThreadId, thread.action, thread.messageCount])
          .sort(),
        [
          ["new-thread", "append", 1],
          ["shared", "append", 1],
          ["diverged", "append", 1],
          ["deleted", "append", 1],
          ["edited", "append", 1],
        ].sort(),
      );
      for (const copied of first.threads.filter((thread) => thread.action === "copy")) {
        assert.equal(
          laterPlan.threads.find((thread) => thread.sourceThreadId === copied.sourceThreadId)
            ?.targetThreadId,
          copied.targetThreadId,
        );
      }
      const nextOutput = NodePath.join(files.directory, "second.sqlite");
      yield* recovery.recover({ source: files.source, target: files.output, output: nextOutput });
      yield* Effect.gen(function* () {
        const projections = yield* ProjectionStore.ProjectionStoreV2;
        for (const thread of laterPlan.threads) {
          const recovered = yield* projections.getThreadProjection(
            ThreadId.make(thread.targetThreadId),
          );
          assert.equal(recovered.messages.at(-1)?.text, "More Stable work");
          assert.equal(
            recovered.messages.length,
            thread.sourceThreadId === "new-thread" ? 2 : thread.sourceThreadId === "edited" ? 5 : 6,
          );
        }
        assert.equal(
          (yield* (yield* ProjectionMaintenance.ProjectionMaintenanceV2).rebuild).valid,
          true,
        );
      }).pipe(Effect.provide(withTarget(nextOutput)));
      assert.deepEqual(
        (yield* recovery.recover({ source: files.source, target: nextOutput })).threads,
        [],
      );
      const edit = new NodeSqlite.DatabaseSync(files.source);
      try {
        edit
          .prepare(
            "UPDATE projection_thread_messages SET text='Edited Stable work' WHERE message_id='shared-new'",
          )
          .run();
      } finally {
        edit.close();
      }
      const conflictPlan = yield* recovery.recover({ source: files.source, target: files.output });
      assert.equal(
        conflictPlan.threads.find((thread) => thread.sourceThreadId === "shared")?.action,
        "copy",
      );
      yield* Effect.gen(function* () {
        const shared = yield* (yield* ProjectionStore.ProjectionStoreV2).getThreadProjection(
          ThreadId.make("shared"),
        );
        assert.equal(shared.messages.at(-1)?.text, "Stable continuation");
      }).pipe(Effect.provide(withTarget(files.output)));
    }).pipe(
      Effect.provide(Recovery.layer.pipe(Layer.provideMerge(NodeServices.layer))),
      Effect.scoped,
    ),
);
