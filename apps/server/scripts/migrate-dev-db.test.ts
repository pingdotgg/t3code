import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as SqlClient from "effect/sql/SqlClient";

import { backfillToolSearchBatch } from "../src/orchestration-v2/toolSearchIndex.ts";
import { runMigrations } from "../src/persistence/Migrations.ts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import { dropResumableFamilies, runMigrateDevDb } from "./migrate-dev-db.ts";

const withDatabase = <A, E, R>(
  databasePath: string,
  effect: Effect.Effect<A, E, R | SqlClient.SqlClient>,
) => effect.pipe(Effect.provide(NodeSqliteClient.layer({ filename: databasePath })));

const insertPeerLink = (sql: SqlClient.SqlClient) => sql`INSERT INTO peer_environment_links
  (environment_id, secret_name, label, urls_json, access, linked_at, expires_at)
  VALUES ('environment-box', 'peer-link-box', 'Box', '["https://box.example"]', 'auto',
    '2026-08-01', '2027-08-01')`;

const createFixtureSource = Effect.fn("createMigrateDevDbFixtureSource")(function* (
  baseDir: string,
  toMigrationInclusive?: number,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const stateDir = path.join(baseDir, "userdata");
  const databasePath = path.join(stateDir, "statev2.sqlite");
  yield* fs.makeDirectory(stateDir, { recursive: true });
  yield* withDatabase(
    databasePath,
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive });

      const scripts = JSON.stringify([
        { id: "lint", name: "Lint", command: "vp lint", icon: "lint", runOnWorktreeCreate: false },
        {
          id: "teardown",
          name: "Teardown",
          command: "./teardown",
          icon: "configure",
          runOnWorktreeCreate: false,
          runOnSettle: true,
        },
      ]);
      yield* sql`INSERT INTO projection_projects
        (project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at)
        VALUES
        ('project-kept', 'Kept', '/tmp/kept', ${scripts}, '2026-08-01', '2026-08-01', NULL),
        ('project-deleted', 'Deleted', '/tmp/deleted', '[]', '2026-08-01', '2026-08-02', '2026-08-02')`;

      const forkPayload =
        '{"lineage":{"parentThreadId":"stopped-thread","relationshipToParent":"fork","rootThreadId":"stopped-thread"}}';
      const subagentPayload =
        '{"lineage":{"parentThreadId":"subagent-parent","relationshipToParent":"subagent","rootThreadId":"subagent-parent"},"forkedFrom":{"type":"node","nodeId":"node-1"}}';
      const watchedPayload = JSON.stringify({
        pullRequests: [
          {
            host: "github.com",
            repository: "owner/repo",
            number: 7,
            url: "https://github.com/owner/repo/pull/7",
            source: "agent",
            linkedAt: "2026-08-01T00:00:00.000Z",
            snapshot: null,
            stack: null,
            watch: {
              startedAt: "2026-08-01T00:00:00.000Z",
              headSha: null,
              failedChecks: [],
              passed: false,
              passedChecks: [],
              remarksThrough: "2026-08-01T00:00:00.000Z",
              remarkIds: [],
              conflicting: false,
              wakes: 0,
            },
          },
        ],
      });
      const threads = [
        ["stopped-thread", "project-kept", "completed", watchedPayload, "2026-08-01"],
        ["fork-thread", "project-kept", "completed", forkPayload, "2026-08-02"],
        ["running-thread", "project-kept", "running", "{}", "2026-08-05"],
        ["settled-thread", "project-kept", "completed", '{"settledAt":"2026-08-01"}', "2026-08-05"],
        [
          "archived-thread",
          "project-kept",
          "completed",
          '{"archivedAt":"2026-08-01"}',
          "2026-08-05",
        ],
        [
          "limit-thread",
          "project-kept",
          "completed",
          '{"limitRecovery":{"autoResume":true}}',
          "2026-08-05",
        ],
        ["subagent-parent", "project-kept", "completed", "{}", "2026-08-05"],
        ["subagent-child", "project-kept", "completed", subagentPayload, "2026-08-05"],
        ["deleted-project-thread", "project-deleted", "completed", "{}", "2026-08-05"],
        // Finished, but startup recovery would deliver its unread steer and start a turn.
        ["steer-thread", "project-kept", "completed", "{}", "2026-08-09"],
      ] as const;
      for (const [threadId, projectId, runStatus, payload, updatedAt] of threads) {
        yield* sql`INSERT INTO orchestration_v2_projection_threads
          (thread_id, project_id, title, default_provider, runtime_mode, interaction_mode, created_at, updated_at, payload_json)
          VALUES (${threadId}, ${projectId}, ${threadId}, 'codex', 'full-access', 'default', '2026-08-01', ${updatedAt}, ${payload})`;
        yield* sql`INSERT INTO orchestration_v2_projection_runs
          (run_id, thread_id, ordinal, provider, status, requested_at, payload_json)
          VALUES (${`run-${threadId}`}, ${threadId}, 1, 'codex', ${runStatus}, '2026-08-01', '{}')`;
        yield* sql`INSERT INTO orchestration_events
          (event_id, aggregate_kind, stream_id, stream_version, event_type, occurred_at, actor_kind, payload_json, metadata_json, application_event_version)
          VALUES (${`event-${threadId}`}, 'thread', ${threadId}, 0, 'thread.created', '2026-08-01', 'user', '{}', '{}', 2)`;
      }
      yield* sql`INSERT INTO orchestration_v2_projection_turn_items
        (turn_item_id, thread_id, run_id, ordinal, type, status, updated_at, payload_json)
        VALUES ('steer-item', 'steer-thread', 'run-steer-thread', 2, 'user_message', 'pending',
          '2026-08-09', '{"inputIntent":"steer"}')`;
      // A V1 thread the server already imported must not trip the legacy guard.
      yield* sql`INSERT INTO projection_threads
        (thread_id, project_id, title, model_selection_json, runtime_mode, created_at, updated_at)
        VALUES ('stopped-thread', 'project-kept', 'stopped-thread',
          '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', '2026-08-01', '2026-08-01')`;
      yield* sql`INSERT INTO orchestration_v2_projection_provider_sessions
        (provider_session_id, thread_id, provider, status, updated_at, payload_json)
        VALUES ('session-shared', 'running-thread', 'codex', 'stopped', '2026-08-01', '{}')`;
      yield* sql`INSERT INTO orchestration_v2_projection_provider_session_bindings
        (provider_session_id, thread_id)
        VALUES ('session-shared', 'running-thread'), ('session-shared', 'stopped-thread')`;
      yield* sql`INSERT INTO orchestration_v2_projection_context_transfers
        (context_transfer_id, source_thread_id, target_thread_id, type, status, updated_at, payload_json)
        VALUES ('transfer-1', 'archived-thread', 'stopped-thread', 'provider_handoff', 'completed', '2026-08-01', '{}')`;
      yield* sql`INSERT INTO scheduled_tasks
        (task_id, title, prompt, enabled, schedule_json, project_id, workspace_strategy_json,
          model_selection_json, runtime_mode, interaction_mode, created_by, creation_source,
          created_at, updated_at, last_run_status, run_count)
        VALUES ('task-1', 'Nightly', 'Run it', 1, '{}', 'project-kept', '{}', '{}',
          'full-access', 'default', 'user', 'user', '2026-08-01', '2026-08-01', 'never', 0)`;
      yield* sql`INSERT INTO scheduled_task_webhook_replay_keys
        (task_id, replay_key, delivery_id, expires_at)
        VALUES ('task-1', 'replay-1', 'delivery-1', 1900000000000)`;
      yield* sql`INSERT INTO scheduled_task_webhook_pending
        (delivery_id, task_id, coalesce_key, due_at, task_json, request_json, delivery_ids_json)
        VALUES ('delivery-1', 'task-1', 'key-1', 1900000000000, '{}', '{}', '[]')`;
      yield* sql`INSERT INTO auth_sessions (session_id, subject, scopes, method, issued_at, expires_at)
        VALUES ('session-1', 'user', '[]', 'pairing', '2026-08-01', '2027-08-01')`;
      if (toMigrationInclusive === undefined) {
        yield* insertPeerLink(sql);
        for (const [projectId, term] of [
          ["project-kept", "keptfactterm"],
          ["project-deleted", "droppedfactterm"],
        ] as const) {
          const factId = `fact-${projectId}`;
          yield* sql`INSERT INTO project_knowledge_facts
            (id, project_id, status, revision, content, entities_json, tags_json, kind, trust,
              created_at, updated_at, sources_json, origin_json)
            VALUES (${factId}, ${projectId}, 'saved', 1, ${`Remember ${term}`}, '[]', '[]',
              'decision', 1, '2026-08-01', '2026-08-01', '[]', '{}')`;
          yield* sql`INSERT INTO project_knowledge_fact_history
            (project_id, fact_id, revision, event, actor_json, content, sources_json, trust_after, created_at)
            VALUES (${projectId}, ${factId}, 1, 'created', '{}', ${`Remember ${term}`}, '[]', 1, '2026-08-01')`;
          yield* sql`INSERT INTO project_knowledge_commands
            (command_id, project_id, fact_id, request_digest)
            VALUES (${`command-${projectId}`}, ${projectId}, ${factId}, 'digest')`;
          yield* sql`INSERT INTO model_evaluation_resets (project_id, generation, reset_at)
            VALUES (${projectId}, 1, '2026-08-01')`;
        }
      }
    }),
  );
  return databasePath;
});

it.layer(NodeServices.layer)("migrate-dev-db", (it) => {
  it.effect("keeps stopped and settled thread families and clears pending work", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-src-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-dest-" });
      const source = yield* createFixtureSource(sourceDir);
      yield* withDatabase(
        source,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const item = {
            id: "tool-copy",
            threadId: "stopped-thread",
            runId: null,
            nodeId: null,
            providerThreadId: null,
            providerTurnId: null,
            nativeItemRef: null,
            parentItemId: null,
            ordinal: 1,
            status: "completed",
            title: null,
            startedAt: "2026-08-01T00:00:00.000Z",
            completedAt: "2026-08-01T00:00:00.000Z",
            updatedAt: "2026-08-01T00:00:00.000Z",
            type: "command_execution",
            input: "test",
            output: "copiedtoolterm",
            exitCode: 0,
          };
          yield* sql`INSERT INTO orchestration_v2_projection_turn_items
          (turn_item_id, thread_id, ordinal, type, status, updated_at, payload_json, inline_work_output)
          VALUES ('tool-copy', 'stopped-thread', 1, 'command_execution', 'completed',
            ${item.updatedAt}, ${JSON.stringify(item)}, 0)`;
          yield* sql`INSERT INTO orchestration_v2_tool_search(rowid, text)
          SELECT rowid, 'copiedtoolterm' FROM orchestration_v2_projection_turn_items WHERE turn_item_id = 'tool-copy'`;
          yield* sql`UPDATE orchestration_v2_tool_search_state
          SET cursor = (SELECT max(rowid) FROM orchestration_v2_projection_turn_items),
              backfill_end = (SELECT max(rowid) FROM orchestration_v2_projection_turn_items) WHERE id = 1`;
          for (const [summaryId, projectId, threadId, text, scrubbed] of [
            ["summary-kept", "project-kept", "stopped-thread", "keptsummaryterm", false],
            [
              "summary-dropped",
              "project-deleted",
              "deleted-project-thread",
              "droppedsummaryterm",
              false,
            ],
            ["summary-scrubbed", "project-kept", "stopped-thread", "scrubbedsummaryterm", true],
            [
              "summary-legacy-scrubbed",
              "project-kept",
              "stopped-thread",
              "[Source unavailable: removed or changed.]",
              false,
            ],
          ] as const) {
            yield* sql`INSERT INTO conversation_summaries
              (summary_id, project_id, thread_id, position, created_at, payload_json)
              VALUES (${summaryId}, ${projectId}, ${threadId}, '0', '2026-08-01',
                ${JSON.stringify({ statements: [{ text }], scrubbed })})`;
          }
          assert.deepEqual(
            yield* sql`SELECT text FROM conversation_summary_fts
              WHERE conversation_summary_fts MATCH 'keptsummaryterm'`,
            [{ text: "keptsummaryterm" }],
          );
        }),
      );

      const result = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 2 },
        { sharedHome: sourceDir },
      );

      assert.equal(result.databasePath, path.join(destDir, "userdata", "statev2.sqlite"));
      const kept = yield* withDatabase(
        result.databasePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          while (!(yield* backfillToolSearchBatch(sql))) {}
          const toolHits = yield* sql<{ id: string }>`SELECT items.turn_item_id AS id
            FROM orchestration_v2_tool_search AS search
            JOIN orchestration_v2_projection_turn_items AS items ON items.rowid = search.rowid
            WHERE orchestration_v2_tool_search MATCH 'copiedtoolterm'`;
          assert.deepEqual(
            toolHits.map((hit) => hit.id),
            ["tool-copy"],
          );
          const summaryHits = yield* sql<{ id: string }>`
            SELECT summary.summary_id AS id FROM conversation_summary_fts
            JOIN conversation_summary_search_ids AS ids ON ids.id = conversation_summary_fts.rowid
            JOIN conversation_summaries AS summary USING (summary_id)
            WHERE conversation_summary_fts MATCH 'keptsummaryterm'`;
          assert.deepEqual(
            summaryHits.map((hit) => hit.id),
            ["summary-kept"],
          );
          assert.deepEqual(yield* sql`SELECT text FROM conversation_summary_fts`, [
            { text: "keptsummaryterm" },
          ]);
          const threads = yield* sql<{ thread_id: string }>`
            SELECT thread_id FROM orchestration_v2_projection_threads ORDER BY thread_id`;
          const events = yield* sql<{ stream_id: string }>`
            SELECT stream_id FROM orchestration_events ORDER BY stream_id`;
          const sessions = yield* sql<{ provider_session_id: string }>`
            SELECT provider_session_id FROM orchestration_v2_projection_provider_sessions`;
          const [pullRequest] = yield* sql<{ url: string | null; watch: string | null }>`
            SELECT
              json_extract(payload_json, '$.pullRequests[0].url') AS url,
              json_extract(payload_json, '$.pullRequests[0].watch') AS watch
            FROM orchestration_v2_projection_threads WHERE thread_id = 'stopped-thread'`;
          const [project] = yield* sql<{ scripts_json: string }>`
            SELECT scripts_json FROM projection_projects WHERE project_id = 'project-kept'`;
          const [leftovers] = yield* sql<{
            auth: number;
            tasks: number;
            webhooks: number;
            transfers: number;
            links: number;
          }>`
            SELECT
              (SELECT COUNT(*) FROM auth_sessions) AS auth,
              (SELECT COUNT(*) FROM scheduled_tasks) AS tasks,
              (SELECT COUNT(*) FROM scheduled_task_webhook_replay_keys) +
                (SELECT COUNT(*) FROM scheduled_task_webhook_pending) AS webhooks,
              (SELECT COUNT(*) FROM orchestration_v2_projection_context_transfers) AS transfers,
              (SELECT COUNT(*) FROM peer_environment_links) AS links`;
          const projectTables = yield* sql<{ name: string }>`
            SELECT m.name FROM sqlite_master m, pragma_table_info(m.name) c
            WHERE m.type = 'table' AND c.name = 'project_id' ORDER BY m.name`;
          const projectRows: Record<string, ReadonlyArray<string>> = {};
          for (const { name } of projectTables) {
            const rows = yield* sql.unsafe<{ project_id: string }>(
              `SELECT DISTINCT project_id FROM "${name}" ORDER BY project_id`,
            ).unprepared;
            if (rows.length > 0) projectRows[name] = rows.map((row) => row.project_id);
          }
          const searched = yield* sql<{ id: string }>`
            SELECT f.id FROM project_knowledge_fts
            JOIN project_knowledge_facts f ON f.rowid = project_knowledge_fts.rowid
            WHERE project_knowledge_fts MATCH 'keptfactterm'`;
          // FTS5 keeps a deleted row's terms in older segments until they merge.
          const [dropped] = yield* sql<{ blocks: number }>`
            SELECT COUNT(*) AS blocks FROM project_knowledge_fts_data
            WHERE instr(block, CAST('droppedfactterm' AS BLOB)) > 0`;
          const factSearch = {
            found: searched.map((row) => row.id),
            droppedBlocks: dropped?.blocks,
          };
          return {
            threads,
            events,
            sessions,
            pullRequest,
            project,
            leftovers,
            projectRows,
            factSearch,
          };
        }),
      );
      assert.deepStrictEqual(
        kept.threads.map((row) => row.thread_id),
        ["fork-thread", "settled-thread", "stopped-thread"],
      );
      assert.deepStrictEqual(
        kept.events.map((row) => row.stream_id),
        ["fork-thread", "settled-thread", "stopped-thread"],
      );
      assert.deepStrictEqual(
        kept.sessions.map((row) => row.provider_session_id),
        ["session-shared"],
      );
      assert.deepStrictEqual(
        kept.pullRequest,
        { url: "https://github.com/owner/repo/pull/7", watch: null },
        "copied pull request links keep their history but stop being watched",
      );
      assert.deepStrictEqual(
        JSON.parse(kept.project?.scripts_json ?? "[]"),
        [
          {
            id: "lint",
            name: "Lint",
            command: "vp lint",
            icon: "lint",
            runOnWorktreeCreate: false,
          },
          {
            id: "teardown",
            name: "Teardown",
            command: "./teardown",
            icon: "configure",
            runOnWorktreeCreate: false,
          },
        ],
        "copied project scripts stay listed but never run on settle in the original checkout",
      );
      assert.deepStrictEqual(kept.leftovers, {
        auth: 0,
        tasks: 0,
        webhooks: 0,
        transfers: 0,
        links: 0,
      });
      // Asserted across whatever tables carry a project, so a later migration's table is covered.
      assert.deepStrictEqual(
        [...new Set(Object.values(kept.projectRows).flat())],
        ["project-kept"],
        "rows of a dropped project go with it",
      );
      for (const table of [
        "model_evaluation_resets",
        "project_knowledge_commands",
        "project_knowledge_fact_history",
        "project_knowledge_facts",
      ]) {
        assert.deepStrictEqual(
          kept.projectRows[table],
          ["project-kept"],
          `${table} keeps its rows`,
        );
      }
      assert.deepStrictEqual(
        kept.factSearch,
        { found: ["fact-project-kept"], droppedBlocks: 0 },
        "fact search finds kept facts and its index holds nothing of dropped ones",
      );
    }),
  );

  it.effect("drops resumable families from a seed in place, the pending steer included", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-resumable-" });
      const sharedHome = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-home-" });
      const database = yield* createFixtureSource(dir);

      assert.equal(yield* dropResumableFamilies(database, { sharedHome }), 4);
      const { threads, sessions } = yield* withDatabase(
        database,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return {
            threads: yield* sql<{ thread_id: string }>`
              SELECT thread_id FROM orchestration_v2_projection_threads ORDER BY thread_id`,
            sessions: yield* sql<{ provider_session_id: string }>`
              SELECT provider_session_id FROM orchestration_v2_projection_provider_sessions`,
          };
        }),
      );
      assert.deepStrictEqual(
        threads.map((row) => row.thread_id),
        [
          "archived-thread",
          "deleted-project-thread",
          "fork-thread",
          "settled-thread",
          "stopped-thread",
        ],
      );
      assert.deepStrictEqual(
        sessions.map((row) => row.provider_session_id),
        ["session-shared"],
        "a session the kept stopped-thread still binds stays with it",
      );
      assert.equal(yield* dropResumableFamilies(database, { sharedHome }), 0);
    }),
  );

  it.effect("refuses to drop from the shared database through a symlink or a hard link", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sharedHome = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-shared-" });
      const elsewhere = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-link-" });
      const fixture = yield* createFixtureSource(sharedHome);
      const live = path.join(sharedHome, "userdata", "statev2.sqlite");
      yield* fs.makeDirectory(path.dirname(live), { recursive: true });
      yield* fs.rename(fixture, live);
      const symlink = path.join(elsewhere, "statev2.sqlite");
      yield* fs.symlink(live, symlink);
      // A hard link has its own path; only the file's identity gives it away.
      const hardLink = path.join(elsewhere, "copy.sqlite");
      yield* fs.link(live, hardLink);

      for (const link of [symlink, hardLink]) {
        const refused = yield* Effect.flip(dropResumableFamilies(link, { sharedHome }));
        assert.equal(refused._tag, "MigrateDevDbSharedHomeError", link);
      }
      const threads = yield* withDatabase(
        live,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const [row] = yield* sql<{ n: number }>`
            SELECT COUNT(*) AS n FROM orchestration_v2_projection_threads`;
          return Number(row?.n ?? 0);
        }),
      );
      assert.equal(threads, 10, "the shared database is untouched");
    }),
  );

  it.effect("never copies an archived thread, and new events append after the source's", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-slice-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-slice-dest-" });
      const source = yield* createFixtureSource(sourceDir);
      const [sourceSequence] = yield* withDatabase(
        source,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<{ seq: number }>`
            SELECT seq FROM sqlite_sequence WHERE name = 'orchestration_events'`;
        }),
      );

      const result = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 100 },
        { sharedHome: sourceDir },
      );

      const copied = yield* withDatabase(
        result.databasePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const [archivedRows] = yield* sql<{ count: number }>`
            SELECT
              (SELECT COUNT(*) FROM orchestration_v2_projection_runs WHERE thread_id = 'archived-thread')
              + (SELECT COUNT(*) FROM orchestration_events WHERE stream_id = 'archived-thread')
              AS count`;
          const [sequence] = yield* sql<{ seq: number }>`
            SELECT seq FROM sqlite_sequence WHERE name = 'orchestration_events'`;
          return { archivedRows: archivedRows?.count, sequence: sequence?.seq };
        }),
      );
      assert.equal(copied.archivedRows, 0);
      assert.equal(copied.sequence, sourceSequence?.seq);
    }),
  );

  it.effect("skips a thread family larger than the per-project limit", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-family-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-family-dest-" });
      const source = yield* createFixtureSource(sourceDir);

      // stopped-thread and its fork are 2 threads; settled-thread is 1.
      const result = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 1 },
        { sharedHome: sourceDir },
      );
      const threads = yield* withDatabase(
        result.databasePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<{ thread_id: string }>`
            SELECT thread_id FROM orchestration_v2_projection_threads`;
        }),
      );
      assert.deepStrictEqual(
        threads.map((row) => row.thread_id),
        ["settled-thread"],
      );
    }),
  );

  it.effect("upgrades a source from before the V2 thread tables", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-v1-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-v1-dest-" });
      const stateDir = path.join(sourceDir, "userdata");
      const source = path.join(stateDir, "statev2.sqlite");
      yield* fs.makeDirectory(stateDir, { recursive: true });
      yield* withDatabase(source, runMigrations({ toMigrationInclusive: 54 }));

      const result = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 10 },
        { sharedHome: sourceDir },
      );
      assert.include(result.executedMigrations, "55_OrchestrationV2");
    }),
  );

  // The server imports V1 threads at boot, not in a migration, so a source can
  // reach the V2 schema with its legacy threads still unimported.
  it.effect.each([
    { name: "a pre-V2 source", migrateToLatest: false },
    { name: "a V2 source whose legacy threads were never imported", migrateToLatest: true },
  ])("refuses $name", ({ migrateToLatest }) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-v1-data-" });
      const destDir = yield* fs.makeTempDirectoryScoped({
        prefix: "migrate-dev-db-v1-data-dest-",
      });
      const stateDir = path.join(sourceDir, "userdata");
      const source = path.join(stateDir, "statev2.sqlite");
      yield* fs.makeDirectory(stateDir, { recursive: true });
      yield* withDatabase(
        source,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* runMigrations({ toMigrationInclusive: 54 });
          yield* sql`INSERT INTO projection_projects
            (project_id, title, workspace_root, scripts_json, created_at, updated_at)
            VALUES ('project-legacy', 'Legacy', '/tmp/legacy', '[]', '2026-08-01', '2026-08-01')`;
          yield* sql`INSERT INTO projection_threads
            (thread_id, project_id, title, model_selection_json, runtime_mode, created_at, updated_at)
            VALUES ('thread-legacy', 'project-legacy', 'Legacy thread',
              '{"instanceId":"codex","model":"gpt-5.4"}', 'full-access', '2026-08-01', '2026-08-01')`;
          if (migrateToLatest) yield* runMigrations();
        }),
      );

      // A live destination connection keeps uncheckpointed rows in the WAL;
      // the rejected run must leave those bytes alone.
      const destination = yield* createFixtureSource(destDir);
      yield* withDatabase(
        destination,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql.unsafe("PRAGMA journal_mode = WAL").unprepared;
          yield* sql`UPDATE projection_projects SET title = 'Edited' WHERE project_id = 'project-kept'`;
          const walBefore = yield* fs.readFile(`${destination}-wal`);
          assert.isAbove(walBefore.length, 0);

          const error = yield* runMigrateDevDb(
            { baseDir: destDir, source, projects: 5, threadsPerProject: 10 },
            { sharedHome: sourceDir },
          ).pipe(Effect.flip);
          assert.equal(error._tag, "MigrateDevDbLegacySourceError");
          assert.deepStrictEqual(yield* fs.readFile(`${destination}-wal`), walBefore);
        }),
      );
    }),
  );

  it.effect("seeds from a source that recorded another migration below V2", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-local-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-local-dest-" });
      const source = yield* createFixtureSource(sourceDir);
      yield* withDatabase(
        source,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE effect_sql_migrations SET name = 'SiteLocalMigration'
            WHERE migration_id = 51`;
        }),
      );

      const result = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 2 },
        { sharedHome: sourceDir },
      );
      const threads = yield* withDatabase(
        result.databasePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          return yield* sql<{ thread_id: string }>`
            SELECT thread_id FROM orchestration_v2_projection_threads ORDER BY thread_id`;
        }),
      );
      assert.deepStrictEqual(
        threads.map((row) => row.thread_id),
        ["fork-thread", "settled-thread", "stopped-thread"],
      );
    }),
  );

  it.effect("refuses a source whose V2 migration history clashes with this checkout", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-clash-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-clash-dest-" });
      const source = yield* createFixtureSource(sourceDir);
      yield* withDatabase(
        source,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`UPDATE effect_sql_migrations SET name = 'OtherBuildMigration'
            WHERE migration_id = 60`;
        }),
      );

      const destination = yield* createFixtureSource(destDir);
      const sourceBefore = yield* fs.readFile(source);
      const destinationBefore = yield* fs.readFile(destination);

      const error = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 2 },
        { sharedHome: sourceDir },
      ).pipe(Effect.flip);
      assert.equal(error._tag, "MigrateDevDbPhaseError");
      if (error._tag === "MigrateDevDbPhaseError") {
        assert.equal(error.phase, "migrate");
        assert.include(String(error.cause), "60_ThreadSnapshotWindowIndexes");
      }
      assert.deepStrictEqual(yield* fs.readFile(source), sourceBefore);
      assert.deepStrictEqual(yield* fs.readFile(destination), destinationBefore);
    }),
  );

  it.effect("imports a dev seed whose ids after 67 came from the peer links branch", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-peer-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-peer-dest-" });
      const source = yield* createFixtureSource(sourceDir, 67);
      // Mirrors a real ~/.t3 seed written by a build whose 68-70 differ from main's.
      yield* withDatabase(
        source,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          yield* sql`CREATE TABLE peer_environment_links (
            environment_id TEXT PRIMARY KEY,
            secret_name TEXT NOT NULL,
            label TEXT NOT NULL,
            urls_json TEXT NOT NULL,
            access TEXT NOT NULL,
            linked_at TEXT NOT NULL,
            expires_at TEXT NOT NULL,
            last_reached_at TEXT,
            last_error TEXT,
            fenced INTEGER NOT NULL DEFAULT 0)`;
          yield* sql`CREATE INDEX orchestration_v2_projection_turn_items_waiting_link_idx
            ON orchestration_v2_projection_turn_items(thread_id, updated_at DESC, turn_item_id DESC)
            WHERE type = 'link_request' AND status = 'waiting'`;
          yield* insertPeerLink(sql);
          yield* sql`INSERT INTO effect_sql_migrations (migration_id, name) VALUES
            (68, 'PeerLinks'), (69, 'PeerLinkFence'), (70, 'WaitingLinkRequestIndex')`;
        }),
      );

      const result = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 2 },
        { sharedHome: sourceDir },
      );

      const imported = yield* withDatabase(
        result.databasePath,
        Effect.gen(function* () {
          const sql = yield* SqlClient.SqlClient;
          const threads = yield* sql<{ thread_id: string }>`
            SELECT thread_id FROM orchestration_v2_projection_threads ORDER BY thread_id`;
          const schema = yield* sql<{ name: string }>`
            SELECT name FROM sqlite_master WHERE name IN (
              'orchestration_v2_projection_turn_items_stop_request_idx',
              'orchestration_v2_message_search')
            ORDER BY name`;
          return { threads, schema };
        }),
      );
      assert.deepStrictEqual(
        imported.threads.map((row) => row.thread_id),
        ["fork-thread", "settled-thread", "stopped-thread"],
      );
      assert.deepStrictEqual(
        imported.schema.map((row) => row.name),
        [
          "orchestration_v2_message_search",
          "orchestration_v2_projection_turn_items_stop_request_idx",
        ],
      );
    }),
  );

  it.effect("refuses while a dev server holds the destination", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-busy-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-busy-dest-" });
      const source = yield* createFixtureSource(sourceDir);
      const stateDir = path.join(destDir, "userdata");
      yield* fs.makeDirectory(stateDir, { recursive: true });
      yield* fs.writeFileString(
        path.join(stateDir, "server-runtime.json"),
        `{"version":1,"pid":${process.pid}}`,
      );

      const error = yield* runMigrateDevDb(
        { baseDir: destDir, source, projects: 5, threadsPerProject: 10 },
        { sharedHome: sourceDir },
      ).pipe(Effect.flip);
      assert.equal(error._tag, "MigrateDevDbServerRunningError");
      if (error._tag === "MigrateDevDbServerRunningError") {
        assert.equal(error.pid, process.pid);
      }
    }),
  );

  it.effect("refuses a source that resolves to a destination path", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sharedDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-overlap-" });
      const destDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-overlap-dest-" });
      const leftoverSnapshot = path.join(destDir, "userdata", "statev2.sqlite.migrate-dev-db-tmp");
      yield* fs.makeDirectory(path.dirname(leftoverSnapshot), { recursive: true });
      yield* fs.writeFileString(leftoverSnapshot, "not a real db");

      const error = yield* runMigrateDevDb(
        { baseDir: destDir, source: leftoverSnapshot, projects: 5, threadsPerProject: 10 },
        { sharedHome: sharedDir },
      ).pipe(Effect.flip);
      assert.equal(error._tag, "MigrateDevDbSourceIsDestinationError");
      assert.equal(yield* fs.exists(leftoverSnapshot), true);
    }),
  );

  it.effect("refuses to rebuild the shared home", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const sourceDir = yield* fs.makeTempDirectoryScoped({ prefix: "migrate-dev-db-shared-" });
      const source = yield* createFixtureSource(sourceDir);

      const error = yield* runMigrateDevDb(
        { baseDir: sourceDir, source, projects: 5, threadsPerProject: 10 },
        { sharedHome: sourceDir },
      ).pipe(Effect.flip);
      assert.equal(error._tag, "MigrateDevDbSharedHomeError");
    }),
  );
});
