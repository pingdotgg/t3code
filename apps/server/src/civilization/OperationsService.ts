// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off -- export snapshots and preview hashes are deliberate JSON boundaries.
import {
  CIVILIZATION_EXPORT_SCHEMA_VERSION,
  CivilizationPurgeConflictError,
  type CivilizationProjectDataExport,
  type CivilizationPurgeCounts,
  type CivilizationPurgePreview,
  type CivilizationPurgeProgress,
  type ProjectId,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/sql/SqlClient";
import * as NodeCrypto from "node:crypto";

import * as ConfigService from "./ConfigService.ts";

const DEFAULT_BATCH = 100;
const MAX_BATCH = 1000;
const PROJECT_TOMBSTONE_THREAD_ID = "__project__";
const DEFAULT_NOTE_RETENTION_DAYS = 30;
const DEFAULT_DIAGNOSTIC_RETENTION_DAYS = 7;
const DEFAULT_TOMBSTONE_RETENTION_DAYS = 30;
const EXCLUDED_EXPORT_DATA = [
  "provider-native content",
  "host transcripts",
  "user copies",
  "database backups",
  "authentication sessions/tokens",
  "provider credentials",
  "historical Civilization context inspection records and packet bodies",
] as const;
const PURGE_WARNINGS = [
  "Purge applies only to Civilization feature tables in this host database.",
  "Provider-native content, host transcripts, user copies, and database backups are outside this purge.",
] as const;

type StateRow = {
  readonly census_revision: number;
  readonly notes_revision: number;
  readonly mail_revision: number;
};

type ConfigRow = { readonly revision: number };
type CountRow = { readonly count: number; readonly bytes: number };
type ThreadRow = { readonly thread_id: string };
type DeletedProjectRow = { readonly deleted_at: string | null };
type RetentionStateRow = {
  readonly applied_note_retention_days: number;
  readonly applied_diagnostic_retention_days: number;
  readonly applied_tombstone_retention_days: number;
};

type RetentionPolicy = {
  readonly noteRetentionDays: number;
  readonly diagnosticRetentionDays: number;
  readonly tombstoneRetentionDays: number;
};

const limitations = {
  mode: "inspection_backup_only" as const,
  inspectionBackupOnly: true,
  restorable: false,
  excluded: [...EXCLUDED_EXPORT_DATA],
} as const;

const hash = (value: unknown) =>
  `sha256:${NodeCrypto.createHash("sha256").update(JSON.stringify(value), "utf8").digest("hex")}`;

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ConfigService.CivilizationConfigService;

  const readAppliedRetentionPolicy = Effect.fn("CivilizationOperations.readAppliedRetentionPolicy")(
    function* (projectId: ProjectId) {
      const row = (yield* sql<RetentionStateRow>`
        SELECT applied_note_retention_days,
               applied_diagnostic_retention_days,
               applied_tombstone_retention_days
        FROM civilization_project_state
        WHERE project_id = ${projectId}
        LIMIT 1
      `)[0];
      return {
        noteRetentionDays: row?.applied_note_retention_days ?? DEFAULT_NOTE_RETENTION_DAYS,
        diagnosticRetentionDays:
          row?.applied_diagnostic_retention_days ?? DEFAULT_DIAGNOSTIC_RETENTION_DAYS,
        tombstoneRetentionDays:
          row?.applied_tombstone_retention_days ?? DEFAULT_TOMBSTONE_RETENTION_DAYS,
      } satisfies RetentionPolicy;
    },
  );

  const writeAppliedRetentionPolicy = Effect.fn(
    "CivilizationOperations.writeAppliedRetentionPolicy",
  )(function* (projectId: ProjectId, policy: RetentionPolicy) {
    const now = DateTime.formatIso(yield* DateTime.now);
    yield* sql`
      INSERT INTO civilization_project_state (
        project_id, census_revision, notes_revision, updated_at,
        mail_revision, retained_message_count, retained_body_bytes,
        applied_note_retention_days, applied_diagnostic_retention_days,
        applied_tombstone_retention_days
      ) VALUES (
        ${projectId}, 0, 0, ${now}, 0, 0, 0,
        ${policy.noteRetentionDays}, ${policy.diagnosticRetentionDays}, ${policy.tombstoneRetentionDays}
      )
      ON CONFLICT(project_id) DO UPDATE SET
        applied_note_retention_days = excluded.applied_note_retention_days,
        applied_diagnostic_retention_days = excluded.applied_diagnostic_retention_days,
        applied_tombstone_retention_days = excluded.applied_tombstone_retention_days,
        updated_at = excluded.updated_at
    `;
  });

  const configuredRetentionPolicy = Effect.fn("CivilizationOperations.configuredRetentionPolicy")(
    function* (projectId: ProjectId) {
      const effective = yield* config.getEffective(projectId);
      return {
        policy: {
          noteRetentionDays: effective.config.knowledge.retentionDays,
          diagnosticRetentionDays: effective.config.operations.diagnosticRetentionDays,
          tombstoneRetentionDays: effective.config.operations.tombstoneRetentionDays,
        } satisfies RetentionPolicy,
        environmentRevision: effective.environmentRevision,
        projectRevision: effective.projectRevision,
        cleanupBatch: effective.config.operations.cleanupBatch,
      } as const;
    },
  );

  const getAppliedRetentionPolicy = Effect.fn("CivilizationOperations.getAppliedRetentionPolicy")(
    function* (projectId: ProjectId) {
      const current = yield* readAppliedRetentionPolicy(projectId);
      const configured = yield* configuredRetentionPolicy(projectId);
      // Increases are safe to adopt immediately. Reductions remain pinned to the
      // last approved horizon until applyRetentionReduction commits them.
      const next = {
        noteRetentionDays: Math.max(current.noteRetentionDays, configured.policy.noteRetentionDays),
        diagnosticRetentionDays: Math.max(
          current.diagnosticRetentionDays,
          configured.policy.diagnosticRetentionDays,
        ),
        tombstoneRetentionDays: Math.max(
          current.tombstoneRetentionDays,
          configured.policy.tombstoneRetentionDays,
        ),
      } satisfies RetentionPolicy;
      if (
        next.noteRetentionDays !== current.noteRetentionDays ||
        next.diagnosticRetentionDays !== current.diagnosticRetentionDays ||
        next.tombstoneRetentionDays !== current.tombstoneRetentionDays
      ) {
        yield* writeAppliedRetentionPolicy(projectId, next);
      }
      return next;
    },
  );

  const readRetentionReductionPreview = Effect.fn(
    "CivilizationOperations.readRetentionReductionPreview",
  )(function* (projectId: ProjectId) {
    const now = DateTime.formatIso(yield* DateTime.now);
    const currentStored = yield* readAppliedRetentionPolicy(projectId);
    const configured = yield* configuredRetentionPolicy(projectId);
    // Treat configured increases as already applied for preview purposes; they
    // cannot make existing data newly eligible for deletion.
    const current = {
      noteRetentionDays: Math.max(
        currentStored.noteRetentionDays,
        configured.policy.noteRetentionDays,
      ),
      diagnosticRetentionDays: Math.max(
        currentStored.diagnosticRetentionDays,
        configured.policy.diagnosticRetentionDays,
      ),
      tombstoneRetentionDays: Math.max(
        currentStored.tombstoneRetentionDays,
        configured.policy.tombstoneRetentionDays,
      ),
    } satisfies RetentionPolicy;
    const proposed = {
      noteRetentionDays: Math.min(current.noteRetentionDays, configured.policy.noteRetentionDays),
      diagnosticRetentionDays: Math.min(
        current.diagnosticRetentionDays,
        configured.policy.diagnosticRetentionDays,
      ),
      tombstoneRetentionDays: Math.min(
        current.tombstoneRetentionDays,
        configured.policy.tombstoneRetentionDays,
      ),
    } satisfies RetentionPolicy;
    const sampleLimit = Math.max(1, Math.min(MAX_BATCH, Math.trunc(configured.cleanupBatch)));

    const noteEligibility =
      proposed.noteRetentionDays < current.noteRetentionDays
        ? (yield* sql<{ readonly count: number; readonly bytes: number }>`
              SELECT COUNT(*) AS count, COALESCE(SUM(body_bytes), 0) AS bytes
              FROM civilization_notes
              WHERE project_id = ${projectId}
                AND resolved_at IS NOT NULL
                AND strftime('%Y-%m-%dT%H:%M:%fZ', resolved_at, '+' || ${proposed.noteRetentionDays} || ' days') <= ${now}
                AND strftime('%Y-%m-%dT%H:%M:%fZ', resolved_at, '+' || ${current.noteRetentionDays} || ' days') > ${now}
            `)[0]!
        : { count: 0, bytes: 0 };
    const noteSample =
      noteEligibility.count === 0
        ? []
        : yield* sql<{ readonly note_id: string }>`
            SELECT note_id FROM civilization_notes
            WHERE project_id = ${projectId}
              AND resolved_at IS NOT NULL
              AND strftime('%Y-%m-%dT%H:%M:%fZ', resolved_at, '+' || ${proposed.noteRetentionDays} || ' days') <= ${now}
              AND strftime('%Y-%m-%dT%H:%M:%fZ', resolved_at, '+' || ${current.noteRetentionDays} || ' days') > ${now}
            ORDER BY resolved_at ASC, note_id ASC
            LIMIT ${sampleLimit}
          `;

    const diagnosticEligibility =
      proposed.diagnosticRetentionDays < current.diagnosticRetentionDays
        ? (yield* sql<{ readonly count: number }>`
              SELECT COUNT(*) AS count FROM civilization_context_references
              WHERE project_id = ${projectId}
                AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+' || ${proposed.diagnosticRetentionDays} || ' days') <= ${now}
                AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+' || ${current.diagnosticRetentionDays} || ' days') > ${now}
            `)[0]!.count
        : 0;
    const diagnosticSample =
      diagnosticEligibility === 0
        ? []
        : yield* sql<{ readonly context_reference_id: string }>`
            SELECT context_reference_id FROM civilization_context_references
            WHERE project_id = ${projectId}
              AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+' || ${proposed.diagnosticRetentionDays} || ' days') <= ${now}
              AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+' || ${current.diagnosticRetentionDays} || ' days') > ${now}
            ORDER BY created_at ASC, context_reference_id ASC
            LIMIT ${sampleLimit}
          `;

    const diagnosticInspectionEligibility =
      proposed.diagnosticRetentionDays < current.diagnosticRetentionDays
        ? (yield* sql<{ readonly count: number }>`
              SELECT COUNT(*) AS count FROM civilization_context_inspections
              WHERE project_id = ${projectId}
                AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+' || ${proposed.diagnosticRetentionDays} || ' days') <= ${now}
                AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+' || ${current.diagnosticRetentionDays} || ' days') > ${now}
            `)[0]!.count
        : 0;
    const diagnosticInspectionSample =
      diagnosticInspectionEligibility === 0
        ? []
        : yield* sql<{ readonly inspection_id: string }>`
            SELECT inspection_id FROM civilization_context_inspections
            WHERE project_id = ${projectId}
              AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+' || ${proposed.diagnosticRetentionDays} || ' days') <= ${now}
              AND strftime('%Y-%m-%dT%H:%M:%fZ', created_at, '+' || ${current.diagnosticRetentionDays} || ' days') > ${now}
            ORDER BY created_at ASC, inspection_id ASC
            LIMIT ${sampleLimit}
          `;

    const tombstoneEligibility =
      proposed.tombstoneRetentionDays < current.tombstoneRetentionDays
        ? (yield* sql<{ readonly count: number }>`
              SELECT COUNT(*) AS count FROM civilization_purge_tombstones
              WHERE project_id = ${projectId}
                AND progress_state = 'complete'
                AND purge_completed_at IS NOT NULL
                AND retention_days > ${proposed.tombstoneRetentionDays}
                AND strftime('%Y-%m-%dT%H:%M:%fZ', purge_completed_at, '+' || ${proposed.tombstoneRetentionDays} || ' days') <= ${now}
                AND strftime('%Y-%m-%dT%H:%M:%fZ', purge_completed_at, '+' || retention_days || ' days') > ${now}
            `)[0]!.count
        : 0;
    const tombstoneSample =
      tombstoneEligibility === 0
        ? []
        : yield* sql<{ readonly thread_id: string }>`
            SELECT thread_id FROM civilization_purge_tombstones
            WHERE project_id = ${projectId}
              AND progress_state = 'complete'
              AND purge_completed_at IS NOT NULL
              AND retention_days > ${proposed.tombstoneRetentionDays}
              AND strftime('%Y-%m-%dT%H:%M:%fZ', purge_completed_at, '+' || ${proposed.tombstoneRetentionDays} || ' days') <= ${now}
              AND strftime('%Y-%m-%dT%H:%M:%fZ', purge_completed_at, '+' || retention_days || ' days') > ${now}
            ORDER BY purge_completed_at ASC, thread_id ASC
            LIMIT ${sampleLimit}
          `;

    const newlyEligible = {
      resolvedNotes: noteEligibility.count,
      resolvedNoteBodyBytes: noteEligibility.bytes,
      diagnosticReferences: diagnosticEligibility,
      diagnosticInspections: diagnosticInspectionEligibility,
      tombstones: tombstoneEligibility,
    } as const;
    const samples = {
      noteIds: noteSample.map((row) => row.note_id),
      contextReferenceIds: diagnosticSample.map((row) => row.context_reference_id),
      contextInspectionIds: diagnosticInspectionSample.map((row) => row.inspection_id),
      tombstoneThreadIds: tombstoneSample.map((row) => row.thread_id),
      partial:
        noteEligibility.count > noteSample.length ||
        diagnosticEligibility > diagnosticSample.length ||
        diagnosticInspectionEligibility > diagnosticInspectionSample.length ||
        tombstoneEligibility > tombstoneSample.length,
    } as const;
    const tokenSource = {
      projectId,
      environmentRevision: configured.environmentRevision,
      projectRevision: configured.projectRevision,
      current,
      configured: configured.policy,
      proposed,
      newlyEligible,
      samples,
    };
    return {
      projectId,
      previewToken: hash(tokenSource),
      environmentRevision: configured.environmentRevision,
      projectRevision: configured.projectRevision,
      current,
      configured: configured.policy,
      proposed,
      newlyEligible,
      samples,
      warnings: [
        "Applying this preview changes only approved retention horizons. Scheduled bounded cleanup performs physical deletion afterward.",
        "Active notes and citizen identity are not retention-cleanup candidates.",
      ],
    } as const;
  });

  const previewRetentionReduction = Effect.fn("CivilizationOperations.previewRetentionReduction")(
    function* (projectId: ProjectId) {
      return yield* sql.withTransaction(readRetentionReductionPreview(projectId));
    },
  );

  const applyRetentionReduction = Effect.fn("CivilizationOperations.applyRetentionReduction")(
    function* (input: { readonly projectId: ProjectId; readonly expectedPreviewToken: string }) {
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const preview = yield* readRetentionReductionPreview(input.projectId);
          if (preview.previewToken !== input.expectedPreviewToken) {
            return yield* new CivilizationPurgeConflictError({
              code: "civilization_purge_conflict",
              projectId: input.projectId,
              message:
                "Civilization retention state changed after preview; preview again before applying.",
            });
          }
          yield* writeAppliedRetentionPolicy(input.projectId, preview.proposed);
          yield* sql`
          UPDATE civilization_purge_tombstones
          SET retention_days = MIN(retention_days, ${preview.proposed.tombstoneRetentionDays}),
              updated_at = ${DateTime.formatIso(yield* DateTime.now)}
          WHERE project_id = ${input.projectId}
            AND retention_days > ${preview.proposed.tombstoneRetentionDays}
        `;
          return {
            projectId: input.projectId,
            applied: preview.proposed,
            newlyEligible: preview.newlyEligible,
          } as const;
        }),
      );
    },
  );

  const tombstoneRetentionForProject = Effect.fn(
    "CivilizationOperations.tombstoneRetentionForProject",
  )(function* (projectId: ProjectId) {
    const existing = (yield* sql<{ readonly retention_days: number }>`
        SELECT retention_days FROM civilization_purge_tombstones
        WHERE project_id = ${projectId} AND thread_id = ${PROJECT_TOMBSTONE_THREAD_ID}
        LIMIT 1
      `)[0];
    if (existing !== undefined) return existing.retention_days;
    const applied = yield* readAppliedRetentionPolicy(projectId);
    const configured = yield* configuredRetentionPolicy(projectId).pipe(Effect.option);
    return configured._tag === "Some"
      ? Math.max(applied.tombstoneRetentionDays, configured.value.policy.tombstoneRetentionDays)
      : applied.tombstoneRetentionDays;
  });

  const exportProjectData = Effect.fn("CivilizationOperations.exportProjectData")(function* (
    projectId: ProjectId,
  ) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const exportedAt = DateTime.formatIso(yield* DateTime.now);
        const effective = yield* config.getEffective(projectId);
        const citizens = yield* sql<Record<string, unknown>>`
          SELECT thread_id, project_id, parent_thread_id, relationship_to_parent, root_thread_id,
                 generation, lineage_status, observed_only, birth_sequence, last_applied_sequence,
                 name_entry_id, name_generator_version, name_base, name_display, name_key, name_pool_id,
                 name_environment_revision, name_project_revision,
                 profile_entry_id, profile_label, profile_traits_json, profile_style_text, profile_pool_id,
                 profile_rich_label, profile_rich_traits_json, profile_rich_axiom,
                 profile_rich_voice, profile_rich_style_text,
                 profile_environment_revision, profile_project_revision,
                 title_managed, preserved_title, last_managed_title, title_topic,
                 pending_title_command_id, pending_managed_title, pending_title_topic,
                 epoch, closed, deleted, revision, created_at, updated_at,
                 delivery_epoch, delivery_settled, delivery_archived, delivery_deleted
          FROM civilization_citizens
          WHERE project_id = ${projectId}
          ORDER BY thread_id ASC
        `;
        const notes = yield* sql<Record<string, unknown>>`
          SELECT note_id, project_id, category, body, body_bytes, author_thread_id, author_epoch,
                 accepted_runtime_mode, accepted_interaction_mode, source_refs_json, revision,
                 created_at, updated_at, resolved_at
          FROM civilization_notes
          WHERE project_id = ${projectId}
          ORDER BY note_id ASC
        `;
        const mail = yield* sql<Record<string, unknown>>`
          SELECT message_id, project_id, sender_thread_id, sender_name_at_send, sender_citizen_epoch,
                 sender_run_id, recipient_thread_id, recipient_delivery_epoch, reply_to_message_id,
                 body, body_bytes, accepted_runtime_mode, accepted_interaction_mode,
                 accepted_environment_revision, accepted_project_revision, accepted_at, expires_at,
                 terminal_retention_days, first_offered_at, last_offered_at, offer_count,
                 acknowledged_at, terminal_at, terminal_reason
          FROM civilization_messages
          WHERE project_id = ${projectId}
          ORDER BY message_id ASC
        `;
        return {
          schemaVersion: CIVILIZATION_EXPORT_SCHEMA_VERSION,
          projectId,
          exportedAt,
          environmentRevision: effective.environmentRevision,
          projectRevision: effective.projectRevision,
          effectiveConfig: effective.config,
          limitations,
          citizens,
          notes: notes.map((note) => ({
            ...note,
            sourceReferences:
              typeof note.source_refs_json === "string"
                ? (JSON.parse(note.source_refs_json) as unknown)
                : [],
          })),
          mail,
        } satisfies CivilizationProjectDataExport;
      }),
    );
  });

  const readPurgePreview = Effect.fn("CivilizationOperations.readPurgePreview")(function* (
    projectId: ProjectId,
  ) {
    return yield* Effect.gen(function* () {
      const environmentRevision =
        (yield* sql<{ readonly revision: number }>`
            SELECT revision FROM civilization_environment_config WHERE singleton = 1 LIMIT 1
          `)[0]?.revision ?? 0;
      const projectRevision =
        (yield* sql<ConfigRow>`
            SELECT revision FROM civilization_project_config WHERE project_id = ${projectId} LIMIT 1
          `)[0]?.revision ?? 0;
      const state = (yield* sql<StateRow>`
            SELECT census_revision, notes_revision, mail_revision
            FROM civilization_project_state WHERE project_id = ${projectId} LIMIT 1
          `)[0] ?? { census_revision: 0, notes_revision: 0, mail_revision: 0 };
      const citizens =
        (yield* sql<CountRow>`SELECT COUNT(*) AS count, 0 AS bytes FROM civilization_citizens WHERE project_id = ${projectId}`)[0]!;
      const notes =
        (yield* sql<CountRow>`SELECT COUNT(*) AS count, COALESCE(SUM(body_bytes), 0) AS bytes FROM civilization_notes WHERE project_id = ${projectId}`)[0]!;
      const messages =
        (yield* sql<CountRow>`SELECT COUNT(*) AS count, COALESCE(SUM(body_bytes), 0) AS bytes FROM civilization_messages WHERE project_id = ${projectId}`)[0]!;
      const contextReferences =
        (yield* sql<CountRow>`SELECT COUNT(*) AS count, 0 AS bytes FROM civilization_context_references WHERE project_id = ${projectId}`)[0]!;
      const contextInspections =
        (yield* sql<CountRow>`SELECT COUNT(*) AS count, 0 AS bytes FROM civilization_context_inspections WHERE project_id = ${projectId}`)[0]!;
      const receipts =
        (yield* sql<CountRow>`SELECT COUNT(*) AS count, 0 AS bytes FROM civilization_mail_operation_receipts WHERE project_id = ${projectId}`)[0]!;
      const quotaWindows =
        (yield* sql<CountRow>`SELECT COUNT(*) AS count, 0 AS bytes FROM civilization_mail_quota_windows WHERE project_id = ${projectId}`)[0]!;
      const projectConfigRows =
        (yield* sql<CountRow>`SELECT COUNT(*) AS count, 0 AS bytes FROM civilization_project_config WHERE project_id = ${projectId}`)[0]!;
      const projectStateRows =
        (yield* sql<CountRow>`SELECT COUNT(*) AS count, 0 AS bytes FROM civilization_project_state WHERE project_id = ${projectId}`)[0]!;
      const counts = {
        citizens: citizens.count,
        notes: notes.count,
        noteBodyBytes: notes.bytes,
        messages: messages.count,
        messageBodyBytes: messages.bytes,
        contextReferences: contextReferences.count,
        contextInspections: contextInspections.count,
        receipts: receipts.count,
        quotaWindows: quotaWindows.count,
        projectConfigRows: projectConfigRows.count,
        projectStateRows: projectStateRows.count,
      } satisfies CivilizationPurgeCounts;
      const tokenSource = {
        projectId,
        environmentRevision,
        projectRevision,
        censusRevision: state.census_revision,
        notesRevision: state.notes_revision,
        mailRevision: state.mail_revision,
        counts,
      };
      return {
        projectId,
        previewToken: hash(tokenSource),
        environmentRevision,
        projectRevision,
        censusRevision: state.census_revision,
        notesRevision: state.notes_revision,
        mailRevision: state.mail_revision,
        counts,
        limitations,
        warnings: [...PURGE_WARNINGS],
      } satisfies CivilizationPurgePreview;
    });
  });

  const previewPurge = Effect.fn("CivilizationOperations.previewPurge")(function* (
    projectId: ProjectId,
  ) {
    return yield* sql.withTransaction(readPurgePreview(projectId));
  });

  const remainingCount = Effect.fn("CivilizationOperations.remainingCount")(function* (
    projectId: ProjectId,
  ) {
    const preview = yield* readPurgePreview(projectId);
    const counts = preview.counts;
    return (
      counts.citizens +
      counts.notes +
      counts.messages +
      counts.contextReferences +
      counts.contextInspections +
      counts.receipts +
      counts.quotaWindows +
      counts.projectConfigRows +
      counts.projectStateRows
    );
  });

  const purgeBatch = Effect.fn("CivilizationOperations.purgeBatch")(function* (input: {
    readonly projectId: ProjectId;
    readonly batchSize: number;
    readonly deletionAt: string | null;
    readonly previewToken: string | null;
    readonly tombstoneRetentionDays: number;
    readonly restartCompleted?: boolean | undefined;
  }) {
    const batchSize = Math.max(1, Math.min(MAX_BATCH, Math.trunc(input.batchSize)));
    const now = DateTime.formatIso(yield* DateTime.now);
    const existing = (yield* sql<{
      readonly purge_started_at: string;
      readonly preview_token: string | null;
      readonly retention_days: number;
      readonly progress_state: string;
    }>`
        SELECT purge_started_at, preview_token, retention_days, progress_state
        FROM civilization_purge_tombstones
        WHERE project_id = ${input.projectId} AND thread_id = ${PROJECT_TOMBSTONE_THREAD_ID}
        LIMIT 1
      `)[0];
    const restartCompleted =
      input.restartCompleted === true && existing?.progress_state === "complete";
    const startedAt = restartCompleted ? now : (existing?.purge_started_at ?? now);
    const tombstoneRetentionDays = restartCompleted
      ? input.tombstoneRetentionDays
      : (existing?.retention_days ?? input.tombstoneRetentionDays);
    yield* sql`
      INSERT INTO civilization_purge_tombstones (
        project_id, thread_id, deletion_at, purge_started_at, purge_completed_at, preview_token,
        retention_days, progress_state, updated_at
      ) VALUES (${input.projectId}, ${PROJECT_TOMBSTONE_THREAD_ID}, ${input.deletionAt}, ${startedAt}, NULL, ${input.previewToken ?? existing?.preview_token ?? null}, ${tombstoneRetentionDays}, 'in_progress', ${now})
      ON CONFLICT(project_id, thread_id) DO UPDATE SET
        deletion_at = COALESCE(civilization_purge_tombstones.deletion_at, excluded.deletion_at),
        purge_started_at = CASE WHEN ${restartCompleted ? 1 : 0} = 1 THEN excluded.purge_started_at ELSE civilization_purge_tombstones.purge_started_at END,
        purge_completed_at = CASE WHEN ${restartCompleted ? 1 : 0} = 1 THEN NULL ELSE civilization_purge_tombstones.purge_completed_at END,
        preview_token = CASE WHEN ${restartCompleted ? 1 : 0} = 1 THEN excluded.preview_token ELSE COALESCE(civilization_purge_tombstones.preview_token, excluded.preview_token) END,
        retention_days = CASE WHEN ${restartCompleted ? 1 : 0} = 1 THEN excluded.retention_days ELSE civilization_purge_tombstones.retention_days END,
        progress_state = CASE WHEN ${restartCompleted ? 1 : 0} = 1 THEN 'in_progress' WHEN civilization_purge_tombstones.progress_state = 'complete' THEN 'complete' ELSE 'in_progress' END,
        updated_at = excluded.updated_at
    `;

    let remainingBatch = batchSize;
    let deleted = 0;
    const deleteRows = Effect.fn("CivilizationOperations.deleteRows")(function* (table: string) {
      if (remainingBatch <= 0) return;
      // Table names are a fixed internal list below; values remain bound parameters.
      yield* sql.unsafe(
        `DELETE FROM ${table} WHERE rowid IN (SELECT rowid FROM ${table} WHERE project_id = ? LIMIT ?)`,
        [input.projectId, remainingBatch],
      );
      const changes =
        (yield* sql<{ readonly count: number }>`SELECT changes() AS count`)[0]?.count ?? 0;
      deleted += changes;
      remainingBatch -= changes;
    });

    yield* deleteRows("civilization_context_inspections");
    yield* deleteRows("civilization_context_references");
    yield* deleteRows("civilization_mail_operation_receipts");
    yield* deleteRows("civilization_mail_quota_windows");
    yield* deleteRows("civilization_messages");
    yield* deleteRows("civilization_notes");

    if (remainingBatch > 0) {
      const threads = yield* sql<ThreadRow>`
        SELECT thread_id FROM civilization_citizens
        WHERE project_id = ${input.projectId}
        ORDER BY thread_id ASC
        LIMIT ${remainingBatch}
      `;
      for (const thread of threads) {
        yield* sql`
          INSERT INTO civilization_purge_tombstones (
            project_id, thread_id, deletion_at, purge_started_at, purge_completed_at, preview_token,
            retention_days, progress_state, updated_at
          ) VALUES (${input.projectId}, ${thread.thread_id}, ${input.deletionAt}, ${startedAt}, NULL, NULL, ${tombstoneRetentionDays}, 'in_progress', ${now})
          ON CONFLICT(project_id, thread_id) DO UPDATE SET
            deletion_at = COALESCE(civilization_purge_tombstones.deletion_at, excluded.deletion_at),
            updated_at = excluded.updated_at
        `;
      }
      if (threads.length > 0) {
        yield* sql`
          DELETE FROM civilization_citizens
          WHERE project_id = ${input.projectId}
            AND thread_id IN ${sql.in(threads.map((thread) => thread.thread_id))}
        `;
        deleted += threads.length;
        remainingBatch -= threads.length;
      }
    }

    yield* deleteRows("civilization_project_config");
    yield* deleteRows("civilization_project_state");

    const remaining = yield* remainingCount(input.projectId);
    const complete = remaining === 0;
    yield* sql`
      UPDATE civilization_purge_tombstones
      SET progress_state = ${complete ? "complete" : "in_progress"},
          purge_completed_at = ${complete ? now : null},
          updated_at = ${now}
      WHERE project_id = ${input.projectId}
    `;
    return {
      projectId: input.projectId,
      complete,
      deletedThisBatch: deleted,
      remaining,
      progressState: complete ? "complete" : "in_progress",
      purgeStartedAt: startedAt,
      purgeCompletedAt: complete ? now : null,
    } satisfies CivilizationPurgeProgress;
  });

  const applyPurge = Effect.fn("CivilizationOperations.applyPurge")(function* (input: {
    readonly projectId: ProjectId;
    readonly expectedPreviewToken: string;
    readonly batchSize?: number | undefined;
  }) {
    return yield* sql.withTransaction(
      Effect.gen(function* () {
        const progress = (yield* sql<{
          readonly preview_token: string | null;
          readonly progress_state: string;
        }>`
            SELECT preview_token, progress_state
            FROM civilization_purge_tombstones
            WHERE project_id = ${input.projectId} AND thread_id = ${PROJECT_TOMBSTONE_THREAD_ID}
            LIMIT 1
          `)[0];
        const completedRemaining =
          progress?.progress_state === "complete" ? yield* remainingCount(input.projectId) : null;
        const completedReplay =
          progress?.progress_state === "complete" &&
          completedRemaining === 0 &&
          progress.preview_token === input.expectedPreviewToken;
        if (
          progress?.preview_token !== undefined &&
          progress.preview_token !== null &&
          progress.progress_state !== "complete"
        ) {
          if (progress.preview_token !== input.expectedPreviewToken) {
            return yield* new CivilizationPurgeConflictError({
              code: "civilization_purge_conflict",
              projectId: input.projectId,
              message: "This purge is already bound to a different approved preview token.",
            });
          }
        } else if (!completedReplay) {
          const effective = yield* config.getEffective(input.projectId);
          if (
            effective.config.participation.enabled &&
            !effective.config.participation.emergencyOff
          ) {
            return yield* new CivilizationPurgeConflictError({
              code: "civilization_purge_conflict",
              projectId: input.projectId,
              message:
                "Disable Civilization participation (or enable emergency-off) before purging a live project so background adoption cannot recreate identity during cleanup.",
            });
          }
          const current = yield* readPurgePreview(input.projectId);
          if (current.previewToken !== input.expectedPreviewToken) {
            return yield* new CivilizationPurgeConflictError({
              code: "civilization_purge_conflict",
              projectId: input.projectId,
              message:
                "Civilization project data changed after purge preview; preview again before applying.",
            });
          }
        }
        return yield* purgeBatch({
          projectId: input.projectId,
          batchSize: input.batchSize ?? DEFAULT_BATCH,
          deletionAt: null,
          previewToken: input.expectedPreviewToken,
          tombstoneRetentionDays: yield* tombstoneRetentionForProject(input.projectId),
          restartCompleted: progress?.progress_state === "complete" && !completedReplay,
        });
      }),
    );
  });

  const cleanupDeletedProject = Effect.fn("CivilizationOperations.cleanupDeletedProject")(
    function* (input: { readonly projectId: ProjectId; readonly batchSize?: number | undefined }) {
      const project = (yield* sql<DeletedProjectRow>`
        SELECT deleted_at FROM projection_projects WHERE project_id = ${input.projectId} LIMIT 1
      `)[0];
      if (project?.deleted_at === null || project === undefined) {
        return yield* new CivilizationPurgeConflictError({
          code: "civilization_purge_conflict",
          projectId: input.projectId,
          message: "Project-deletion cleanup requires a host project already marked deleted.",
        });
      }
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const tombstoneRetentionDays = yield* tombstoneRetentionForProject(input.projectId);
          return yield* purgeBatch({
            projectId: input.projectId,
            batchSize: input.batchSize ?? DEFAULT_BATCH,
            deletionAt: project.deleted_at,
            previewToken: null,
            tombstoneRetentionDays,
          });
        }),
      );
    },
  );

  return {
    exportProjectData,
    previewPurge,
    applyPurge,
    cleanupDeletedProject,
    getAppliedRetentionPolicy,
    previewRetentionReduction,
    applyRetentionReduction,
  } as const;
});

export type CivilizationOperationsServiceShape = Effect.Success<typeof make>;

export class CivilizationOperationsService extends Context.Service<
  CivilizationOperationsService,
  CivilizationOperationsServiceShape
>()("t3/civilization/OperationsService/CivilizationOperationsService") {}

export const layer = Layer.effect(CivilizationOperationsService, make);
