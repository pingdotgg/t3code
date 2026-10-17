import { assert, it } from "@effect/vitest";
import {
  CIVILIZATION_CONFIG_VERSION,
  ProjectId,
  RunAttemptId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ConfigService from "./ConfigService.ts";
import * as OperationsService from "./OperationsService.ts";

const database = SqlitePersistence.layerMemory;
const projectId = ProjectId.make("project:civilization:operations");
const threadA = ThreadId.make("thread:civilization:operations:a");
const threadB = ThreadId.make("thread:civilization:operations:b");

const layer = (() => {
  const config = ConfigService.layer.pipe(Layer.provide(database));
  const operations = OperationsService.layer.pipe(Layer.provide(Layer.mergeAll(database, config)));
  return Layer.mergeAll(database, config, operations);
})();

const seedProject = Effect.fn("OperationsService.test.seedProject")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
    ) VALUES (
      ${projectId}, 'Operations project', '/tmp/operations', '[]',
      '2026-10-16T00:00:00.000Z', '2026-10-16T00:00:00.000Z', NULL
    )
  `;
  yield* sql`
    INSERT INTO civilization_project_config (project_id, revision, override_json, updated_at)
    VALUES (${projectId}, 1, ${JSON.stringify({ version: CIVILIZATION_CONFIG_VERSION, participation: { enabled: true } })}, '2026-10-16T00:00:00.000Z')
  `;
});

const seedCitizen = Effect.fn("OperationsService.test.seedCitizen")(function* (
  threadId: ThreadId,
  name: string,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO civilization_citizens (
      thread_id, project_id, parent_thread_id, relationship_to_parent, root_thread_id,
      generation, lineage_status, observed_only, birth_sequence, last_applied_sequence,
      name_entry_id, name_generator_version, name_base, name_display, name_key, name_pool_id,
      name_environment_revision, name_project_revision,
      profile_entry_id, profile_label, profile_traits_json, profile_style_text, profile_pool_id,
      profile_rich_label, profile_rich_traits_json, profile_rich_axiom, profile_rich_voice, profile_rich_style_text,
      profile_environment_revision, profile_project_revision,
      title_managed, preserved_title, last_managed_title, title_topic,
      pending_title_command_id, pending_managed_title, pending_title_topic,
      epoch, closed, deleted, revision, created_at, updated_at,
      delivery_epoch, delivery_settled, delivery_archived, delivery_deleted
    ) VALUES (
      ${threadId}, ${projectId}, NULL, NULL, ${threadId},
      0, 'resolved', 0, 1, 1,
      ${`name:${threadId}`}, 1, ${name}, ${name}, ${name.toLowerCase()}, 'pool',
      0, 1,
      ${`profile:${threadId}`}, 'Calm', '["calm"]', 'private style text', 'profiles',
      'Stoic Architect', '["deliberate","structural"]', 'Build carefully.', 'Measured and composed.', 'private rich style text',
      0, 1,
      1, 'Private original title', 'Private managed title', 'Private topic',
      NULL, NULL, NULL,
      0, 0, 0, 1, '2026-10-16T00:00:00.000Z', '2026-10-16T00:00:00.000Z',
      0, 0, 0, 0
    )
  `;
});

const seedSensitiveData = Effect.fn("OperationsService.test.seedSensitiveData")(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* seedCitizen(threadA, "Ada Secret");
  yield* seedCitizen(threadB, "Grace Secret");
  yield* sql`
    INSERT INTO civilization_notes (
      note_id, project_id, category, body, body_bytes, author_thread_id, author_epoch,
      accepted_runtime_mode, accepted_interaction_mode, source_refs_json, revision,
      created_at, updated_at, resolved_at
    ) VALUES
      ('note:one', ${projectId}, 'fact', 'note-body-one', 13, ${threadA}, 0, 'full-access', 'default', '[{"kind":"thread","reference":"private-source"}]', 1, '2026-10-16T00:00:00.000Z', '2026-10-16T00:00:00.000Z', NULL),
      ('note:two', ${projectId}, 'fact', 'two', 3, ${threadB}, 0, 'full-access', 'default', '[]', 1, '2026-10-16T00:00:00.000Z', '2026-10-16T00:00:00.000Z', NULL)
  `;
  yield* sql`
    INSERT INTO civilization_messages (
      message_id, project_id, sender_thread_id, sender_name_at_send, sender_citizen_epoch,
      sender_run_id, recipient_thread_id, recipient_delivery_epoch, reply_to_message_id,
      body, body_bytes, accepted_runtime_mode, accepted_interaction_mode,
      accepted_environment_revision, accepted_project_revision, accepted_at, expires_at,
      terminal_retention_days, first_offered_at, last_offered_at, offer_count,
      acknowledged_at, terminal_at, terminal_reason
    ) VALUES
      ('mail:one', ${projectId}, ${threadA}, 'Ada Secret', 0, 'run:a', ${threadB}, 0, NULL,
       'mail-body-one', 13, 'full-access', 'default', 0, 1,
       '2026-10-16T00:00:00.000Z', '2026-11-16T00:00:00.000Z', 30, NULL, NULL, 0, NULL, NULL, NULL),
      ('mail:two', ${projectId}, ${threadB}, 'Grace Secret', 0, 'run:b', ${threadA}, 0, NULL,
       'mail-two', 8, 'full-access', 'default', 0, 1,
       '2026-10-16T00:00:01.000Z', '2026-11-16T00:00:00.000Z', 30, NULL, NULL, 0, NULL, NULL, NULL)
  `;
  yield* sql`
    INSERT INTO civilization_context_references (
      context_reference_id, project_id, thread_id, run_id, attempt_id, provider_turn_ordinal,
      provider_instance_id, environment_revision, project_revision, citizen_revision,
      census_revision, notes_revision, inbox_revision, packet_hash, packet_bytes,
      selected_citizen_ids_json, selected_note_ids_json, selected_inbox_ids_json, created_at
    ) VALUES (
      'context:secret', ${projectId}, ${threadA}, ${RunId.make("run:context")}, ${RunAttemptId.make("attempt:context")}, 1,
      'codex', 0, 1, 1, 2, 2, 2, 'sha256:privatehash', 42,
      '["thread:civilization:operations:b"]', '["note:one"]', '["mail:one"]', '2026-10-16T00:00:00.000Z'
    )
  `;
  yield* sql`
    INSERT INTO civilization_context_inspections (
      inspection_id, context_reference_id, project_id, thread_id, run_id, attempt_id,
      provider_turn_ordinal, provider_instance_id, provider_driver, outcome, diagnostics_mode,
      packet_text_state, packet_hash, packet_bytes, packet_text, packet_budget_bytes,
      created_at, updated_at
    ) VALUES (
      'inspection:secret', 'context:secret', ${projectId}, ${threadA}, 'run:inspection',
      'attempt:inspection', 1, 'codex', 'codex', 'provider_start_accepted', 'normal',
      'retained_normal', 'sha256:inspection-secret', 24, 'historical-packet-secret', 4096,
      '2026-10-16T00:00:00.000Z', '2026-10-16T00:00:00.000Z'
    )
  `;
  yield* sql`
    INSERT INTO civilization_mail_operation_receipts (
      project_id, actor_thread_id, actor_citizen_epoch, operation_kind,
      client_request_id, canonical_payload_hash, result_message_id, created_at, expires_at
    ) VALUES (${projectId}, ${threadA}, 0, 'send', 'request:secret', 'sha256:receipt', 'mail:one',
      '2026-10-16T00:00:00.000Z', '2026-11-16T00:00:00.000Z')
  `;
  yield* sql`
    INSERT INTO civilization_mail_quota_windows (
      project_id, scope_kind, scope_id, window_start_minute, accepted_count, updated_at
    ) VALUES (${projectId}, 'project', ${projectId}, '2026-10-16T00:00:00Z', 1, '2026-10-16T00:00:00.000Z')
  `;
});

const setup = Effect.gen(function* () {
  yield* seedProject();
  yield* seedSensitiveData();
});

const disableParticipation = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    UPDATE civilization_project_config
    SET revision = revision + 1,
        override_json = ${JSON.stringify({ version: CIVILIZATION_CONFIG_VERSION, participation: { enabled: false } })},
        updated_at = '2026-10-16T00:10:00.000Z'
    WHERE project_id = ${projectId}
  `;
});

it.effect(
  "exports a versioned credential-free inspection backup with retained bodies and limitations",
  () =>
    Effect.gen(function* () {
      const operations = yield* OperationsService.CivilizationOperationsService;
      yield* setup;
      const exported = yield* operations.exportProjectData(projectId);
      assert.equal(exported.schemaVersion, 1);
      assert.equal(exported.projectRevision, 1);
      assert.equal(exported.citizens.length, 2);
      assert.equal(exported.notes.length, 2);
      assert.equal(exported.mail.length, 2);
      assert.equal(exported.limitations.mode, "inspection_backup_only");
      assert.isTrue(exported.limitations.inspectionBackupOnly);
      assert.isFalse(exported.limitations.restorable);
      assert.include(exported.limitations.excluded, "provider-native content");
      assert.include(exported.limitations.excluded, "database backups");
      assert.include(
        exported.limitations.excluded,
        "historical Civilization context inspection records and packet bodies",
      );
      const serialized = JSON.stringify(exported);
      assert.include(serialized, "note-body-one");
      assert.include(serialized, "mail-body-one");
      assert.include(serialized, "private rich style text");
      assert.notInclude(serialized, "accessToken");
      assert.notInclude(serialized, "refreshToken");
      assert.notInclude(serialized, "providerCredential");
      assert.notInclude(serialized, "historical-packet-secret");
      assert.notInclude(serialized, "inspection:secret");
    }).pipe(Effect.provide(Layer.fresh(layer))),
);

it.effect("previews exact purge counts/body bytes and rejects a stale preview", () =>
  Effect.gen(function* () {
    const operations = yield* OperationsService.CivilizationOperationsService;
    const sql = yield* SqlClient.SqlClient;
    yield* setup;
    yield* disableParticipation;
    const preview = yield* operations.previewPurge(projectId);
    assert.deepEqual(preview.counts, {
      citizens: 2,
      notes: 2,
      noteBodyBytes: 16,
      messages: 2,
      messageBodyBytes: 21,
      contextReferences: 1,
      contextInspections: 1,
      receipts: 1,
      quotaWindows: 1,
      projectConfigRows: 1,
      projectStateRows: 1,
    });
    yield* sql`
      INSERT INTO civilization_notes (
        note_id, project_id, category, body, body_bytes, author_thread_id, author_epoch,
        accepted_runtime_mode, accepted_interaction_mode, source_refs_json, revision,
        created_at, updated_at, resolved_at
      ) VALUES ('note:raced', ${projectId}, 'fact', 'raced', 5, ${threadA}, 0, 'full-access', 'default', '[]', 1,
        '2026-10-16T00:00:02.000Z', '2026-10-16T00:00:02.000Z', NULL)
    `;
    const conflict = yield* operations
      .applyPurge({ projectId, expectedPreviewToken: preview.previewToken, batchSize: 10 })
      .pipe(Effect.flip);
    assert.equal((conflict as { readonly code?: string }).code, "civilization_purge_conflict");
  }).pipe(Effect.provide(Layer.fresh(layer))),
);

it.effect("requires live-project participation disabled before first purge apply", () =>
  Effect.gen(function* () {
    const operations = yield* OperationsService.CivilizationOperationsService;
    yield* setup;
    const preview = yield* operations.previewPurge(projectId);
    const conflict = yield* operations
      .applyPurge({ projectId, expectedPreviewToken: preview.previewToken, batchSize: 2 })
      .pipe(Effect.flip);
    assert.equal((conflict as { readonly code?: string }).code, "civilization_purge_conflict");
    assert.include(
      (conflict as { readonly message: string }).message,
      "Disable Civilization participation",
    );
  }).pipe(Effect.provide(Layer.fresh(layer))),
);

it.effect(
  "previews retention reductions, identifies newly eligible data, and applies horizons without deleting it",
  () =>
    Effect.gen(function* () {
      const operations = yield* OperationsService.CivilizationOperationsService;
      const sql = yield* SqlClient.SqlClient;
      yield* TestClock.setTime(
        DateTime.toEpochMillis(DateTime.makeUnsafe("2026-10-16T12:00:00.000Z")),
      );
      yield* setup;
      yield* sql`
        UPDATE civilization_project_config
        SET revision = 2,
            override_json = ${JSON.stringify({
              version: CIVILIZATION_CONFIG_VERSION,
              participation: { enabled: true },
              knowledge: { retentionDays: 7 },
              operations: { diagnosticRetentionDays: 1, tombstoneRetentionDays: 7 },
            })},
            updated_at = '2026-10-16T11:00:00.000Z'
        WHERE project_id = ${projectId}
      `;
      yield* sql`
        UPDATE civilization_notes
        SET resolved_at = '2026-10-01T12:00:00.000Z', updated_at = '2026-10-01T12:00:00.000Z'
        WHERE note_id = 'note:two'
      `;
      yield* sql`
        UPDATE civilization_context_references
        SET created_at = '2026-10-10T12:00:00.000Z'
        WHERE context_reference_id = 'context:secret'
      `;
      yield* sql`
        UPDATE civilization_context_inspections
        SET created_at = '2026-10-10T12:00:00.000Z', updated_at = '2026-10-10T12:00:00.000Z'
        WHERE inspection_id = 'inspection:secret'
      `;
      yield* sql`
        INSERT INTO civilization_purge_tombstones (
          project_id, thread_id, deletion_at, purge_started_at, purge_completed_at,
          preview_token, retention_days, progress_state, updated_at
        ) VALUES (
          ${projectId}, 'thread:old-tombstone', NULL,
          '2026-10-01T12:00:00.000Z', '2026-10-01T12:00:00.000Z',
          NULL, 30, 'complete', '2026-10-01T12:00:00.000Z'
        )
      `;

      const preview = yield* operations.previewRetentionReduction(projectId);
      assert.deepEqual(preview.current, {
        noteRetentionDays: 30,
        diagnosticRetentionDays: 7,
        tombstoneRetentionDays: 30,
      });
      assert.deepEqual(preview.proposed, {
        noteRetentionDays: 7,
        diagnosticRetentionDays: 1,
        tombstoneRetentionDays: 7,
      });
      assert.deepEqual(preview.newlyEligible, {
        resolvedNotes: 1,
        resolvedNoteBodyBytes: 3,
        diagnosticReferences: 1,
        diagnosticInspections: 1,
        tombstones: 1,
      });
      assert.deepEqual(preview.samples.noteIds, ["note:two"]);
      assert.deepEqual(preview.samples.contextReferenceIds, ["context:secret"]);
      assert.deepEqual(preview.samples.contextInspectionIds, ["inspection:secret"]);
      assert.deepEqual(preview.samples.tombstoneThreadIds, ["thread:old-tombstone"]);
      assert.isFalse(preview.samples.partial);

      const applied = yield* operations.applyRetentionReduction({
        projectId,
        expectedPreviewToken: preview.previewToken,
      });
      assert.deepEqual(applied.applied, preview.proposed);
      assert.deepEqual(
        (yield* sql<{
          readonly applied_note_retention_days: number;
          readonly applied_diagnostic_retention_days: number;
          readonly applied_tombstone_retention_days: number;
        }>`
          SELECT applied_note_retention_days, applied_diagnostic_retention_days,
                 applied_tombstone_retention_days
          FROM civilization_project_state WHERE project_id = ${projectId}
        `)[0],
        {
          applied_note_retention_days: 7,
          applied_diagnostic_retention_days: 1,
          applied_tombstone_retention_days: 7,
        },
      );
      assert.equal(
        (yield* sql<{ readonly retention_days: number }>`
          SELECT retention_days FROM civilization_purge_tombstones
          WHERE project_id = ${projectId} AND thread_id = 'thread:old-tombstone'
        `)[0]?.retention_days,
        7,
      );
      assert.equal(
        (yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM civilization_notes WHERE project_id = ${projectId}
        `)[0]?.count,
        2,
        "retention apply approves the horizon; scheduled cleanup performs deletion",
      );
      assert.equal(
        (yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM civilization_citizens WHERE project_id = ${projectId}
        `)[0]?.count,
        2,
        "citizen identity is never a retention-cleanup candidate",
      );
    }).pipe(Effect.provide(Layer.fresh(layer))),
);

it.effect(
  "resumes bounded purge batches, becomes idempotent, and leaves only minimal tombstones",
  () =>
    Effect.gen(function* () {
      const operations = yield* OperationsService.CivilizationOperationsService;
      const sql = yield* SqlClient.SqlClient;
      yield* setup;
      yield* disableParticipation;

      const preview = yield* operations.previewPurge(projectId);
      const first = yield* operations.applyPurge({
        projectId,
        expectedPreviewToken: preview.previewToken,
        batchSize: 2,
      });
      assert.isFalse(first.complete);
      assert.isAtMost(first.deletedThisBatch, 2);

      let progress = first;
      for (let index = 0; index < 10 && !progress.complete; index += 1) {
        progress = yield* operations.applyPurge({
          projectId,
          expectedPreviewToken: preview.previewToken,
          batchSize: 2,
        });
      }
      assert.isTrue(progress.complete);
      const repeated = yield* operations.applyPurge({
        projectId,
        expectedPreviewToken: preview.previewToken,
        batchSize: 2,
      });
      assert.isTrue(repeated.complete);
      assert.equal(repeated.deletedThisBatch, 0);

      for (const table of [
        "civilization_context_inspections",
        "civilization_context_references",
        "civilization_mail_operation_receipts",
        "civilization_mail_quota_windows",
        "civilization_messages",
        "civilization_notes",
        "civilization_citizens",
        "civilization_project_config",
        "civilization_project_state",
      ]) {
        const row = (yield* sql.unsafe<{ readonly count: number }>(
          `SELECT COUNT(*) AS count FROM ${table} WHERE project_id = ?`,
          [projectId],
        ))[0]!;
        assert.equal(row.count, 0, `${table} should be purged`);
      }
      const tombstones = yield* sql<Record<string, unknown>>`
      SELECT * FROM civilization_purge_tombstones WHERE project_id = ${projectId} ORDER BY thread_id
    `;
      assert.isAtLeast(tombstones.length, 1);
      const serialized = JSON.stringify(tombstones);
      for (const sensitive of [
        "Ada Secret",
        "private style",
        "Private title",
        "note-body",
        "mail-body",
        "privatehash",
        "note:one",
        "mail:one",
      ]) {
        assert.notInclude(serialized, sensitive);
      }

      yield* sql`
        INSERT INTO civilization_project_config (project_id, revision, override_json, updated_at)
        VALUES (${projectId}, 50, ${JSON.stringify({ version: CIVILIZATION_CONFIG_VERSION, participation: { enabled: false } })}, datetime('now'))
      `;
      yield* seedCitizen(threadA, "Recreated Ada");
      yield* sql`
        INSERT INTO civilization_notes (
          note_id, project_id, category, body, body_bytes, author_thread_id, author_epoch,
          accepted_runtime_mode, accepted_interaction_mode, source_refs_json, revision,
          created_at, updated_at, resolved_at
        ) VALUES ('note:recreated', ${projectId}, 'fact', 'new-data', 8, ${threadA}, 0,
          'full-access', 'default', '[]', 1, datetime('now'), datetime('now'), NULL)
      `;
      const freshPreview = yield* operations.previewPurge(projectId);
      assert.notEqual(freshPreview.previewToken, preview.previewToken);
      const stale = yield* Effect.flip(
        operations.applyPurge({
          projectId,
          expectedPreviewToken: preview.previewToken,
          batchSize: 100,
        }),
      );
      assert.equal((stale as { readonly code?: string }).code, "civilization_purge_conflict");
      assert.equal(
        (yield* sql<{ readonly count: number }>`
          SELECT COUNT(*) AS count FROM civilization_notes WHERE project_id = ${projectId}
        `)[0]?.count,
        1,
      );
      const freshApply = yield* operations.applyPurge({
        projectId,
        expectedPreviewToken: freshPreview.previewToken,
        batchSize: 100,
      });
      assert.isTrue(freshApply.complete);
      const rebound = (yield* sql<{ readonly preview_token: string | null }>`
        SELECT preview_token FROM civilization_purge_tombstones
        WHERE project_id = ${projectId} AND thread_id = '__project__'
      `)[0];
      assert.equal(rebound?.preview_token, freshPreview.previewToken);
    }).pipe(Effect.provide(Layer.fresh(layer))),
);

it.effect("resumes project-deletion cleanup in bounded idempotent batches", () =>
  Effect.gen(function* () {
    const operations = yield* OperationsService.CivilizationOperationsService;
    const sql = yield* SqlClient.SqlClient;
    yield* setup;
    yield* sql`
      UPDATE projection_projects SET deleted_at = '2026-10-16T01:00:00.000Z'
      WHERE project_id = ${projectId}
    `;
    let progress = yield* operations.cleanupDeletedProject({ projectId, batchSize: 1 });
    assert.isFalse(progress.complete);
    for (let index = 0; index < 20 && !progress.complete; index += 1) {
      progress = yield* operations.cleanupDeletedProject({ projectId, batchSize: 1 });
    }
    assert.isTrue(progress.complete);
    const again = yield* operations.cleanupDeletedProject({ projectId, batchSize: 1 });
    assert.isTrue(again.complete);
    assert.equal(again.deletedThisBatch, 0);
    const projectTombstone = (yield* sql<{
      readonly deletion_at: string | null;
      readonly progress_state: string;
    }>`
      SELECT deletion_at, progress_state FROM civilization_purge_tombstones
      WHERE project_id = ${projectId} AND thread_id = '__project__'
    `)[0]!;
    assert.equal(projectTombstone.deletion_at, "2026-10-16T01:00:00.000Z");
    assert.equal(projectTombstone.progress_state, "complete");
  }).pipe(Effect.provide(Layer.fresh(layer))),
);
