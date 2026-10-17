import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

type ProjectStateRow = {
  readonly census_revision: number;
  readonly notes_revision: number;
};

const readProjectState = (projectId: string) =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return (yield* sql<ProjectStateRow>`
        SELECT census_revision, notes_revision
        FROM civilization_project_state
        WHERE project_id = ${projectId}
      `)[0];
  });

describe("065_CivilizationKnowledge", () => {
  it.effect("bumps project census and notes revisions from table triggers", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 65 });

      const projectId = "project:civilization:knowledge";
      const threadId = "thread:civilization:knowledge";
      yield* sql`
        INSERT INTO civilization_citizens (
          thread_id, project_id, parent_thread_id, relationship_to_parent, root_thread_id,
          generation, lineage_status, observed_only, birth_sequence, last_applied_sequence,
          name_entry_id, name_generator_version, name_base, name_display, name_key, name_pool_id,
          name_environment_revision, name_project_revision,
          profile_entry_id, profile_label, profile_traits_json, profile_style_text, profile_pool_id,
          profile_environment_revision, profile_project_revision,
          title_managed, preserved_title, last_managed_title, title_topic,
          pending_title_command_id, pending_managed_title, pending_title_topic,
          epoch, closed, deleted, revision, created_at, updated_at
        ) VALUES (
          ${threadId}, ${projectId}, NULL, NULL, ${threadId},
          0, 'resolved', 0, 1, 1,
          'ada', 1, 'Ada', 'Ada', 'ada', 'default-names',
          0, 0,
          'calm', 'Calm', '[]', '', 'default-profiles',
          0, 0,
          0, NULL, NULL, 'Knowledge',
          NULL, NULL, NULL,
          0, 0, 0, 1, datetime('now'), datetime('now')
        )
      `;
      assert.deepStrictEqual(yield* readProjectState(projectId), {
        census_revision: 1,
        notes_revision: 0,
      });

      yield* sql`
        UPDATE civilization_citizens
        SET name_display = 'Ada Updated', revision = revision + 1, updated_at = datetime('now')
        WHERE thread_id = ${threadId}
      `;
      assert.strictEqual((yield* readProjectState(projectId))?.census_revision, 2);

      yield* sql`
        UPDATE civilization_citizens
        SET last_applied_sequence = last_applied_sequence + 1, updated_at = datetime('now')
        WHERE thread_id = ${threadId}
      `;
      assert.strictEqual(
        (yield* readProjectState(projectId))?.census_revision,
        2,
        "watermark-only updates must not invalidate census cursors",
      );

      yield* sql`
        INSERT INTO civilization_notes (
          note_id, project_id, category, body, body_bytes, author_thread_id, author_epoch,
          accepted_runtime_mode, accepted_interaction_mode, source_refs_json,
          revision, created_at, updated_at, resolved_at
        ) VALUES (
          'note:1', ${projectId}, 'fact', 'alpha', 5, ${threadId}, 0,
          'full-access', 'default', '[]', 1, datetime('now'), datetime('now'), NULL
        )
      `;
      assert.strictEqual((yield* readProjectState(projectId))?.notes_revision, 1);

      yield* sql`
        UPDATE civilization_notes
        SET body = 'beta', body_bytes = 4, revision = revision + 1, updated_at = datetime('now')
        WHERE note_id = 'note:1'
      `;
      assert.strictEqual((yield* readProjectState(projectId))?.notes_revision, 2);

      yield* sql`DELETE FROM civilization_notes WHERE note_id = 'note:1'`;
      assert.strictEqual((yield* readProjectState(projectId))?.notes_revision, 3);

      yield* sql`DELETE FROM civilization_citizens WHERE thread_id = ${threadId}`;
      assert.strictEqual((yield* readProjectState(projectId))?.census_revision, 3);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect("keeps context references bounded to metadata", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 65 });
      const columns = yield* sql<{
        readonly name: string;
      }>`PRAGMA table_info(civilization_context_references)`;
      assert.notInclude(
        columns.map((column) => column.name),
        "text",
      );
      assert.notInclude(
        columns.map((column) => column.name),
        "body",
      );

      const oversized = yield* Effect.exit(sql`
        INSERT INTO civilization_context_references (
          context_reference_id, project_id, thread_id, run_id, attempt_id, provider_turn_ordinal,
          provider_instance_id, environment_revision, project_revision, citizen_revision,
          census_revision, notes_revision, packet_hash, packet_bytes,
          selected_citizen_ids_json, selected_note_ids_json, selected_inbox_ids_json, created_at
        ) VALUES (
          'context:oversized', 'project:1', 'thread:1', 'run:1', 'attempt:1', 1,
          'codex', 0, 0, 1, 0, 0, 'hash', 16385, '[]', '[]', '[]', datetime('now')
        )
      `);
      assert.isTrue(Exit.isFailure(oversized));
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
