// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  CIVILIZATION_CONFIG_VERSION,
  EventId,
  type ModelSelection,
  type OrchestrationV2AppThread,
  type OrchestrationV2DomainEvent,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";

import { runMigrations } from "../persistence/Migrations.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as EventStore from "../orchestration-v2/EventStore.ts";
import * as ProjectionMaintenance from "../orchestration-v2/ProjectionMaintenance.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ConfigService from "./ConfigService.ts";
import * as KnowledgeService from "./KnowledgeService.ts";
import { civilizationPersistenceParticipant } from "./PersistenceParticipant.ts";

const providerInstanceId = ProviderInstanceId.make("codex");
const modelSelection = {
  instanceId: providerInstanceId,
  model: "gpt-5.4",
} satisfies ModelSelection;

const fixedTime = "2026-10-16T10:00:00.000Z";

function makeThread(input: {
  readonly threadId: ThreadId;
  readonly projectId: ProjectId;
  readonly now: DateTime.Utc;
  readonly worktreePath?: string | null;
}): OrchestrationV2AppThread {
  const worktreePath = input.worktreePath ?? null;
  return {
    createdBy: "user",
    creationSource: "web",
    id: input.threadId,
    projectId: input.projectId,
    title: "Recovery citizen",
    providerInstanceId,
    modelSelection,
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: worktreePath === null ? null : "feature/recovery",
    worktreePath,
    activeProviderThreadId: null,
    lineage: {
      parentThreadId: null,
      relationshipToParent: null,
      rootThreadId: input.threadId,
    },
    forkedFrom: null,
    createdAt: input.now,
    updatedAt: input.now,
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

function threadMetadataEvent(input: {
  readonly id: string;
  readonly thread: OrchestrationV2AppThread;
  readonly now: DateTime.Utc;
}): OrchestrationV2DomainEvent {
  return {
    id: EventId.make(input.id),
    type: "thread.metadata-updated",
    threadId: input.thread.id,
    occurredAt: input.now,
    payload: input.thread,
  };
}

const seedProject = Effect.fn("RecoveryAcceptance.seedProject")(function* (input: {
  readonly projectId: ProjectId;
  readonly workspaceRoot?: string;
}) {
  const sql = yield* SqlClient.SqlClient;
  yield* sql`
    INSERT INTO projection_projects (
      project_id, title, workspace_root, scripts_json, created_at, updated_at, deleted_at
    ) VALUES (
      ${input.projectId}, ${input.projectId}, ${input.workspaceRoot ?? "/tmp/civilization-recovery"}, '[]',
      ${fixedTime}, ${fixedTime}, NULL
    )
  `;
});

const seedLatestFeatureRows = Effect.fn("RecoveryAcceptance.seedLatestFeatureRows")(
  function* (input: {
    readonly projectId: ProjectId;
    readonly threadId: ThreadId;
    readonly lastAppliedSequence: number;
    readonly includeRichSnapshot?: boolean;
  }) {
    const sql = yield* SqlClient.SqlClient;
    const nameKey = ConfigService.normalizeCivilizationName("Ada Recovery");
    if (input.includeRichSnapshot === false) {
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
        epoch, closed, deleted,
        delivery_epoch, delivery_settled, delivery_archived, delivery_deleted,
        revision, created_at, updated_at
      ) VALUES (
        ${input.threadId}, ${input.projectId}, NULL, NULL, ${input.threadId},
        0, 'resolved', 0, ${input.lastAppliedSequence}, ${input.lastAppliedSequence},
        'name:ada-recovery', 1, 'Ada Recovery', 'Ada Recovery', ${nameKey}, 'default-names',
        1, 2,
        'profile:calm', 'Calm', '["careful","concise"]', 'Prefer careful concise answers.', 'default-profiles',
        1, 2,
        0, 'Recovery citizen', NULL, 'Recovery citizen',
        NULL, NULL, NULL,
        7, 0, 0,
        8, 0, 0, 0,
        5, ${fixedTime}, ${fixedTime}
      )
    `;
    } else {
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
        epoch, closed, deleted,
        delivery_epoch, delivery_settled, delivery_archived, delivery_deleted,
        revision, created_at, updated_at
      ) VALUES (
        ${input.threadId}, ${input.projectId}, NULL, NULL, ${input.threadId},
        0, 'resolved', 0, ${input.lastAppliedSequence}, ${input.lastAppliedSequence},
        'name:ada-recovery', 1, 'Ada Recovery', 'Ada Recovery', ${nameKey}, 'default-names',
        1, 2,
        'profile:calm', 'Calm', '["careful","concise"]', 'Prefer careful concise answers.', 'default-profiles',
        'Stoic Architect', '["deliberate","structural"]', 'Build carefully.', 'Measured and composed.', 'Prefer a deliberate architectural voice.',
        1, 2,
        0, 'Recovery citizen', NULL, 'Recovery citizen',
        NULL, NULL, NULL,
        7, 0, 0,
        8, 0, 0, 0,
        5, ${fixedTime}, ${fixedTime}
      )
    `;
    }

    const noteBody = "snapshot note body";
    yield* sql`
    INSERT INTO civilization_notes (
      note_id, project_id, category, body, body_bytes,
      author_thread_id, author_epoch, accepted_runtime_mode, accepted_interaction_mode,
      source_refs_json, revision, created_at, updated_at, resolved_at
    ) VALUES (
      'note:recovery', ${input.projectId}, 'fact', ${noteBody}, ${Buffer.byteLength(noteBody, "utf8")},
      ${input.threadId}, 7, 'full-access', 'default', '[{"kind":"thread","reference":"seed"}]',
      3, ${fixedTime}, ${fixedTime}, NULL
    )
  `;

    const messageBody = "closed mail body";
    yield* sql`
    INSERT INTO civilization_messages (
      message_id, project_id, sender_thread_id, sender_name_at_send,
      sender_citizen_epoch, sender_run_id, recipient_thread_id, recipient_delivery_epoch,
      reply_to_message_id, body, body_bytes,
      accepted_runtime_mode, accepted_interaction_mode,
      accepted_environment_revision, accepted_project_revision,
      accepted_at, expires_at, terminal_retention_days,
      first_offered_at, last_offered_at, offer_count, acknowledged_at,
      terminal_at, terminal_reason
    ) VALUES (
      'mail:recovery', ${input.projectId}, 'thread:recovery:sender', 'Sender',
      2, 'run:recovery:sender', ${input.threadId}, 7,
      NULL, ${messageBody}, ${Buffer.byteLength(messageBody, "utf8")},
      'full-access', 'default', 1, 2,
      ${fixedTime}, '2026-11-15T10:00:00.000Z', 30,
      ${fixedTime}, ${fixedTime}, 1, ${fixedTime},
      ${fixedTime}, 'recipient_settled'
    )
  `;
  },
);

const readFeatureState = Effect.fn("RecoveryAcceptance.readFeatureState")(function* (
  projectId: ProjectId,
) {
  const sql = yield* SqlClient.SqlClient;
  return {
    environmentConfig: [
      ...(yield* sql<{ readonly revision: number; readonly override_json: string | null }>`
        SELECT revision, override_json
        FROM civilization_environment_config
        WHERE singleton = 1
      `),
    ],
    projectConfig: [
      ...(yield* sql<{ readonly revision: number; readonly override_json: string | null }>`
        SELECT revision, override_json
        FROM civilization_project_config
        WHERE project_id = ${projectId}
      `),
    ],
    citizens: [
      ...(yield* sql<{
        readonly thread_id: string;
        readonly name_entry_id: string;
        readonly name_display: string;
        readonly name_key: string;
        readonly profile_entry_id: string;
        readonly profile_label: string;
        readonly profile_traits_json: string;
        readonly profile_style_text: string;
        readonly profile_rich_label: string;
        readonly profile_rich_traits_json: string;
        readonly profile_rich_axiom: string;
        readonly profile_rich_voice: string;
        readonly profile_rich_style_text: string;
        readonly epoch: number;
        readonly delivery_epoch: number;
        readonly closed: number;
        readonly delivery_settled: number;
        readonly revision: number;
      }>`
        SELECT thread_id, name_entry_id, name_display, name_key,
               profile_entry_id, profile_label, profile_traits_json, profile_style_text,
               profile_rich_label, profile_rich_traits_json, profile_rich_axiom,
               profile_rich_voice, profile_rich_style_text,
               epoch, delivery_epoch, closed, delivery_settled, revision
        FROM civilization_citizens
        WHERE project_id = ${projectId}
        ORDER BY thread_id ASC
      `),
    ],
    notes: [
      ...(yield* sql<{
        readonly note_id: string;
        readonly body: string;
        readonly body_bytes: number;
        readonly source_refs_json: string;
        readonly author_epoch: number;
        readonly revision: number;
        readonly resolved_at: string | null;
      }>`
        SELECT note_id, body, body_bytes, source_refs_json, author_epoch, revision, resolved_at
        FROM civilization_notes
        WHERE project_id = ${projectId}
        ORDER BY note_id ASC
      `),
    ],
    messages: [
      ...(yield* sql<{
        readonly message_id: string;
        readonly body: string;
        readonly body_bytes: number;
        readonly recipient_thread_id: string;
        readonly recipient_delivery_epoch: number;
        readonly acknowledged_at: string | null;
        readonly terminal_at: string | null;
        readonly terminal_reason: string | null;
      }>`
        SELECT message_id, body, body_bytes, recipient_thread_id, recipient_delivery_epoch,
               acknowledged_at, terminal_at, terminal_reason
        FROM civilization_messages
        WHERE project_id = ${projectId}
        ORDER BY message_id ASC
      `),
    ],
    projectState: [
      ...(yield* sql<{
        readonly census_revision: number;
        readonly notes_revision: number;
        readonly mail_revision: number;
        readonly retained_message_count: number;
        readonly retained_body_bytes: number;
      }>`
        SELECT census_revision, notes_revision, mail_revision,
               retained_message_count, retained_body_bytes
        FROM civilization_project_state
        WHERE project_id = ${projectId}
      `),
    ],
  };
});

const readPreRichFeatureState = Effect.fn("RecoveryAcceptance.readPreRichFeatureState")(function* (
  projectId: ProjectId,
) {
  const sql = yield* SqlClient.SqlClient;
  return {
    environmentConfig: [
      ...(yield* sql<{ readonly revision: number; readonly override_json: string | null }>`
        SELECT revision, override_json
        FROM civilization_environment_config
        WHERE singleton = 1
      `),
    ],
    projectConfig: [
      ...(yield* sql<{ readonly revision: number; readonly override_json: string | null }>`
        SELECT revision, override_json
        FROM civilization_project_config
        WHERE project_id = ${projectId}
      `),
    ],
    citizens: [
      ...(yield* sql<{
        readonly thread_id: string;
        readonly name_entry_id: string;
        readonly name_display: string;
        readonly name_key: string;
        readonly profile_entry_id: string;
        readonly profile_label: string;
        readonly profile_traits_json: string;
        readonly profile_style_text: string;
        readonly epoch: number;
        readonly delivery_epoch: number;
        readonly closed: number;
        readonly delivery_settled: number;
        readonly revision: number;
      }>`
        SELECT thread_id, name_entry_id, name_display, name_key,
               profile_entry_id, profile_label, profile_traits_json, profile_style_text,
               epoch, delivery_epoch, closed, delivery_settled, revision
        FROM civilization_citizens
        WHERE project_id = ${projectId}
        ORDER BY thread_id ASC
      `),
    ],
    notes: [
      ...(yield* sql<{
        readonly note_id: string;
        readonly body: string;
        readonly body_bytes: number;
        readonly source_refs_json: string;
        readonly author_epoch: number;
        readonly revision: number;
        readonly resolved_at: string | null;
      }>`
        SELECT note_id, body, body_bytes, source_refs_json, author_epoch, revision, resolved_at
        FROM civilization_notes
        WHERE project_id = ${projectId}
        ORDER BY note_id ASC
      `),
    ],
    messages: [
      ...(yield* sql<{
        readonly message_id: string;
        readonly body: string;
        readonly body_bytes: number;
        readonly recipient_thread_id: string;
        readonly recipient_delivery_epoch: number;
        readonly acknowledged_at: string | null;
        readonly terminal_at: string | null;
        readonly terminal_reason: string | null;
      }>`
        SELECT message_id, body, body_bytes, recipient_thread_id, recipient_delivery_epoch,
               acknowledged_at, terminal_at, terminal_reason
        FROM civilization_messages
        WHERE project_id = ${projectId}
        ORDER BY message_id ASC
      `),
    ],
    projectState: [
      ...(yield* sql<{
        readonly census_revision: number;
        readonly notes_revision: number;
        readonly mail_revision: number;
        readonly retained_message_count: number;
        readonly retained_body_bytes: number;
      }>`
        SELECT census_revision, notes_revision, mail_revision,
               retained_message_count, retained_body_bytes
        FROM civilization_project_state
        WHERE project_id = ${projectId}
      `),
    ],
  };
});

const assertRetainedStateCoherent = Effect.fn("RecoveryAcceptance.assertRetainedStateCoherent")(
  function* (projectId: ProjectId) {
    const sql = yield* SqlClient.SqlClient;
    const aggregate = (yield* sql<{ readonly count: number; readonly body_bytes: number }>`
        SELECT COUNT(*) AS count, COALESCE(SUM(body_bytes), 0) AS body_bytes
        FROM civilization_messages
        WHERE project_id = ${projectId}
      `)[0]!;
    const state = (yield* sql<{
      readonly census_revision: number;
      readonly notes_revision: number;
      readonly mail_revision: number;
      readonly retained_message_count: number;
      readonly retained_body_bytes: number;
    }>`
        SELECT census_revision, notes_revision, mail_revision,
               retained_message_count, retained_body_bytes
        FROM civilization_project_state
        WHERE project_id = ${projectId}
      `)[0]!;
    assert.equal(state.retained_message_count, aggregate.count);
    assert.equal(state.retained_body_bytes, aggregate.body_bytes);
    assert.isAbove(state.census_revision, 0);
    assert.isAbove(state.notes_revision, 0);
    assert.isAbove(state.mail_revision, 0);
  },
);

const makeRecoveryLayer = <E, R>(database: Layer.Layer<SqlClient.SqlClient, E, R>) => {
  const eventStore = EventStore.layer.pipe(Layer.provideMerge(database));
  const projectionStore = ProjectionStore.layer.pipe(Layer.provideMerge(database));
  const stores = Layer.mergeAll(database, eventStore, projectionStore);
  const participantLayer = Layer.succeed(EventSink.EventSinkPersistenceParticipants, [
    civilizationPersistenceParticipant,
  ]);
  const eventSink = EventSink.layer.pipe(Layer.provide(stores), Layer.provide(participantLayer));
  const maintenance = ProjectionMaintenance.layer.pipe(Layer.provide(stores));
  const config = ConfigService.layer.pipe(Layer.provide(database));
  return Layer.mergeAll(stores, eventSink, maintenance, config);
};

const makeFileLayer = (dbPath: string) =>
  makeRecoveryLayer(
    SqlitePersistence.layerFromPath(dbPath).pipe(Layer.provide(NodeServices.layer)),
  );

it.effect(
  "migrates 064 identity/config rows to latest without rerolling names, profiles or epochs",
  () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* runMigrations({ toMigrationInclusive: 64 });
      const projectId = ProjectId.make("project:recovery:migration");
      const threadId = ThreadId.make("thread:recovery:migration");
      const environmentOverrideV1 = JSON.stringify({
        version: 1,
        participation: { enabled: true },
      });
      const projectOverrideV1 = JSON.stringify({
        version: 1,
        context: { rosterCount: 4 },
      });
      const environmentOverrideV2 = JSON.stringify({
        version: CIVILIZATION_CONFIG_VERSION,
        participation: { enabled: true },
      });
      const projectOverrideV2 = JSON.stringify({
        version: CIVILIZATION_CONFIG_VERSION,
        context: { rosterCount: 4 },
      });

      yield* sql`
      UPDATE civilization_environment_config
      SET revision = 4, override_json = ${environmentOverrideV1}, updated_at = ${fixedTime}
      WHERE singleton = 1
    `;
      yield* sql`
      INSERT INTO civilization_project_config (project_id, revision, override_json, updated_at)
      VALUES (${projectId}, 3, ${projectOverrideV1}, ${fixedTime})
    `;
      yield* sql`
      INSERT INTO orchestration_v2_projection_threads (
        thread_id, project_id, title, default_provider, runtime_mode, interaction_mode,
        active_provider_thread_id, created_at, updated_at, archived_at, deleted_at, payload_json
      ) VALUES (
        ${threadId}, ${projectId}, 'Migration citizen', 'codex', 'full-access', 'default',
        NULL, ${fixedTime}, ${fixedTime}, NULL, NULL,
        ${JSON.stringify({ settledOverride: "settled", settledAt: fixedTime })}
      )
    `;
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
        0, 'resolved', 0, 42, 57,
        'seeded-name', 1, 'Seeded Ada', 'Seeded Ada', 'seeded ada', 'names-v1',
        4, 3,
        'seeded-profile', 'Measured', '["measured"]', 'Keep a measured tone.', 'profiles-v1',
        4, 3,
        0, 'Original title', NULL, 'Original title',
        NULL, NULL, NULL,
        7, 1, 0, 9, ${fixedTime}, ${fixedTime}
      )
    `;

      const migrated = yield* runMigrations();
      assert.deepEqual(
        migrated.map(([id]) => id),
        [65, 66, 67, 68, 69, 70],
      );
      assert.deepEqual(
        (yield* sql<{
          readonly name_entry_id: string;
          readonly name_display: string;
          readonly profile_entry_id: string;
          readonly profile_label: string;
          readonly profile_traits_json: string;
          readonly profile_style_text: string;
          readonly profile_rich_label: string;
          readonly profile_rich_traits_json: string;
          readonly profile_rich_axiom: string;
          readonly profile_rich_voice: string;
          readonly profile_rich_style_text: string;
          readonly epoch: number;
          readonly delivery_epoch: number;
          readonly delivery_settled: number;
          readonly birth_sequence: number;
          readonly last_applied_sequence: number;
          readonly revision: number;
        }>`
        SELECT name_entry_id, name_display, profile_entry_id, profile_label,
               profile_traits_json, profile_style_text,
               profile_rich_label, profile_rich_traits_json, profile_rich_axiom,
               profile_rich_voice, profile_rich_style_text,
               epoch, delivery_epoch,
               delivery_settled, birth_sequence, last_applied_sequence, revision
        FROM civilization_citizens WHERE thread_id = ${threadId}
      `)[0],
        {
          name_entry_id: "seeded-name",
          name_display: "Seeded Ada",
          profile_entry_id: "seeded-profile",
          profile_label: "Measured",
          profile_traits_json: '["measured"]',
          profile_style_text: "Keep a measured tone.",
          profile_rich_label: "Measured",
          profile_rich_traits_json: '["measured"]',
          profile_rich_axiom: "Keep the stored personality subordinate to the requested task.",
          profile_rich_voice:
            "Express the stored profile distinctly without changing task priorities.",
          profile_rich_style_text: "Keep a measured tone.",
          epoch: 7,
          delivery_epoch: 7,
          delivery_settled: 1,
          birth_sequence: 42,
          last_applied_sequence: 57,
          revision: 9,
        },
      );
      assert.deepEqual(
        (yield* sql<{ readonly revision: number; readonly override_json: string | null }>`
        SELECT revision, override_json FROM civilization_environment_config WHERE singleton = 1
      `)[0],
        { revision: 4, override_json: environmentOverrideV2 },
      );
      assert.deepEqual(
        (yield* sql<{ readonly revision: number; readonly override_json: string | null }>`
        SELECT revision, override_json FROM civilization_project_config WHERE project_id = ${projectId}
      `)[0],
        { revision: 3, override_json: projectOverrideV2 },
      );
    }).pipe(Effect.provide(Layer.fresh(NodeSqliteClient.layer({ filename: ":memory:" })))),
);

it.effect("rolls back partial 067 DDL and retries without changing retained feature state", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const projectId = ProjectId.make("project:recovery:migration-rollback");
    const threadId = ThreadId.make("thread:recovery:migration-rollback");
    yield* runMigrations({ toMigrationInclusive: 66 });
    yield* seedLatestFeatureRows({
      projectId,
      threadId,
      lastAppliedSequence: 0,
      includeRichSnapshot: false,
    });
    const before = yield* readPreRichFeatureState(projectId);
    yield* assertRetainedStateCoherent(projectId);

    // Force migration 067 to fail after CREATE TABLE succeeds. SQLite DDL is
    // transactional here, so the table and migration-ledger row must both roll
    // back instead of leaving a half-applied cleanup authority behind.
    yield* sql`CREATE TABLE recovery_067_index_blocker (project_id TEXT NOT NULL)`;
    yield* sql`
      CREATE INDEX civilization_purge_tombstones_project_progress_idx
      ON recovery_067_index_blocker(project_id)
    `;
    const failed = yield* Effect.exit(runMigrations({ toMigrationInclusive: 67 }));
    assert.isTrue(Exit.isFailure(failed));
    assert.deepEqual(
      yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'civilization_purge_tombstones'
      `,
      [],
    );
    assert.deepEqual(
      yield* sql<{ readonly migration_id: number }>`
        SELECT migration_id FROM effect_sql_migrations WHERE migration_id = 67
      `,
      [],
    );
    assert.deepEqual(yield* readPreRichFeatureState(projectId), before);

    yield* sql`DROP INDEX civilization_purge_tombstones_project_progress_idx`;
    yield* sql`DROP TABLE recovery_067_index_blocker`;
    const retried = yield* runMigrations({ toMigrationInclusive: 67 });
    assert.deepEqual(
      retried.map(([id]) => id),
      [67],
    );
    assert.deepEqual(
      yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name = 'civilization_purge_tombstones'
      `,
      [{ name: "civilization_purge_tombstones" }],
    );
    assert.deepEqual(yield* readPreRichFeatureState(projectId), before);
    yield* assertRetainedStateCoherent(projectId);
  }).pipe(Effect.provide(Layer.fresh(NodeSqliteClient.layer({ filename: ":memory:" })))),
);

it.effect(
  "core projection rebuild preserves identity and retained state without reopening terminal mail",
  () =>
    Effect.gen(function* () {
      const sink = yield* EventSink.EventSinkV2;
      const maintenance = yield* ProjectionMaintenance.ProjectionMaintenanceV2;
      const config = yield* ConfigService.CivilizationConfigService;
      const now = yield* DateTime.now;
      const projectId = ProjectId.make("project:recovery:rebuild");
      const threadId = ThreadId.make("thread:recovery:rebuild");
      const thread = makeThread({ threadId, projectId, now });

      yield* seedProject({ projectId });
      yield* sink.write({
        events: [threadCreatedEvent({ id: "event:recovery:rebuild:create", thread, now })],
      });
      yield* config.set({
        expectedRevision: 0,
        override: { version: CIVILIZATION_CONFIG_VERSION, participation: { enabled: true } },
      });
      yield* config.set({
        projectId,
        expectedRevision: 0,
        override: { version: CIVILIZATION_CONFIG_VERSION, context: { rosterCount: 4 } },
      });
      yield* seedLatestFeatureRows({ projectId, threadId, lastAppliedSequence: 1 });
      yield* assertRetainedStateCoherent(projectId);
      const before = yield* readFeatureState(projectId);

      assert.isTrue((yield* maintenance.verify).valid);
      assert.isTrue((yield* maintenance.rebuild).valid);
      assert.deepEqual(yield* readFeatureState(projectId), before);
      yield* assertRetainedStateCoherent(projectId);
      assert.equal(before.citizens[0]?.name_display, "Ada Recovery");
      assert.equal(before.citizens[0]?.profile_label, "Calm");
      assert.equal(before.citizens[0]?.delivery_epoch, 8);
      assert.equal(before.messages[0]?.recipient_delivery_epoch, 7);
      assert.equal(before.messages[0]?.terminal_reason, "recipient_settled");
      assert.isNotNull(before.messages[0]?.terminal_at);
    }).pipe(Effect.provide(Layer.fresh(makeRecoveryLayer(SqlitePersistence.layerMemory)))),
);

it.effect("VACUUM INTO snapshot restore preserves config, notes, mail and epochs together", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-civ-recovery-"));
  const sourcePath = NodePath.join(tempDir, "state.sqlite");
  const snapshotPath = NodePath.join(tempDir, "snapshot.sqlite");
  const restoredPath = NodePath.join(tempDir, "restored.sqlite");
  const projectId = ProjectId.make("project:recovery:snapshot");
  const threadId = ThreadId.make("thread:recovery:snapshot");

  return Effect.gen(function* () {
    let snapshotted: Effect.Success<ReturnType<typeof readFeatureState>> | undefined;

    yield* Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const config = yield* ConfigService.CivilizationConfigService;
      yield* seedProject({ projectId, workspaceRoot: NodePath.join(tempDir, "project") });
      yield* config.set({
        expectedRevision: 0,
        override: {
          version: CIVILIZATION_CONFIG_VERSION,
          participation: { enabled: true },
          messaging: { enabled: true },
        },
      });
      yield* config.set({
        projectId,
        expectedRevision: 0,
        override: { version: CIVILIZATION_CONFIG_VERSION, context: { rosterCount: 6 } },
      });
      yield* seedLatestFeatureRows({ projectId, threadId, lastAppliedSequence: 12 });
      yield* assertRetainedStateCoherent(projectId);
      snapshotted = yield* readFeatureState(projectId);
      yield* sql`VACUUM INTO ${snapshotPath}`;
      NodeFS.copyFileSync(snapshotPath, restoredPath);

      yield* config.set({
        expectedRevision: 1,
        override: { version: CIVILIZATION_CONFIG_VERSION, participation: { enabled: false } },
      });
      yield* sql`
        UPDATE civilization_citizens
        SET epoch = epoch + 1, delivery_epoch = delivery_epoch + 1
        WHERE thread_id = ${threadId}
      `;
      yield* sql`
        UPDATE civilization_notes
        SET body = 'post-snapshot mutation', body_bytes = 22, revision = revision + 1
        WHERE note_id = 'note:recovery'
      `;
    }).pipe(Effect.provide(makeFileLayer(sourcePath)));

    assert.isDefined(snapshotted);
    yield* Effect.gen(function* () {
      const config = yield* ConfigService.CivilizationConfigService;
      const restored = yield* readFeatureState(projectId);
      assert.deepEqual(restored, snapshotted);
      yield* assertRetainedStateCoherent(projectId);
      const effective = yield* config.getEffective(projectId);
      assert.isTrue(effective.config.participation.enabled);
      assert.equal(effective.environmentRevision, 1);
      assert.equal(effective.projectRevision, 1);
      assert.equal(restored.citizens[0]?.epoch, 7);
      assert.equal(restored.citizens[0]?.delivery_epoch, 8);
      assert.equal(restored.notes[0]?.body, "snapshot note body");
      assert.equal(restored.messages[0]?.body, "closed mail body");
      assert.equal(restored.messages[0]?.terminal_reason, "recipient_settled");
    }).pipe(Effect.provide(makeFileLayer(restoredPath)));
  }).pipe(
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});

it.effect(
  "partial and corrupt feature state fails writes closed instead of synthesizing replacement state",
  () => {
    const database = NodeSqliteClient.layer({ filename: ":memory:" });
    const configLayer = ConfigService.layer.pipe(Layer.provide(database));
    const knowledgeLayer = KnowledgeService.layer.pipe(Layer.provide(database));
    const layer = Layer.mergeAll(database, configLayer, knowledgeLayer);
    return Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const config = yield* ConfigService.CivilizationConfigService;
      const knowledge = yield* KnowledgeService.CivilizationKnowledgeService;
      const projectId = ProjectId.make("project:recovery:partial");
      const threadId = ThreadId.make("thread:recovery:partial");
      yield* runMigrations({ toMigrationInclusive: 64 });
      yield* seedProject({ projectId });
      yield* config.set({
        expectedRevision: 0,
        override: { version: CIVILIZATION_CONFIG_VERSION, participation: { enabled: true } },
      });
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
        'partial-name', 1, 'Partial', 'Partial', 'partial', 'default-names', 1, 0,
        'partial-profile', 'Calm', '[]', '', 'default-profiles', 1, 0,
        0, 'Partial', NULL, 'Partial', NULL, NULL, NULL,
        0, 0, 0, 1, ${fixedTime}, ${fixedTime}
      )
    `;

      const partialWrite = yield* Effect.flip(
        knowledge.createNote({
          caller: {
            threadId,
            projectId,
            epoch: 0,
            runtimeMode: "full-access",
            interactionMode: "default",
          },
          clientRequestId: "partial-write",
          category: "fact",
          body: "must fail",
        }),
      );
      assert.equal((partialWrite as { readonly _tag?: string })._tag, "SqlError");
      assert.deepEqual(
        yield* sql<{ readonly name: string }>`
        SELECT name FROM sqlite_master
        WHERE type = 'table' AND name IN ('civilization_project_state', 'civilization_notes')
        ORDER BY name ASC
      `,
        [],
        "a write against a partial restore must not initialize a second feature authority",
      );
      assert.equal(
        (yield* sql<{
          readonly count: number;
        }>`SELECT COUNT(*) AS count FROM civilization_citizens`)[0]?.count,
        1,
      );

      yield* sql`
      UPDATE civilization_environment_config
      SET override_json = '{broken json', revision = 2
      WHERE singleton = 1
    `;
      const corruptWrite = yield* Effect.flip(
        config.set({
          expectedRevision: 2,
          override: { version: CIVILIZATION_CONFIG_VERSION, participation: { enabled: false } },
        }),
      );
      assert.equal(
        (corruptWrite as { readonly _tag?: string })._tag,
        "CivilizationUnavailableError",
      );
      assert.equal((corruptWrite as { readonly reason?: string }).reason, "corrupt_state");
      assert.equal(
        (yield* sql<{ readonly revision: number; readonly override_json: string | null }>`
        SELECT revision, override_json FROM civilization_environment_config WHERE singleton = 1
      `)[0]?.revision,
        2,
      );
      assert.equal(
        (yield* sql<{ readonly revision: number; readonly override_json: string | null }>`
        SELECT revision, override_json FROM civilization_environment_config WHERE singleton = 1
      `)[0]?.override_json,
        "{broken json",
      );
    }).pipe(Effect.provide(Layer.fresh(layer)));
  },
);

it.effect("worktree removal and path changes leave project-scoped feature state intact", () => {
  const tempDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-civ-worktree-recovery-"));
  const oldWorktree = NodePath.join(tempDir, "old-worktree");
  const newWorktree = NodePath.join(tempDir, "new-worktree");
  NodeFS.mkdirSync(oldWorktree, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(oldWorktree, "tracked.txt"), "synthetic fixture\n", "utf8");

  return Effect.gen(function* () {
    const sink = yield* EventSink.EventSinkV2;
    const eventStore = yield* EventStore.EventStoreV2;
    const sql = yield* SqlClient.SqlClient;
    const now = yield* DateTime.now;
    const projectId = ProjectId.make("project:recovery:worktree");
    const threadId = ThreadId.make("thread:recovery:worktree");
    const thread = makeThread({ threadId, projectId, now, worktreePath: oldWorktree });
    yield* seedProject({ projectId, workspaceRoot: tempDir });
    yield* sink.write({
      events: [threadCreatedEvent({ id: "event:recovery:worktree:create", thread, now })],
    });
    yield* seedLatestFeatureRows({
      projectId,
      threadId,
      lastAppliedSequence: yield* eventStore.latestSequence(),
    });
    const beforeRemoval = yield* readFeatureState(projectId);

    NodeFS.rmSync(oldWorktree, { recursive: true, force: true });
    assert.isFalse(NodeFS.existsSync(oldWorktree));
    assert.deepEqual(yield* readFeatureState(projectId), beforeRemoval);

    const movedThread: OrchestrationV2AppThread = {
      ...thread,
      worktreePath: newWorktree,
      branch: "feature/recovery-moved",
      updatedAt: now,
    };
    yield* sink.write({
      events: [
        threadMetadataEvent({ id: "event:recovery:worktree:moved", thread: movedThread, now }),
      ],
    });
    const hostRow = (yield* sql<{ readonly worktree_path: string | null }>`
        SELECT json_extract(payload_json, '$.worktreePath') AS worktree_path
        FROM orchestration_v2_projection_threads
        WHERE thread_id = ${threadId}
      `)[0];
    assert.equal(hostRow?.worktree_path, newWorktree);
    const afterMove = yield* readFeatureState(projectId);
    assert.equal(afterMove.citizens.length, 1);
    assert.equal(afterMove.citizens[0]?.name_display, beforeRemoval.citizens[0]?.name_display);
    assert.equal(afterMove.citizens[0]?.profile_label, beforeRemoval.citizens[0]?.profile_label);
    assert.equal(afterMove.notes[0]?.body, beforeRemoval.notes[0]?.body);
    assert.equal(afterMove.messages[0]?.body, beforeRemoval.messages[0]?.body);
    assert.equal(afterMove.messages[0]?.terminal_reason, "recipient_settled");
    yield* assertRetainedStateCoherent(projectId);
  }).pipe(
    Effect.provide(Layer.fresh(makeRecoveryLayer(SqlitePersistence.layerMemory))),
    Effect.ensuring(Effect.sync(() => NodeFS.rmSync(tempDir, { recursive: true, force: true }))),
  );
});
