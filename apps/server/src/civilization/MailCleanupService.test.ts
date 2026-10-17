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
import * as Ref from "effect/Ref";
import * as SqlClient from "effect/sql/SqlClient";
import * as TestClock from "effect/testing/TestClock";

import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ConfigService from "./ConfigService.ts";
import * as MailCleanupService from "./MailCleanupService.ts";
import * as MailService from "./MailService.ts";
import * as OperationsService from "./OperationsService.ts";

const database = SqlitePersistence.layerMemory;
const projectA = ProjectId.make("project:civilization:cleanup:a");
const projectB = ProjectId.make("project:civilization:cleanup:b");

const seedProject = Effect.fn("MailCleanupService.test.seedProject")(function* (
  projectId: ProjectId,
  overrideJson: string | null = null,
) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
    ) VALUES (
      ${projectId}, ${projectId}, '/tmp/cleanup', '[]',
      '2026-10-16T00:00:00.000Z', '2026-10-16T00:00:00.000Z', NULL
    )
  `;
  if (overrideJson !== null) {
    yield* sql`
      INSERT INTO civilization_project_config (project_id, revision, override_json, updated_at)
      VALUES (${projectId}, 1, ${overrideJson}, '2026-10-16T00:00:00.000Z')
    `;
  }
  yield* sql`
    INSERT INTO civilization_project_state (
      project_id, census_revision, notes_revision, updated_at,
      mail_revision, retained_message_count, retained_body_bytes, last_mail_cleanup_at
    ) VALUES (${projectId}, 0, 0, '2026-10-16T00:00:00.000Z', 1, 1, 1, NULL)
    ON CONFLICT(project_id) DO UPDATE SET
      mail_revision = 1,
      retained_message_count = 1,
      retained_body_bytes = 1,
      last_mail_cleanup_at = NULL
  `;
});

const testLayer = Effect.gen(function* () {
  const calls = yield* Ref.make<ReadonlyArray<ProjectId>>([]);
  const mailLayer = Layer.succeed(
    MailService.CivilizationMailService,
    MailService.CivilizationMailService.of({
      cleanupProject: (projectId: ProjectId) =>
        Ref.update(calls, (current) => [...current, projectId]).pipe(
          Effect.as({ expired: 0, deletedMessages: 0, deletedReceipts: 0, deletedQuotaWindows: 0 }),
        ),
    } as unknown as MailService.CivilizationMailServiceShape),
  );
  const configLayer = ConfigService.layer.pipe(Layer.provide(database));
  const operationsLayer = OperationsService.layer.pipe(
    Layer.provide(Layer.mergeAll(database, configLayer)),
  );
  const cleanupLayer = MailCleanupService.layerService.pipe(
    Layer.provide(Layer.mergeAll(database, configLayer, mailLayer, operationsLayer)),
  );
  return {
    calls,
    layer: Layer.mergeAll(database, configLayer, mailLayer, operationsLayer, cleanupLayer),
  } as const;
});

const seedCitizen = Effect.fn("MailCleanupService.test.seedCitizen")(function* (
  projectId: ProjectId,
  threadId: ThreadId,
) {
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
      epoch, closed, deleted, revision, created_at, updated_at,
      delivery_epoch, delivery_settled, delivery_archived, delivery_deleted
    ) VALUES (
      ${threadId}, ${projectId}, NULL, NULL, ${threadId},
      0, 'resolved', 0, 1, 1,
      'cleanup-name', 1, 'Cleanup', 'Cleanup', ${threadId}, 'pool', 0, 0,
      'cleanup-profile', 'Cleanup', '[]', 'cleanup-style', 'profiles', 0, 0,
      0, NULL, NULL, 'cleanup', NULL, NULL, NULL,
      0, 0, 0, 1, '2026-10-16T00:00:00.000Z', '2026-10-16T00:00:00.000Z',
      0, 0, 0, 0
    )
  `;
});

const seedDeletedFeatureData = Effect.fn("MailCleanupService.test.seedDeletedFeatureData")(
  function* (projectId: ProjectId) {
    const sql = yield* SqlClient.SqlClient;
    const sender = ThreadId.make(`${projectId}:sender`);
    const recipient = ThreadId.make(`${projectId}:recipient`);
    yield* seedCitizen(projectId, sender);
    yield* seedCitizen(projectId, recipient);
    yield* sql`
      INSERT INTO civilization_notes (
        note_id, project_id, category, body, body_bytes, author_thread_id, author_epoch,
        accepted_runtime_mode, accepted_interaction_mode, source_refs_json, revision,
        created_at, updated_at, resolved_at
      ) VALUES (${`${projectId}:note`}, ${projectId}, 'fact', 'secret-note', 11, ${sender}, 0,
        'full-access', 'default', '[]', 1,
        '2026-10-16T00:00:00.000Z', '2026-10-16T00:00:00.000Z', NULL)
    `;
    yield* sql`
      INSERT INTO civilization_messages (
        message_id, project_id, sender_thread_id, sender_name_at_send, sender_citizen_epoch,
        sender_run_id, recipient_thread_id, recipient_delivery_epoch, reply_to_message_id,
        body, body_bytes, accepted_runtime_mode, accepted_interaction_mode,
        accepted_environment_revision, accepted_project_revision, accepted_at, expires_at,
        terminal_retention_days, first_offered_at, last_offered_at, offer_count,
        acknowledged_at, terminal_at, terminal_reason
      ) VALUES (${`${projectId}:mail`}, ${projectId}, ${sender}, 'Cleanup', 0, 'run:cleanup', ${recipient}, 0,
        NULL, 'secret-mail', 11, 'full-access', 'default', 0, 0,
        '2026-10-16T00:00:00.000Z', '2026-11-16T00:00:00.000Z', 30,
        NULL, NULL, 0, NULL, NULL, NULL)
    `;
    yield* sql`
      INSERT INTO civilization_context_references (
        context_reference_id, project_id, thread_id, run_id, attempt_id, provider_turn_ordinal,
        provider_instance_id, environment_revision, project_revision, citizen_revision,
        census_revision, notes_revision, inbox_revision, packet_hash, packet_bytes,
        selected_citizen_ids_json, selected_note_ids_json, selected_inbox_ids_json, created_at
      ) VALUES (${`${projectId}:context`}, ${projectId}, ${sender}, ${RunId.make("run:cleanup-context")},
        ${RunAttemptId.make("attempt:cleanup-context")}, 1, 'codex', 0, 0, 1, 1, 1, 1,
        'sha256:cleanup', 10, '[]', '[]', '[]', '2026-10-16T00:00:00.000Z')
    `;
    yield* sql`
      INSERT INTO civilization_context_inspections (
        inspection_id, context_reference_id, project_id, thread_id, run_id, attempt_id,
        provider_turn_ordinal, provider_instance_id, provider_driver, outcome, diagnostics_mode,
        packet_text_state, packet_hash, packet_bytes, packet_text, packet_budget_bytes,
        created_at, updated_at
      ) VALUES (
        ${`${projectId}:inspection`}, ${`${projectId}:context`}, ${projectId}, ${sender},
        'run:cleanup-inspection', 'attempt:cleanup-inspection', 1, 'codex', 'codex',
        'provider_start_accepted', 'normal', 'retained_normal', 'sha256:cleanup-inspection',
        12, 'cleanup-packet', 4096, '2026-10-16T00:00:00.000Z', '2026-10-16T00:00:00.000Z'
      )
    `;
  },
);

it.effect("skips projects until their configured cleanup cadence is due", () =>
  Effect.gen(function* () {
    const fixture = yield* testLayer;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const cleanup = yield* MailCleanupService.CivilizationMailCleanupService;
      yield* seedProject(projectA);
      yield* sql`
        UPDATE civilization_project_state
        SET last_mail_cleanup_at = ${DateTime.formatIso(yield* DateTime.now)}
        WHERE project_id = ${projectA}
      `;

      const first = yield* cleanup.runDue();
      assert.equal(first.cleaned, 0);
      assert.equal(first.skipped, 1);
      assert.deepEqual(yield* Ref.get(fixture.calls), []);

      yield* TestClock.adjust("61 minutes");
      const second = yield* cleanup.runDue();
      assert.equal(second.cleaned, 1);
      assert.deepEqual(yield* Ref.get(fixture.calls), [projectA]);
    }).pipe(Effect.provide(fixture.layer));
  }),
);

it.effect("cleans retained mail even when Civilization participation is disabled", () =>
  Effect.gen(function* () {
    const fixture = yield* testLayer;
    yield* Effect.gen(function* () {
      const cleanup = yield* MailCleanupService.CivilizationMailCleanupService;
      yield* seedProject(
        projectA,
        JSON.stringify({
          version: CIVILIZATION_CONFIG_VERSION,
          participation: { enabled: false, emergencyOff: true },
        }),
      );
      const result = yield* cleanup.runDue();
      assert.equal(result.cleaned, 1);
      assert.deepEqual(yield* Ref.get(fixture.calls), [projectA]);
    }).pipe(Effect.provide(fixture.layer));
  }),
);

it.effect("continues cleanup after one project has corrupt configuration", () =>
  Effect.gen(function* () {
    const fixture = yield* testLayer;
    yield* Effect.gen(function* () {
      const cleanup = yield* MailCleanupService.CivilizationMailCleanupService;
      yield* seedProject(
        projectA,
        JSON.stringify({ version: CIVILIZATION_CONFIG_VERSION, context: { packetBytes: 999_999 } }),
      );
      yield* seedProject(projectB);

      const result = yield* cleanup.runDue();
      assert.equal(result.scanned, 2);
      assert.equal(result.cleaned, 1);
      assert.deepEqual(yield* Ref.get(fixture.calls), [projectB]);
    }).pipe(Effect.provide(fixture.layer));
  }),
);

it.effect("bounds each scan and repeated due runs are idempotent within the cadence", () =>
  Effect.gen(function* () {
    const fixture = yield* testLayer;
    yield* Effect.gen(function* () {
      const cleanup = yield* MailCleanupService.CivilizationMailCleanupService;
      yield* seedProject(projectA);
      yield* seedProject(projectB);

      const first = yield* cleanup.runDue();
      const second = yield* cleanup.runDue();
      assert.equal(first.scanned, 2);
      assert.equal(first.cleaned, 2);
      assert.equal(second.cleaned, 0);
      assert.equal(second.skipped, 2);
      assert.deepEqual(yield* Ref.get(fixture.calls), [projectA, projectB]);
      assert.isAtMost(first.scanned, 1000);
    }).pipe(Effect.provide(fixture.layer));
  }),
);

it.effect(
  "drains host-deleted Civilization data resumably even after project state and config disappear",
  () =>
    Effect.gen(function* () {
      const fixture = yield* testLayer;
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const cleanup = yield* MailCleanupService.CivilizationMailCleanupService;
        yield* seedProject(
          projectA,
          JSON.stringify({
            version: CIVILIZATION_CONFIG_VERSION,
            operations: { cleanupBatch: 2 },
          }),
        );
        yield* seedDeletedFeatureData(projectA);
        yield* sql`
          UPDATE projection_projects
          SET deleted_at = '2026-10-16T01:00:00.000Z'
          WHERE project_id = ${projectA}
        `;

        const first = yield* cleanup.runDue();
        assert.equal(first.deletedProjectScanned, 1);
        assert.equal(first.deletedProjectCleanups, 1);
        const firstTombstone = (yield* sql<{ readonly progress_state: string }>`
            SELECT progress_state FROM civilization_purge_tombstones
            WHERE project_id = ${projectA} AND thread_id = '__project__'
          `)[0]!;
        assert.equal(firstTombstone.progress_state, "in_progress");

        // Simulate an earlier batch/process having already removed state/config.
        // Candidate discovery must still come from remaining feature rows/tombstone.
        yield* sql`DELETE FROM civilization_project_config WHERE project_id = ${projectA}`;
        yield* sql`DELETE FROM civilization_project_state WHERE project_id = ${projectA}`;

        const second = yield* cleanup.runDue();
        assert.equal(second.deletedProjectScanned, 1);
        assert.equal(second.deletedProjectCleanups, 1);
        for (const table of [
          "civilization_citizens",
          "civilization_notes",
          "civilization_context_inspections",
          "civilization_context_references",
          "civilization_messages",
          "civilization_project_config",
          "civilization_project_state",
        ]) {
          const count = (yield* sql.unsafe<{ readonly count: number }>(
            `SELECT COUNT(*) AS count FROM ${table} WHERE project_id = ?`,
            [projectA],
          ))[0]!.count;
          assert.equal(count, 0, `${table} should be drained`);
        }
        const complete = (yield* sql<{ readonly progress_state: string }>`
            SELECT progress_state FROM civilization_purge_tombstones
            WHERE project_id = ${projectA} AND thread_id = '__project__'
          `)[0]!;
        assert.equal(complete.progress_state, "complete");

        const repeated = yield* cleanup.runDue();
        assert.equal(repeated.deletedProjectScanned, 0);
        assert.equal(repeated.deletedProjectCleanups, 0);
      }).pipe(Effect.provide(fixture.layer));
    }),
);

it.effect("ages diagnostic context references in bounded batches while disabled", () =>
  Effect.gen(function* () {
    const fixture = yield* testLayer;
    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const cleanup = yield* MailCleanupService.CivilizationMailCleanupService;
      yield* seedProject(
        projectA,
        JSON.stringify({
          version: CIVILIZATION_CONFIG_VERSION,
          participation: { enabled: false, emergencyOff: true },
          operations: {
            cleanupBatch: 1,
            cleanupCadenceMinutes: 1,
            diagnosticRetentionDays: 7,
          },
        }),
      );
      yield* sql`
        UPDATE civilization_project_state
        SET mail_revision = 0, retained_message_count = 0, retained_body_bytes = 0
        WHERE project_id = ${projectA}
      `;
      const threadId = ThreadId.make("thread:civilization:cleanup:context");
      const now = yield* DateTime.now;
      const oldA = DateTime.formatIso(DateTime.subtract(now, { days: 9 }));
      const oldB = DateTime.formatIso(DateTime.subtract(now, { days: 8 }));
      const recent = DateTime.formatIso(now);
      for (const [id, createdAt] of [
        ["context:old:a", oldA],
        ["context:old:b", oldB],
        ["context:new", recent],
      ] as const) {
        yield* sql`
          INSERT INTO civilization_context_references (
            context_reference_id, project_id, thread_id, run_id, attempt_id, provider_turn_ordinal,
            provider_instance_id, environment_revision, project_revision, citizen_revision,
            census_revision, notes_revision, inbox_revision, packet_hash, packet_bytes,
            selected_citizen_ids_json, selected_note_ids_json, selected_inbox_ids_json, created_at
          ) VALUES (${id}, ${projectA}, ${threadId}, 'run:retention', 'attempt:retention', 1,
            'codex', 0, 1, 1, 1, 1, 1, 'sha256:retention', 1, '[]', '[]', '[]', ${createdAt})
        `;
        yield* sql`
          INSERT INTO civilization_context_inspections (
            inspection_id, context_reference_id, project_id, thread_id, run_id, attempt_id,
            provider_turn_ordinal, provider_instance_id, provider_driver, outcome, diagnostics_mode,
            packet_text_state, packet_hash, packet_bytes, packet_text, packet_budget_bytes,
            created_at, updated_at
          ) VALUES (
            ${id.replace("context:", "inspection:")}, ${id}, ${projectA}, ${threadId},
            ${`run:${id}`}, ${`attempt:${id}`}, 1, 'codex', 'codex',
            'provider_start_accepted', 'normal', 'retained_normal', 'sha256:retention-inspection',
            1, 'x', 4096, ${createdAt}, ${createdAt}
          )
        `;
      }

      const first = yield* cleanup.runDue();
      assert.equal(first.cleaned, 1);
      let rows = yield* sql<{ readonly context_reference_id: string }>`
        SELECT context_reference_id FROM civilization_context_references
        WHERE project_id = ${projectA}
        ORDER BY context_reference_id ASC
      `;
      assert.deepEqual(
        rows.map((row) => row.context_reference_id),
        ["context:new", "context:old:b"],
      );
      let inspectionRows = yield* sql<{ readonly inspection_id: string }>`
        SELECT inspection_id FROM civilization_context_inspections
        WHERE project_id = ${projectA}
        ORDER BY inspection_id ASC
      `;
      assert.deepEqual(
        inspectionRows.map((row) => row.inspection_id),
        ["inspection:new", "inspection:old:b"],
      );

      yield* TestClock.adjust("2 minutes");
      yield* cleanup.runDue();
      rows = yield* sql<{ readonly context_reference_id: string }>`
        SELECT context_reference_id FROM civilization_context_references
        WHERE project_id = ${projectA}
        ORDER BY context_reference_id ASC
      `;
      assert.deepEqual(
        rows.map((row) => row.context_reference_id),
        ["context:new"],
      );
      inspectionRows = yield* sql<{ readonly inspection_id: string }>`
        SELECT inspection_id FROM civilization_context_inspections
        WHERE project_id = ${projectA}
        ORDER BY inspection_id ASC
      `;
      assert.deepEqual(
        inspectionRows.map((row) => row.inspection_id),
        ["inspection:new"],
      );
      assert.deepEqual(yield* Ref.get(fixture.calls), [projectA, projectA]);
    }).pipe(Effect.provide(fixture.layer));
  }),
);

it.effect(
  "requires retention preview/apply before shortened note/tombstone horizons can delete existing data",
  () =>
    Effect.gen(function* () {
      const fixture = yield* testLayer;
      yield* Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient;
        const cleanup = yield* MailCleanupService.CivilizationMailCleanupService;
        const operations = yield* OperationsService.CivilizationOperationsService;
        const now = DateTime.makeUnsafe("2026-10-16T12:00:00.000Z");
        yield* TestClock.setTime(DateTime.toEpochMillis(now));
        yield* seedProject(
          projectA,
          JSON.stringify({
            version: CIVILIZATION_CONFIG_VERSION,
            participation: { enabled: false, emergencyOff: true },
            knowledge: { retentionDays: 7 },
            operations: {
              diagnosticRetentionDays: 1,
              tombstoneRetentionDays: 7,
              cleanupBatch: 1,
              cleanupCadenceMinutes: 1,
            },
          }),
        );
        const author = ThreadId.make("thread:civilization:cleanup:retention-author");
        yield* seedCitizen(projectA, author);
        yield* sql`
          INSERT INTO civilization_notes (
            note_id, project_id, category, body, body_bytes, author_thread_id, author_epoch,
            accepted_runtime_mode, accepted_interaction_mode, source_refs_json, revision,
            created_at, updated_at, resolved_at
          ) VALUES
            ('note:resolved-old', ${projectA}, 'fact', 'old', 3, ${author}, 0,
             'full-access', 'default', '[]', 1,
             '2026-10-01T12:00:00.000Z', '2026-10-01T12:00:00.000Z', '2026-10-01T12:00:00.000Z'),
            ('note:active-old', ${projectA}, 'fact', 'active', 6, ${author}, 0,
             'full-access', 'default', '[]', 1,
             '2026-10-01T12:00:00.000Z', '2026-10-01T12:00:00.000Z', NULL)
        `;
        yield* sql`
          INSERT INTO civilization_purge_tombstones (
            project_id, thread_id, deletion_at, purge_started_at, purge_completed_at,
            preview_token, retention_days, progress_state, updated_at
          ) VALUES (
            ${projectA}, 'thread:retention-old', NULL,
            '2026-10-01T12:00:00.000Z', '2026-10-01T12:00:00.000Z',
            NULL, 30, 'complete', '2026-10-01T12:00:00.000Z'
          )
        `;

        const beforeApproval = yield* cleanup.runDue();
        assert.equal(beforeApproval.deletedTombstones, 0);
        assert.deepEqual(
          (yield* sql<{ readonly note_id: string }>`
            SELECT note_id FROM civilization_notes WHERE project_id = ${projectA} ORDER BY note_id
          `).map((row) => row.note_id),
          ["note:active-old", "note:resolved-old"],
        );
        assert.equal(
          (yield* sql<{ readonly count: number }>`
            SELECT COUNT(*) AS count FROM civilization_purge_tombstones
            WHERE project_id = ${projectA} AND thread_id = 'thread:retention-old'
          `)[0]?.count,
          1,
        );

        const preview = yield* operations.previewRetentionReduction(projectA);
        assert.equal(preview.newlyEligible.resolvedNotes, 1);
        assert.equal(preview.newlyEligible.tombstones, 1);
        yield* operations.applyRetentionReduction({
          projectId: projectA,
          expectedPreviewToken: preview.previewToken,
        });

        yield* TestClock.adjust("2 minutes");
        const afterApproval = yield* cleanup.runDue();
        assert.equal(afterApproval.deletedTombstones, 1);
        assert.deepEqual(
          (yield* sql<{ readonly note_id: string }>`
            SELECT note_id FROM civilization_notes WHERE project_id = ${projectA} ORDER BY note_id
          `).map((row) => row.note_id),
          ["note:active-old"],
          "resolved notes age out; active notes remain until explicit deletion",
        );
        assert.equal(
          (yield* sql<{ readonly count: number }>`
            SELECT COUNT(*) AS count FROM civilization_citizens WHERE project_id = ${projectA}
          `)[0]?.count,
          1,
          "retention cleanup never deletes citizen identity",
        );
      }).pipe(Effect.provide(fixture.layer));
    }),
);
