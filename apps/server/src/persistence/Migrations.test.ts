import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import { migrationManifest, runMigrations } from "./Migrations.ts";
import ProjectLoomTimeIndexes from "./Migrations/075_ProjectLoomTimeIndexes.ts";
import ProjectLoomBoundedReads from "./Migrations/077_ProjectLoomBoundedReads.ts";

const v2Migrations = migrationManifest.filter(([id]) => id >= 55);
const newerMigrationId = Math.max(...migrationManifest.map(([id]) => id)) + 1;
const consolidatedMigration = [80, "ProjectIntelligenceAndCrossEnvironment"] as const;
const messageDeliveryMigration = [81, "ProjectKnowledgeMessageDeliveries"] as const;
const activeTurnItemMigration = [82, "ActiveTurnItemIndexes"] as const;
const attachmentPlaceholderMigration = [83, "ExcludeAttachmentPlaceholdersFromSearch"] as const;
const subagentDeliveryMigration = [84, "SubagentDeliveryState"] as const;
const projectPinArchiveMigration = [85, "ProjectionProjectsPinArchive"] as const;
const settledOverrideMigration = [86, "RepairBooleanSettledOverride"] as const;
const correlationIndexMigration = [87, "DropOrchestrationEventCorrelationIndex"] as const;
const modelEvaluationMigration = [88, "ModelEvaluations"] as const;
const delegatedRecoveryMigration = [89, "DelegatedRecoveryIndexes"] as const;
const scheduledTaskThreadModeMigration = [90, "ScheduledTaskThreadMode"] as const;
const dropProjectLoomIndexesMigration = [91, "DropProjectLoomIndexes"] as const;
const savedLifecycleMigration = [92, "ProjectKnowledgeSavedLifecycle"] as const;

it.effect("upgrades attempt receipts atomically and preserves distinct steering messages", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 80 });
    yield* seedDelivery;
    yield* sql`CREATE VIEW project_knowledge_deliveries_project_cursor AS SELECT 1`;
    const before = yield* sql`SELECT * FROM project_knowledge_deliveries`;
    const schema = yield* sql`SELECT name, sql FROM sqlite_master ORDER BY name`;
    assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
    assert.deepStrictEqual(yield* sql`SELECT * FROM project_knowledge_deliveries`, before);
    assert.deepStrictEqual(yield* sql`SELECT name, sql FROM sqlite_master ORDER BY name`, schema);

    yield* sql`DROP VIEW project_knowledge_deliveries_project_cursor`;
    assert.deepStrictEqual(yield* runMigrations(), [
      messageDeliveryMigration,
      activeTurnItemMigration,
      attachmentPlaceholderMigration,
      subagentDeliveryMigration,
      projectPinArchiveMigration,
      settledOverrideMigration,
      correlationIndexMigration,
      modelEvaluationMigration,
      delegatedRecoveryMigration,
      scheduledTaskThreadModeMigration,
      dropProjectLoomIndexesMigration,
      savedLifecycleMigration,
    ]);
    assert.deepStrictEqual(yield* sql`SELECT * FROM project_knowledge_deliveries`, before);
    yield* sql`INSERT INTO project_knowledge_deliveries (
      attempt_id, run_id, thread_id, message_id, project_id, provider_instance_id,
      status, items_json, omissions_json, created_at, updated_at
    ) SELECT attempt_id, run_id, thread_id, 'followup', project_id, provider_instance_id,
      'prepared', '[]', '[]', created_at, updated_at FROM project_knowledge_deliveries`;
    assert.deepStrictEqual(
      yield* sql`SELECT message_id, status FROM project_knowledge_deliveries ORDER BY message_id`,
      [
        { message_id: "followup", status: "prepared" },
        { message_id: "message", status: "sent" },
      ],
    );
    assert.deepStrictEqual(yield* runMigrations(), []);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

it.effect("rebuilds knowledge facts as saved or forgotten, atomically and in place", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 91 });
    const insertFact = (fact: {
      readonly rowid: number;
      readonly id: string;
      readonly status: string;
      readonly origin: string;
      readonly projectId?: string;
      readonly supersedes?: string;
      readonly supersededBy?: string;
    }) => {
      const forgotten = fact.status === "forgotten";
      return sql`
        INSERT INTO project_knowledge_facts (
          rowid, id, project_id, status, revision, content, entities_json, tags_json, kind, trust,
          retrieval_count, created_at, updated_at, forgotten_at, sources_json, origin_json,
          supersedes_id, superseded_by_id
        ) VALUES (
          ${fact.rowid}, ${fact.id}, ${fact.projectId ?? "project"}, ${fact.status},
          ${fact.rowid + 1}, ${forgotten ? null : `lifecycle word${fact.id}`}, '[]', '[]',
          'decision', 0.65, ${fact.rowid * 2}, '2026-01-01T00:00:00.000Z',
          '2026-02-02T00:00:00.000Z', ${forgotten ? "2026-03-03T00:00:00.000Z" : null},
          ${forgotten ? "[]" : '[{"kind":"user"}]'}, ${fact.origin},
          ${fact.supersedes ?? null}, ${fact.supersededBy ?? null}
        )
      `;
    };
    const user = '{"kind":"user"}';
    const agent = '{"kind":"agent-client","sessionId":"session","label":"Agent"}';
    const assisted = '{"kind":"assisted","threadId":"thread","runId":"run","runOutcome":"failed"}';
    yield* insertFact({
      rowid: 3,
      id: "replaced",
      status: "confirmed",
      origin: user,
      supersededBy: "replacer",
    });
    yield* insertFact({
      rowid: 7,
      id: "replacer",
      status: "proposed",
      origin: assisted,
      supersedes: "replaced",
    });
    yield* insertFact({
      rowid: 11,
      id: "edited-pending",
      status: "proposed",
      origin: user,
      supersedes: "target",
    });
    yield* insertFact({
      rowid: 15,
      id: "assisted-pending",
      status: "proposed",
      origin: assisted,
      supersedes: "target",
    });
    yield* insertFact({ rowid: 19, id: "target", status: "confirmed", origin: agent });
    yield* insertFact({
      rowid: 23,
      id: "dangling",
      status: "confirmed",
      origin: agent,
      supersedes: "missing",
    });
    yield* insertFact({
      rowid: 27,
      id: "forgotten-pending",
      status: "forgotten",
      origin: agent,
      supersedes: "target",
    });
    yield* insertFact({
      rowid: 31,
      id: "cross-project",
      status: "proposed",
      origin: agent,
      projectId: "other",
      supersedes: "foreign",
    });
    yield* insertFact({
      rowid: 35,
      id: "foreign",
      status: "confirmed",
      origin: user,
      supersededBy: "cross-project",
    });
    yield* sql`
      INSERT INTO project_knowledge_fact_history (
        project_id, fact_id, revision, event, actor_json, sources_json, trust_after, created_at
      ) VALUES ('project', 'target', 20, 'confirmed', ${user}, '[]', 0.65, '2026-02-02T00:00:00.000Z')
    `;
    yield* sql`
      INSERT INTO project_knowledge_commands (
        command_id, project_id, fact_id, request_digest, search_json
      ) VALUES ('command', 'project', 'target', 'digest', '{"rootRequestId":"command"}')
    `;
    yield* sql`
      INSERT INTO project_knowledge_assisted_runs (
        run_id, project_id, thread_id, run_outcome, result, reason, proposed, suggested, completed_at
      ) VALUES ('run', 'project', 'thread', 'failed', 'ran', 'kept', 2, 1, '2026-02-02T00:00:00.000Z')
    `;
    const facts = sql<Record<string, unknown>>`
      SELECT rowid, * FROM project_knowledge_facts ORDER BY rowid
    `;
    const history = sql`SELECT * FROM project_knowledge_fact_history ORDER BY sequence`;
    const commands = sql`SELECT * FROM project_knowledge_commands ORDER BY command_id`;
    const before = yield* facts;
    const historyBefore = yield* history;
    const commandsBefore = yield* commands;
    const schema = sql`SELECT name, sql FROM sqlite_master ORDER BY name`;
    const schemaBefore = yield* schema;

    yield* sql`CREATE VIEW project_knowledge_facts_saved AS SELECT 1`;
    const failedSchema = yield* schema;
    assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
    assert.deepStrictEqual(yield* facts, before);
    assert.deepStrictEqual(yield* schema, failedSchema);
    yield* sql`DROP VIEW project_knowledge_facts_saved`;
    assert.deepStrictEqual(yield* schema, schemaBefore);

    assert.deepStrictEqual(yield* runMigrations(), [savedLifecycleMigration]);

    const cleared = new Set([
      "edited-pending",
      "assisted-pending",
      "dangling",
      "forgotten-pending",
      "cross-project",
    ]);
    assert.deepStrictEqual(
      yield* facts,
      before.map((row) => ({
        ...row,
        status: row.status === "forgotten" ? "forgotten" : "saved",
        supersedes_id: cleared.has(String(row.id)) ? null : row.supersedes_id,
      })),
    );
    assert.deepStrictEqual(yield* history, historyBefore);
    assert.deepStrictEqual(yield* commands, commandsBefore);
    assert.deepStrictEqual(yield* sql`SELECT * FROM project_knowledge_assisted_runs`, [
      {
        run_id: "run",
        project_id: "project",
        thread_id: "thread",
        run_outcome: "failed",
        result: "ran",
        reason: "kept",
        saved: 2,
        completed_at: "2026-02-02T00:00:00.000Z",
      },
    ]);
    assert.deepStrictEqual(
      yield* sql`
        SELECT name FROM sqlite_master
        WHERE tbl_name = 'project_knowledge_facts' AND type IN ('index', 'trigger')
          AND name NOT LIKE 'sqlite_autoindex%'
        ORDER BY name
      `,
      [
        { name: "project_knowledge_delete" },
        { name: "project_knowledge_facts_project" },
        { name: "project_knowledge_insert" },
        { name: "project_knowledge_update" },
      ],
    );

    const matches = (term: string) =>
      sql<{ id: string }>`
        SELECT f.id FROM project_knowledge_fts
        JOIN project_knowledge_facts f ON f.rowid = project_knowledge_fts.rowid
        WHERE project_knowledge_fts MATCH ${term} ORDER BY f.id
      `.pipe(Effect.map((rows) => rows.map((row) => row.id)));
    assert.deepStrictEqual(yield* matches("wordtarget"), ["target"]);
    assert.lengthOf(yield* matches("lifecycle"), 8);
    yield* sql`UPDATE project_knowledge_facts SET content = 'renamed' WHERE id = 'target'`;
    assert.deepStrictEqual(yield* matches("wordtarget"), []);
    assert.deepStrictEqual(yield* matches("renamed"), ["target"]);
    yield* sql`DELETE FROM project_knowledge_facts WHERE id = 'target'`;
    assert.deepStrictEqual(yield* matches("renamed"), []);
    yield* insertFact({ rowid: 40, id: "fresh", status: "saved", origin: user });
    assert.deepStrictEqual(yield* matches("wordfresh"), ["fresh"]);

    for (const status of ["proposed", "confirmed"]) {
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(insertFact({ rowid: 50, id: `old-${status}`, status, origin: user })),
        ),
      );
      assert.isTrue(
        Exit.isFailure(
          yield* Effect.exit(
            sql`UPDATE project_knowledge_facts SET status = ${status} WHERE id = 'fresh'`,
          ),
        ),
      );
    }
    assert.isTrue(
      Exit.isFailure(
        yield* Effect.exit(
          sql`UPDATE project_knowledge_assisted_runs SET saved = -1 WHERE run_id = 'run'`,
        ),
      ),
    );
    assert.deepStrictEqual(yield* runMigrations(), []);

    // The published preview recorded this same saved schema at 91, before Loom cleanup.
    const savedFacts = yield* facts;
    const savedHistory = yield* history;
    const savedCommands = yield* commands;
    const savedRuns = yield* sql`SELECT * FROM project_knowledge_assisted_runs`;
    const savedSchema = yield* schema;
    yield* ProjectLoomTimeIndexes;
    yield* ProjectLoomBoundedReads;
    yield* previewLoomIndexes;
    yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 91`;
    yield* sql`UPDATE effect_sql_migrations SET migration_id = 91 WHERE migration_id = 92`;
    const migrations = sql<{
      readonly migration_id: number;
      readonly name: string;
      readonly created_at: string;
    }>`SELECT migration_id, name, created_at FROM effect_sql_migrations ORDER BY migration_id`;
    const previewHistory = yield* migrations;
    const previewSchema = yield* schema;

    yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (93, 'UnknownPreview')`;
    const unknownHistory = yield* migrations;
    assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
    assert.deepStrictEqual(yield* migrations, unknownHistory);
    assert.deepStrictEqual(yield* schema, previewSchema);
    yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 93`;

    yield* sql`ALTER TABLE project_knowledge_assisted_runs RENAME COLUMN saved TO proposed`;
    const incompleteSchema = yield* schema;
    assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
    assert.deepStrictEqual(yield* migrations, previewHistory);
    assert.deepStrictEqual(yield* schema, incompleteSchema);
    yield* sql`ALTER TABLE project_knowledge_assisted_runs RENAME COLUMN proposed TO saved`;

    yield* sql`
      CREATE TRIGGER reject_saved_preview_receipt BEFORE UPDATE ON effect_sql_migrations
      WHEN new.migration_id = 92 BEGIN
        SELECT RAISE(ABORT, 'receipt update failed');
      END
    `;
    const rollbackSchema = yield* schema;
    assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
    assert.deepStrictEqual(yield* migrations, previewHistory);
    assert.deepStrictEqual(yield* schema, rollbackSchema);
    yield* sql`DROP TRIGGER reject_saved_preview_receipt`;

    assert.deepStrictEqual(yield* runMigrations(), [dropProjectLoomIndexesMigration]);
    assert.deepStrictEqual(yield* facts, savedFacts);
    assert.deepStrictEqual(yield* history, savedHistory);
    assert.deepStrictEqual(yield* commands, savedCommands);
    assert.deepStrictEqual(yield* sql`SELECT * FROM project_knowledge_assisted_runs`, savedRuns);
    assert.deepStrictEqual(yield* schema, savedSchema);
    const reconciledHistory = yield* migrations;
    assert.deepStrictEqual(
      reconciledHistory.map(({ migration_id, name }) => [migration_id, name] as const),
      migrationManifest,
    );
    assert.deepStrictEqual(
      reconciledHistory.find(({ migration_id }) => migration_id === 92),
      { ...previewHistory.find(({ migration_id }) => migration_id === 91), migration_id: 92 },
    );
    assert.deepStrictEqual(yield* matches("wordfresh"), ["fresh"]);
    assert.deepStrictEqual(yield* runMigrations(), []);
    assert.deepStrictEqual(yield* migrations, reconciledHistory);
  }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
);

const previewNativeColumns = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE project_knowledge_deliveries ADD COLUMN provider_thread_id TEXT`;
  yield* sql`ALTER TABLE project_knowledge_deliveries ADD COLUMN native_thread_id TEXT`;
});

const previewBudgetColumn = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`ALTER TABLE project_knowledge_deliveries ADD COLUMN budget_json TEXT`;
});

const previewLoomIndexes = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_turn_items_run_updated_idx
    ON orchestration_v2_projection_turn_items(run_id, updated_at, type, thread_id)
  `;
  yield* sql`
    CREATE INDEX orchestration_v2_projection_turn_items_run_command_at_idx
    ON orchestration_v2_projection_turn_items(
      run_id,
      COALESCE(json_extract(payload_json, '$.startedAt'), json_extract(payload_json, '$.completedAt'))
    )
    WHERE type = 'command_execution'
  `;
});

const previewRoutes = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE cross_environment_launches (
      command_id TEXT PRIMARY KEY,
      request_hash TEXT NOT NULL,
      destination_json TEXT,
      result_json TEXT,
      CHECK (result_json IS NULL OR destination_json IS NOT NULL)
    )
  `;
  yield* sql`
    INSERT INTO cross_environment_launches (command_id, request_hash, destination_json, result_json)
    VALUES ('launch', 'request-hash', '{"environmentId":"peer","projectId":"project"}', '{"threadId":"remote-thread"}')
  `;
});

const seedDelivery = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO project_knowledge_deliveries (
      attempt_id, run_id, thread_id, message_id, project_id, provider_instance_id,
      status, items_json, omissions_json, created_at, updated_at,
      provider_thread_id, native_thread_id
    ) VALUES (
      'attempt', 'run', 'thread', 'message', 'project', 'provider',
      'sent', '[]', '[]', '2026-10-23', '2026-10-23', 'provider-thread', 'native-thread'
    )
  `;
});

const publishedConsolidatedPreview = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* runMigrations({ toMigrationInclusive: 79 });
  yield* previewNativeColumns;
  yield* previewBudgetColumn;
  yield* previewLoomIndexes;
  yield* previewRoutes;
  yield* seedDelivery;
  yield* sql`
    INSERT INTO effect_sql_migrations (migration_id, name, created_at)
    VALUES (80, 'ProjectIntelligenceAndCrossEnvironment', '2026-10-25 02:00:00')
  `;
});

const previewPeerLinks = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    CREATE TABLE peer_environment_links (
      environment_id TEXT PRIMARY KEY,
      secret_name TEXT NOT NULL,
      label TEXT NOT NULL,
      urls_json TEXT NOT NULL,
      access TEXT NOT NULL,
      linked_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_reached_at TEXT,
      last_error TEXT
    )
  `;
  yield* sql`
    INSERT INTO peer_environment_links (
      environment_id, secret_name, label, urls_json, access, linked_at, expires_at
    ) VALUES (
      'peer', 'peer-secret-name', 'Box', '["https://box.example"]', 'auto',
      '2026-10-25', '2026-11-24'
    )
  `;
});

const assertConsolidatedSchema = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const columns = yield* sql<{
    readonly name: string;
  }>`PRAGMA table_info(project_knowledge_deliveries)`;
  for (const name of ["provider_thread_id", "native_thread_id", "budget_json"]) {
    assert.ok(columns.some((column) => column.name === name));
  }
  const indexes = yield* sql<{ readonly name: string }>`
    SELECT name FROM sqlite_master WHERE type = 'index'
  `;
  for (const name of [
    "orchestration_v2_projection_turn_items_stop_request_idx",
    "orchestration_v2_projection_turn_items_waiting_link_idx",
    "orchestration_v2_projection_threads_project_linked_idx",
  ]) {
    assert.ok(indexes.some((index) => index.name === name));
  }
  for (const name of [
    "orchestration_v2_projection_runs_thread_requested_idx",
    "orchestration_v2_projection_runs_thread_completed_idx",
    "orchestration_v2_projection_checkpoints_thread_captured_idx",
    "orchestration_v2_projection_turn_items_run_command_updated_idx",
    "orchestration_v2_projection_turn_items_run_updated_idx",
    "orchestration_v2_projection_turn_items_run_command_at_idx",
  ]) {
    assert.notOk(indexes.some((index) => index.name === name));
  }
  const peerColumns = yield* sql<{
    readonly name: string;
    readonly notnull: number;
    readonly dflt_value: string | null;
  }>`PRAGMA table_info(peer_environment_links)`;
  assert.deepStrictEqual(
    peerColumns.map((column) => column.name),
    [
      "environment_id",
      "secret_name",
      "label",
      "urls_json",
      "access",
      "linked_at",
      "expires_at",
      "last_reached_at",
      "last_error",
      "fenced",
    ],
  );
  assert.include(
    peerColumns.find((column) => column.name === "fenced"),
    {
      notnull: 1,
      dflt_value: "0",
    },
  );
  const waitingIndex = yield* sql<{ readonly sql: string }>`
    SELECT sql FROM sqlite_master
    WHERE type = 'index' AND name = 'orchestration_v2_projection_turn_items_waiting_link_idx'
  `;
  assert.include(waitingIndex[0]?.sql, "(thread_id, updated_at DESC, turn_item_id DESC)");
  assert.include(waitingIndex[0]?.sql, "WHERE type = 'link_request' AND status = 'waiting'");
});

const history = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ readonly migration_id: number; readonly name: string }>`
    SELECT migration_id, name FROM effect_sql_migrations ORDER BY migration_id
  `;
  return rows.map((row) => [row.migration_id, row.name] as const);
});

const v2TableCount = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql`
    SELECT name FROM sqlite_master WHERE type = 'table' AND name LIKE 'orchestration_v2_%'
  `;
  return rows.length;
});

describe("runMigrations", () => {
  it.effect("refuses to start when another migration took a V2 id", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name) VALUES (55, 'FutureMainMigration')
      `;
      const before = yield* history;

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 54 }), []);
      const exit = yield* Effect.exit(runMigrations());

      assert.isTrue(Exit.isFailure(exit));
      assert.include(String(exit), "55_OrchestrationV2 (recorded: FutureMainMigration)");
      assert.deepStrictEqual(yield* history, before);
      assert.strictEqual(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("refuses to start when a later id would skip V2 migrations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${newerMigrationId}, 'FutureMainMigration')
      `;
      const before = yield* history;

      const exit = yield* Effect.exit(runMigrations());

      assert.isTrue(Exit.isFailure(exit));
      for (const [id, name] of v2Migrations) {
        assert.include(String(exit), `${id}_${name} (recorded: nothing)`);
      }
      assert.deepStrictEqual(yield* history, before);
      assert.strictEqual(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each([77, 89])("adds upstream schema to an existing fork database at %s", (through) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: through });
      for (const threadId of [null, "thread:scheduled"] as const) {
        yield* sql`INSERT INTO scheduled_tasks ${sql.insert({
          task_id: threadId === null ? "new-thread" : "continue",
          title: "Existing task",
          prompt: "Run the audit",
          enabled: 1,
          schedule_json: '{"type":"interval","everyMs":60000}',
          project_id: "project:scheduled",
          thread_id: threadId,
          workspace_strategy_json: '{"type":"root"}',
          model_selection_json: '{"instanceId":"codex","model":"gpt-5"}',
          runtime_mode: "full-access",
          interaction_mode: "default",
          created_by: "user",
          creation_source: "web",
          created_at: "2026-11-05",
          updated_at: "2026-11-05",
          last_run_status: "never",
          run_count: 0,
        })}`;
      }
      const before = yield* history;
      assert.deepStrictEqual(
        yield* runMigrations(),
        migrationManifest.filter(([id]) => id > through),
      );
      assert.deepStrictEqual((yield* history).slice(0, before.length), before);
      assert.deepStrictEqual(
        yield* sql`SELECT task_id, thread_id, thread_mode FROM scheduled_tasks ORDER BY task_id`,
        [
          { task_id: "continue", thread_id: "thread:scheduled", thread_mode: "continue" },
          { task_id: "new-thread", thread_id: null, thread_mode: "new_thread" },
        ],
      );
      const indexes = yield* sql`
        SELECT name FROM sqlite_master
        WHERE name = 'orchestration_v2_projection_turn_items_stop_request_idx'
      `;
      assert.lengthOf(indexes, 1);
      yield* assertConsolidatedSchema;
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each([
    { through: 77, hasBudget: false },
    { through: 77, hasBudget: true },
    { through: 78, hasBudget: false },
    { through: 78, hasBudget: true },
  ])(
    "preserves knowledge preview receipts when reconciling migration ids: %j",
    ({ through, hasBudget }) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: through });
        yield* previewNativeColumns;
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name, created_at)
          VALUES (79, 'ProjectKnowledgeNativeDelivery', '2026-10-23 01:00:00')
        `;
        if (hasBudget) {
          yield* previewBudgetColumn;
          yield* sql`
            INSERT INTO effect_sql_migrations (migration_id, name, created_at)
            VALUES (80, 'ProjectKnowledgeDeliveryBudget', '2026-10-23 02:00:00')
          `;
        }
        yield* seedDelivery;
        if (hasBudget) {
          yield* sql`UPDATE project_knowledge_deliveries SET budget_json = '{"capacity":128000}'`;
        }

        yield* runMigrations();

        assert.deepStrictEqual(yield* history, migrationManifest);
        assert.deepStrictEqual(
          yield* sql`SELECT provider_thread_id, native_thread_id, budget_json FROM project_knowledge_deliveries`,
          [
            {
              provider_thread_id: "provider-thread",
              native_thread_id: "native-thread",
              budget_json: hasBudget ? '{"capacity":128000}' : null,
            },
          ],
        );
        assert.deepStrictEqual(
          yield* sql`SELECT created_at FROM effect_sql_migrations WHERE migration_id = 80`,
          [{ created_at: "2026-10-23 01:00:00" }],
        );
        assert.lengthOf(
          yield* sql`SELECT name FROM sqlite_master WHERE name = 'orchestration_v2_projection_turn_items_stop_request_idx'`,
          1,
        );
        assert.deepStrictEqual(
          (yield* history).filter(([id]) => id >= 80),
          [
            consolidatedMigration,
            messageDeliveryMigration,
            activeTurnItemMigration,
            attachmentPlaceholderMigration,
            subagentDeliveryMigration,
            projectPinArchiveMigration,
            settledOverrideMigration,
            correlationIndexMigration,
            modelEvaluationMigration,
            delegatedRecoveryMigration,
            scheduledTaskThreadModeMigration,
            dropProjectLoomIndexesMigration,
            savedLifecycleMigration,
          ],
        );
        yield* assertConsolidatedSchema;
        assert.deepStrictEqual(yield* runMigrations(), []);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("does not rewrite a knowledge preview with unexpected later migrations", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 77 });
      yield* previewNativeColumns;
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (79, 'ProjectKnowledgeNativeDelivery'), (80, 'UnrelatedMigration')
      `;
      const before = yield* history;

      assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
      assert.deepStrictEqual(yield* history, before);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("adds intelligence migrations to the upstream schema", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 79 });
      assert.deepStrictEqual(
        migrationManifest.filter(([id]) => id >= 80),
        [
          consolidatedMigration,
          messageDeliveryMigration,
          activeTurnItemMigration,
          attachmentPlaceholderMigration,
          subagentDeliveryMigration,
          projectPinArchiveMigration,
          settledOverrideMigration,
          correlationIndexMigration,
          modelEvaluationMigration,
          delegatedRecoveryMigration,
          scheduledTaskThreadModeMigration,
          dropProjectLoomIndexesMigration,
          savedLifecycleMigration,
        ],
      );
      assert.deepStrictEqual(yield* runMigrations(), [
        consolidatedMigration,
        messageDeliveryMigration,
        activeTurnItemMigration,
        attachmentPlaceholderMigration,
        subagentDeliveryMigration,
        projectPinArchiveMigration,
        settledOverrideMigration,
        correlationIndexMigration,
        modelEvaluationMigration,
        delegatedRecoveryMigration,
        scheduledTaskThreadModeMigration,
        dropProjectLoomIndexesMigration,
        savedLifecycleMigration,
      ]);
      yield* assertConsolidatedSchema;
      assert.deepStrictEqual(
        yield* sql`SELECT name FROM sqlite_master WHERE name = 'cross_environment_launches'`,
        [],
      );
      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each(["absent", "unfenced", "fenced"] as const)(
    "completes the published consolidated preview with %s peer schema without rewriting data",
    (peerSchema) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* publishedConsolidatedPreview;
        if (peerSchema !== "absent") yield* previewPeerLinks;
        if (peerSchema === "fenced") {
          yield* sql`ALTER TABLE peer_environment_links ADD COLUMN fenced INTEGER NOT NULL DEFAULT 0`;
          yield* sql`UPDATE peer_environment_links SET fenced = 1`;
        }
        const beforeHistory = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
        const beforeRoutes = yield* sql`SELECT * FROM cross_environment_launches`;
        const beforeDeliveries = yield* sql`SELECT * FROM project_knowledge_deliveries`;

        assert.deepStrictEqual(yield* runMigrations(), [
          messageDeliveryMigration,
          activeTurnItemMigration,
          attachmentPlaceholderMigration,
          subagentDeliveryMigration,
          projectPinArchiveMigration,
          settledOverrideMigration,
          correlationIndexMigration,
          modelEvaluationMigration,
          delegatedRecoveryMigration,
          scheduledTaskThreadModeMigration,
          dropProjectLoomIndexesMigration,
          savedLifecycleMigration,
        ]);

        yield* assertConsolidatedSchema;
        assert.deepStrictEqual(
          yield* sql`SELECT * FROM effect_sql_migrations WHERE migration_id <= 80 ORDER BY migration_id`,
          beforeHistory,
        );
        assert.deepStrictEqual(yield* sql`SELECT * FROM cross_environment_launches`, beforeRoutes);
        assert.deepStrictEqual(
          yield* sql`SELECT * FROM project_knowledge_deliveries`,
          beforeDeliveries,
        );
        assert.deepStrictEqual(
          yield* sql`SELECT * FROM peer_environment_links`,
          peerSchema === "absent"
            ? []
            : [
                {
                  environment_id: "peer",
                  secret_name: "peer-secret-name",
                  label: "Box",
                  urls_json: '["https://box.example"]',
                  access: "auto",
                  linked_at: "2026-10-25",
                  expires_at: "2026-11-24",
                  last_reached_at: null,
                  last_error: null,
                  fenced: peerSchema === "fenced" ? 1 : 0,
                },
              ],
        );
        const schema = yield* sql`SELECT name, type, sql FROM sqlite_master ORDER BY name`;
        assert.deepStrictEqual(yield* runMigrations(), []);
        assert.deepStrictEqual(
          yield* sql`SELECT name, type, sql FROM sqlite_master ORDER BY name`,
          schema,
        );
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each(["foreign", "missing", "later"] as const)(
    "does not complete a published preview with a %s migration history",
    (position) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* publishedConsolidatedPreview;
        if (position === "foreign") {
          yield* sql`UPDATE effect_sql_migrations SET name = 'PeerLinks' WHERE migration_id = 68`;
        } else if (position === "missing") {
          yield* sql`DELETE FROM effect_sql_migrations WHERE migration_id = 77`;
        } else {
          yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (81, 'UnrelatedMigration')`;
        }
        const beforeHistory = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
        const beforeSchema = yield* sql`SELECT name, type, sql FROM sqlite_master ORDER BY name`;

        assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));

        assert.deepStrictEqual(
          yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
          beforeHistory,
        );
        assert.deepStrictEqual(
          yield* sql`SELECT name, type, sql FROM sqlite_master ORDER BY name`,
          beforeSchema,
        );
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("rolls back peer schema completion before retrying a published preview", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* publishedConsolidatedPreview;
      yield* previewPeerLinks;
      // Force the final index creation to fail after the fenced column was added.
      yield* sql`CREATE VIEW orchestration_v2_projection_turn_items_waiting_link_idx AS SELECT 1`;
      const beforeHistory = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
      const beforeSchema = yield* sql`SELECT name, type, sql FROM sqlite_master ORDER BY name`;
      const beforePeers = yield* sql`SELECT * FROM peer_environment_links`;
      const beforeRoutes = yield* sql`SELECT * FROM cross_environment_launches`;

      assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));

      assert.deepStrictEqual(
        yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
        beforeHistory,
      );
      assert.deepStrictEqual(
        yield* sql`SELECT name, type, sql FROM sqlite_master ORDER BY name`,
        beforeSchema,
      );
      assert.deepStrictEqual(yield* sql`SELECT * FROM peer_environment_links`, beforePeers);
      assert.deepStrictEqual(yield* sql`SELECT * FROM cross_environment_launches`, beforeRoutes);

      yield* sql`DROP VIEW orchestration_v2_projection_turn_items_waiting_link_idx`;
      assert.deepStrictEqual(yield* runMigrations(), [
        messageDeliveryMigration,
        activeTurnItemMigration,
        attachmentPlaceholderMigration,
        subagentDeliveryMigration,
        projectPinArchiveMigration,
        settledOverrideMigration,
        correlationIndexMigration,
        modelEvaluationMigration,
        delegatedRecoveryMigration,
        scheduledTaskThreadModeMigration,
        dropProjectLoomIndexesMigration,
        savedLifecycleMigration,
      ]);
      yield* assertConsolidatedSchema;
      assert.deepStrictEqual(yield* sql`SELECT secret_name, fenced FROM peer_environment_links`, [
        { secret_name: "peer-secret-name", fenced: 0 },
      ]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each([80, 81, 82, 83])(
    "consolidates the split preview through %s without losing delivery or routing data",
    (through) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 79 });
        yield* previewNativeColumns;
        yield* sql`
          INSERT INTO effect_sql_migrations (migration_id, name, created_at)
          VALUES (80, 'ProjectKnowledgeNativeDelivery', '2026-10-23 01:00:00')
        `;
        yield* seedDelivery;
        if (through >= 81) {
          yield* previewBudgetColumn;
          yield* sql`UPDATE project_knowledge_deliveries SET budget_json = '{"capacity":128000}'`;
          yield* sql`
            INSERT INTO effect_sql_migrations (migration_id, name)
            VALUES (81, 'ProjectKnowledgeDeliveryBudget')
          `;
        }
        if (through >= 82) {
          yield* previewLoomIndexes;
          yield* sql`
            INSERT INTO effect_sql_migrations (migration_id, name)
            VALUES (82, 'ProjectLoomWindowItems')
          `;
        }
        if (through >= 83) {
          yield* previewRoutes;
          yield* sql`
            INSERT INTO effect_sql_migrations (migration_id, name)
            VALUES (83, 'CrossEnvironmentLaunches')
          `;
        }

        assert.deepStrictEqual(yield* runMigrations(), [
          consolidatedMigration,
          messageDeliveryMigration,
          activeTurnItemMigration,
          attachmentPlaceholderMigration,
          subagentDeliveryMigration,
          projectPinArchiveMigration,
          settledOverrideMigration,
          correlationIndexMigration,
          modelEvaluationMigration,
          delegatedRecoveryMigration,
          scheduledTaskThreadModeMigration,
          dropProjectLoomIndexesMigration,
          savedLifecycleMigration,
        ]);
        assert.deepStrictEqual(yield* history, migrationManifest);
        assert.deepStrictEqual(
          yield* sql`SELECT provider_thread_id, native_thread_id, budget_json FROM project_knowledge_deliveries`,
          [
            {
              provider_thread_id: "provider-thread",
              native_thread_id: "native-thread",
              budget_json: through >= 81 ? '{"capacity":128000}' : null,
            },
          ],
        );
        assert.deepStrictEqual(
          yield* sql`SELECT created_at FROM effect_sql_migrations WHERE migration_id = 80`,
          [{ created_at: "2026-10-23 01:00:00" }],
        );
        if (through >= 83) {
          assert.deepStrictEqual(yield* sql`SELECT * FROM cross_environment_launches`, [
            {
              command_id: "launch",
              request_hash: "request-hash",
              destination_json: '{"environmentId":"peer","projectId":"project"}',
              result_json: '{"threadId":"remote-thread"}',
            },
          ]);
        } else {
          assert.deepStrictEqual(
            yield* sql`SELECT name FROM sqlite_master WHERE name = 'cross_environment_launches'`,
            [],
          );
        }
        yield* assertConsolidatedSchema;
        assert.deepStrictEqual(yield* runMigrations(), []);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect(
    "preserves routing-only preview receipts when the memory preview was not installed",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 79 });
        yield* previewRoutes;
        yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name, created_at)
        VALUES (83, 'CrossEnvironmentLaunches', '2026-10-25 01:00:00')
      `;
        const routes = yield* sql`SELECT * FROM cross_environment_launches`;
        assert.deepStrictEqual(yield* runMigrations(), [
          consolidatedMigration,
          messageDeliveryMigration,
          activeTurnItemMigration,
          attachmentPlaceholderMigration,
          subagentDeliveryMigration,
          projectPinArchiveMigration,
          settledOverrideMigration,
          correlationIndexMigration,
          modelEvaluationMigration,
          delegatedRecoveryMigration,
          scheduledTaskThreadModeMigration,
          dropProjectLoomIndexesMigration,
          savedLifecycleMigration,
        ]);
        assert.deepStrictEqual(yield* history, migrationManifest);
        assert.deepStrictEqual(yield* sql`SELECT * FROM cross_environment_launches`, routes);
        yield* assertConsolidatedSchema;
        assert.deepStrictEqual(yield* runMigrations(), []);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect(
    "rolls back preview schema and history together when consolidation fails, then retries",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 77 });
        yield* previewNativeColumns;
        yield* seedDelivery;
        yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name, created_at)
        VALUES (79, 'ProjectKnowledgeNativeDelivery', '2026-10-23 01:00:00')
      `;
        yield* sql`
        CREATE TRIGGER fail_combined_upgrade BEFORE INSERT ON effect_sql_migrations
        WHEN NEW.name = 'ProjectIntelligenceAndCrossEnvironment'
        BEGIN SELECT RAISE(ABORT, 'injected failure'); END
      `;
        const beforeHistory = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
        const beforeSchema = yield* sql`SELECT name, type, sql FROM sqlite_master ORDER BY name`;
        const beforeReceipts = yield* sql`SELECT * FROM project_knowledge_deliveries`;

        assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
        assert.deepStrictEqual(
          yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
          beforeHistory,
        );
        assert.deepStrictEqual(
          yield* sql`SELECT name, type, sql FROM sqlite_master ORDER BY name`,
          beforeSchema,
        );
        assert.deepStrictEqual(
          yield* sql`SELECT * FROM project_knowledge_deliveries`,
          beforeReceipts,
        );

        yield* sql`DROP TRIGGER fail_combined_upgrade`;
        yield* runMigrations();
        yield* assertConsolidatedSchema;
        assert.deepStrictEqual(yield* history, migrationManifest);
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each(["earlier", "later"] as const)(
    "does not modify a split preview with an unexpected %s migration",
    (position) =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 79 });
        yield* previewNativeColumns;
        yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (80, 'ProjectKnowledgeNativeDelivery')
      `;
        if (position === "earlier") {
          yield* sql`UPDATE effect_sql_migrations SET name = 'UnrelatedMigration' WHERE migration_id = 77`;
        } else {
          yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES (81, 'UnrelatedMigration')`;
        }
        const beforeHistory = yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`;
        const beforeSchema = yield* sql`SELECT name, type, sql FROM sqlite_master ORDER BY name`;
        assert.isTrue(Exit.isFailure(yield* Effect.exit(runMigrations())));
        assert.deepStrictEqual(
          yield* sql`SELECT * FROM effect_sql_migrations ORDER BY migration_id`,
          beforeHistory,
        );
        assert.deepStrictEqual(
          yield* sql`SELECT name, type, sql FROM sqlite_master ORDER BY name`,
          beforeSchema,
        );
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("upgrades a database at exactly 54", () =>
    Effect.gen(function* () {
      yield* runMigrations({ toMigrationInclusive: 54 });
      assert.deepStrictEqual(yield* runMigrations(), v2Migrations);
      assert.deepStrictEqual(yield* history, migrationManifest);
      assert.isAbove(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("drops the unused correlation index and keeps correlation values", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        INSERT INTO orchestration_events (
          event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at,
          command_id, causation_event_id, correlation_id, actor_kind, payload_json, metadata_json
        )
        VALUES (
          'event-1', 'thread', 'thread-1', 0, 'thread.created', '2026-01-01T00:00:00.000Z',
          'command-1', NULL, 'correlation-1', 'client', '{}', '{}'
        )
      `;

      yield* runMigrations();

      const indexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND tbl_name = 'orchestration_events' AND sql IS NOT NULL
      `;
      const indexNames = indexes.map((row) => row.name);
      assert.notInclude(indexNames, "idx_orch_events_correlation_id");
      for (const kept of [
        "idx_orch_events_stream_version",
        "idx_orch_events_stream_sequence",
        "idx_orch_events_command_id",
        "idx_orchestration_events_agent_stream_sequence",
      ]) {
        assert.include(indexNames, kept);
      }
      const events = yield* sql<{ readonly correlation_id: string | null }>`
        SELECT correlation_id FROM orchestration_events WHERE event_id = 'event-1'
      `;
      assert.deepStrictEqual(events, [{ correlation_id: "correlation-1" }]);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect.each([30, 54])("still starts with a site-local migration at id %s", (id) =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 54 });
      yield* sql`
        UPDATE effect_sql_migrations SET name = 'SiteLocalMigration' WHERE migration_id = ${id}
      `;

      assert.deepStrictEqual(yield* runMigrations(), v2Migrations);
      assert.isAbove(yield* v2TableCount, 0);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("only checks V2 migrations within the requested limit", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 55 });
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (56, 'SiteLocalMigration'), (${newerMigrationId}, 'NewerV2Migration')
      `;
      const before = yield* history;

      assert.deepStrictEqual(yield* runMigrations({ toMigrationInclusive: 55 }), []);
      const exit = yield* Effect.exit(runMigrations({ toMigrationInclusive: 56 }));
      assert.isTrue(Exit.isFailure(exit));
      assert.include(
        String(exit),
        "56_RemoveRedundantProjectionIndexes (recorded: SiteLocalMigration)",
      );
      assert.notInclude(String(exit), "57_ScheduledTaskWebhooks");
      assert.deepStrictEqual(yield* history, before);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("still starts after a newer build recorded a later V2 migration", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations();
      yield* sql`
        INSERT INTO effect_sql_migrations (migration_id, name)
        VALUES (${newerMigrationId}, 'NewerV2Migration')
      `;

      assert.deepStrictEqual(yield* runMigrations(), []);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});

// The npm launcher reads the highest migration id from these file names.
it.effect("registers every migration file", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const dir = path.join(import.meta.dirname, "Migrations");
    const files = (yield* fs.readDirectory(dir)).flatMap((name) => {
      const match = /^(\d+)_(\w+)\.ts$/.exec(name);
      return match ? [[Number(match[1]), match[2]] as const] : [];
    });
    assert.deepStrictEqual(
      files.toSorted(([a], [b]) => a - b),
      migrationManifest,
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
