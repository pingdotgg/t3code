import { assert, describe, it } from "@effect/vitest";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";

type DeliveryRow = {
  readonly epoch: number;
  readonly delivery_epoch: number;
  readonly delivery_settled: number;
  readonly delivery_archived: number;
  readonly delivery_deleted: number;
};

type MailStateRow = {
  readonly mail_revision: number;
  readonly retained_message_count: number;
  readonly retained_body_bytes: number;
};

const insertCitizen = Effect.fn("066.test.insertCitizen")(function* (input: {
  readonly threadId: string;
  readonly projectId: string;
  readonly epoch: number;
  readonly deleted?: boolean | undefined;
}) {
  const sql = yield* SqlClient.SqlClient;
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
      ${input.threadId}, ${input.projectId}, NULL, NULL, ${input.threadId},
      0, 'resolved', 0, 1, 1,
      'ada', 1, 'Ada', ${input.threadId}, ${input.threadId}, 'default-names',
      0, 0,
      'calm', 'Calm', '[]', '', 'default-profiles',
      0, 0,
      0, NULL, NULL, 'Mail',
      NULL, NULL, NULL,
      ${input.epoch}, 1, ${input.deleted === true ? 1 : 0}, 1, datetime('now'), datetime('now')
    )
  `;
});

describe("066_CivilizationMail", () => {
  it.effect("adds an independent delivery epoch and backfills lifecycle component bits", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 65 });
      const projectId = "project:civilization:mail:lifecycle";
      const threadId = "thread:civilization:mail:lifecycle";

      yield* sql`
        INSERT INTO orchestration_v2_projection_threads (
          thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
          active_provider_thread_id, created_at, updated_at, archived_at, deleted_at, payload_json
        ) VALUES (
          ${threadId}, ${projectId}, 'Mail lifecycle', 'codex', 'full-access', 'default',
          NULL, datetime('now'), datetime('now'), datetime('now'), NULL,
          ${JSON.stringify({ settledOverride: null, settledAt: "2026-10-16T10:00:00.000Z" })}
        )
      `;
      yield* insertCitizen({ threadId, projectId, epoch: 7 });

      yield* runMigrations({ toMigrationInclusive: 66 });
      const row = (yield* sql<DeliveryRow>`
        SELECT epoch, delivery_epoch, delivery_settled, delivery_archived, delivery_deleted
        FROM civilization_citizens WHERE thread_id = ${threadId}
      `)[0]!;
      assert.deepStrictEqual(row, {
        epoch: 7,
        delivery_epoch: 7,
        delivery_settled: 1,
        delivery_archived: 1,
        delivery_deleted: 0,
      });

      yield* sql`
        UPDATE civilization_citizens
        SET delivery_epoch = delivery_epoch + 1,
            delivery_deleted = 1
        WHERE thread_id = ${threadId}
      `;
      const advanced = (yield* sql<DeliveryRow>`
        SELECT epoch, delivery_epoch, delivery_settled, delivery_archived, delivery_deleted
        FROM civilization_citizens WHERE thread_id = ${threadId}
      `)[0]!;
      assert.equal(advanced.epoch, 7, "delivery lifecycle must not mutate citizen epoch");
      assert.equal(advanced.delivery_epoch, 8);
      assert.equal(advanced.delivery_deleted, 1);
    }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );

  it.effect(
    "persists bounded immutable mail, revisions/capacity, receipts, quotas and inbox provenance",
    () =>
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        yield* runMigrations({ toMigrationInclusive: 66 });
        const projectId = "project:civilization:mail:schema";

        yield* sql`
        INSERT INTO civilization_messages (
          message_id, project_id, sender_thread_id, sender_name_at_send,
          sender_citizen_epoch, sender_run_id, recipient_thread_id, recipient_delivery_epoch,
          reply_to_message_id, body, body_bytes,
          accepted_runtime_mode, accepted_interaction_mode,
          accepted_environment_revision, accepted_project_revision,
          accepted_at, expires_at, terminal_retention_days, first_offered_at, last_offered_at, offer_count,
          acknowledged_at, terminal_at, terminal_reason
        ) VALUES (
          'mail:one', ${projectId}, 'thread:sender', 'Ada',
          2, 'run:sender', 'thread:recipient', 4,
          NULL, 'hello', 5,
          'auto-accept-edits', 'plan', 3, 5,
          '2026-10-16T10:00:00.000Z', '2026-11-15T10:00:00.000Z', 30, NULL, NULL, 0,
          NULL, NULL, NULL
        )
      `;
        assert.deepStrictEqual(
          (yield* sql<MailStateRow>`
          SELECT mail_revision, retained_message_count, retained_body_bytes
          FROM civilization_project_state WHERE project_id = ${projectId}
        `)[0],
          { mail_revision: 1, retained_message_count: 1, retained_body_bytes: 5 },
        );

        yield* sql`
        UPDATE civilization_messages
        SET first_offered_at = '2026-10-16T10:01:00.000Z',
            last_offered_at = '2026-10-16T10:01:00.000Z',
            offer_count = 1
        WHERE message_id = 'mail:one'
      `;
        assert.deepStrictEqual(
          (yield* sql<MailStateRow>`SELECT mail_revision, retained_message_count, retained_body_bytes
          FROM civilization_project_state WHERE project_id = ${projectId}`)[0],
          { mail_revision: 2, retained_message_count: 1, retained_body_bytes: 5 },
        );

        const mutateBody = yield* Effect.exit(sql`
        UPDATE civilization_messages SET body = 'changed', body_bytes = 7 WHERE message_id = 'mail:one'
      `);
        assert.isTrue(Exit.isFailure(mutateBody));

        const mutateRetention = yield* Effect.exit(sql`
        UPDATE civilization_messages SET terminal_retention_days = 1 WHERE message_id = 'mail:one'
      `);
        assert.isTrue(Exit.isFailure(mutateRetention));

        const oversized = "x".repeat(16 * 1024 + 1);
        const oversizedInsert = yield* Effect.exit(sql`
        INSERT INTO civilization_messages (
          message_id, project_id, sender_thread_id, sender_name_at_send,
          sender_citizen_epoch, sender_run_id, recipient_thread_id, recipient_delivery_epoch,
          body, body_bytes, accepted_runtime_mode, accepted_interaction_mode,
          accepted_environment_revision, accepted_project_revision, accepted_at, expires_at, terminal_retention_days
        ) VALUES (
          'mail:oversized', ${projectId}, 'thread:a', 'A', 0, 'run:a', 'thread:b', 0,
          ${oversized}, ${Buffer.byteLength(oversized, "utf8")}, 'full-access', 'default',
          0, 0, datetime('now'), datetime('now', '+30 days'), 30
        )
      `);
        assert.isTrue(Exit.isFailure(oversizedInsert));

        yield* sql`
        INSERT INTO civilization_mail_operation_receipts (
          project_id, actor_thread_id, actor_citizen_epoch, operation_kind,
          client_request_id, canonical_payload_hash, result_message_id, created_at, expires_at
        ) VALUES (
          ${projectId}, 'thread:sender', 2, 'send', 'request:1', 'sha256:payload', 'mail:one',
          datetime('now'), datetime('now', '+30 days')
        )
      `;
        const duplicateReceipt = yield* Effect.exit(sql`
        INSERT INTO civilization_mail_operation_receipts (
          project_id, actor_thread_id, actor_citizen_epoch, operation_kind,
          client_request_id, canonical_payload_hash, result_message_id, created_at, expires_at
        ) VALUES (
          ${projectId}, 'thread:sender', 2, 'send', 'request:1', 'sha256:other', 'mail:two',
          datetime('now'), datetime('now', '+30 days')
        )
      `);
        assert.isTrue(Exit.isFailure(duplicateReceipt));

        yield* sql`
        INSERT INTO civilization_mail_quota_windows (
          project_id, scope_kind, scope_id, window_start_minute, accepted_count, updated_at
        ) VALUES (${projectId}, 'sender', 'thread:sender', '2026-10-16T10:00:00Z', 1, datetime('now'))
      `;
        const duplicateWindow = yield* Effect.exit(sql`
        INSERT INTO civilization_mail_quota_windows (
          project_id, scope_kind, scope_id, window_start_minute, accepted_count, updated_at
        ) VALUES (${projectId}, 'sender', 'thread:sender', '2026-10-16T10:00:00Z', 1, datetime('now'))
      `);
        assert.isTrue(Exit.isFailure(duplicateWindow));

        const contextColumns = yield* sql<{
          readonly name: string;
        }>`PRAGMA table_info(civilization_context_references)`;
        assert.include(
          contextColumns.map((column) => column.name),
          "inbox_revision",
        );
        const projectStateColumns = yield* sql<{
          readonly name: string;
        }>`PRAGMA table_info(civilization_project_state)`;
        assert.include(
          projectStateColumns.map((column) => column.name),
          "last_mail_cleanup_at",
        );
        const indexes = yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'index' AND name LIKE 'civilization_mail%'
           OR type = 'index' AND name LIKE 'civilization_messages%'
      `;
        assert.includeMembers(
          indexes.map((row) => row.name),
          [
            "civilization_messages_project_capacity_idx",
            "civilization_messages_recipient_epoch_pending_idx",
            "civilization_mail_receipts_expiry_idx",
            "civilization_mail_quota_window_idx",
          ],
        );

        yield* sql`DELETE FROM civilization_messages WHERE message_id = 'mail:one'`;
        assert.deepStrictEqual(
          (yield* sql<MailStateRow>`
          SELECT mail_revision, retained_message_count, retained_body_bytes
          FROM civilization_project_state WHERE project_id = ${projectId}
        `)[0],
          { mail_revision: 3, retained_message_count: 0, retained_body_bytes: 0 },
        );
      }).pipe(Effect.provide(NodeSqliteClient.layer({ filename: ":memory:" }))),
  );
});
