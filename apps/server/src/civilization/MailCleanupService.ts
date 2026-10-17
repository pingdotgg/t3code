import type { ProjectId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";

import * as Scheduler from "../scheduling/Scheduler.ts";
import * as ConfigService from "./ConfigService.ts";
import * as MailService from "./MailService.ts";
import * as OperationsService from "./OperationsService.ts";

const PROJECT_SCAN_LIMIT = 1000;
const DEFAULT_CLEANUP_BATCH = 100;

type CleanupCandidate = {
  readonly project_id: ProjectId;
  readonly last_mail_cleanup_at: string | null;
};

type DeletedProjectCandidate = {
  readonly project_id: ProjectId;
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const config = yield* ConfigService.CivilizationConfigService;
  const mail = yield* MailService.CivilizationMailService;
  const operations = yield* OperationsService.CivilizationOperationsService;

  const runDue = Effect.fn("CivilizationMailCleanup.runDue")(function* () {
    const now = yield* DateTime.now;
    const nowMs = DateTime.toEpochMillis(now);
    const nowIso = DateTime.formatIso(now);
    const candidates = yield* sql<CleanupCandidate>`
      SELECT s.project_id, s.last_mail_cleanup_at
      FROM civilization_project_state AS s
      LEFT JOIN projection_projects AS p ON p.project_id = s.project_id
      WHERE p.deleted_at IS NULL
        AND (
          s.mail_revision > 0
          OR s.retained_message_count > 0
          OR s.retained_body_bytes > 0
          OR EXISTS (
            SELECT 1 FROM civilization_context_references AS r
            WHERE r.project_id = s.project_id
          )
          OR EXISTS (
            SELECT 1 FROM civilization_context_inspections AS i
            WHERE i.project_id = s.project_id
          )
          OR EXISTS (
            SELECT 1 FROM civilization_notes AS n
            WHERE n.project_id = s.project_id AND n.resolved_at IS NOT NULL
          )
        )
      ORDER BY COALESCE(s.last_mail_cleanup_at, '') ASC, s.project_id ASC
      LIMIT ${PROJECT_SCAN_LIMIT}
    `;

    const deletedProjects = yield* sql<DeletedProjectCandidate>`
      SELECT p.project_id
      FROM projection_projects AS p
      WHERE p.deleted_at IS NOT NULL
        AND (
          EXISTS (SELECT 1 FROM civilization_citizens c WHERE c.project_id = p.project_id)
          OR EXISTS (SELECT 1 FROM civilization_notes n WHERE n.project_id = p.project_id)
          OR EXISTS (SELECT 1 FROM civilization_context_references r WHERE r.project_id = p.project_id)
          OR EXISTS (SELECT 1 FROM civilization_context_inspections i WHERE i.project_id = p.project_id)
          OR EXISTS (SELECT 1 FROM civilization_messages m WHERE m.project_id = p.project_id)
          OR EXISTS (SELECT 1 FROM civilization_mail_operation_receipts o WHERE o.project_id = p.project_id)
          OR EXISTS (SELECT 1 FROM civilization_mail_quota_windows q WHERE q.project_id = p.project_id)
          OR EXISTS (SELECT 1 FROM civilization_project_config pc WHERE pc.project_id = p.project_id)
          OR EXISTS (SELECT 1 FROM civilization_project_state ps WHERE ps.project_id = p.project_id)
          OR EXISTS (
            SELECT 1 FROM civilization_purge_tombstones t
            WHERE t.project_id = p.project_id AND t.progress_state <> 'complete'
          )
        )
      ORDER BY p.project_id ASC
      LIMIT ${PROJECT_SCAN_LIMIT}
    `;

    let cleaned = 0;
    let skipped = 0;
    for (const candidate of candidates) {
      const result = yield* Effect.exit(
        Effect.gen(function* () {
          const effective = yield* config.getEffective(candidate.project_id);
          const retention = yield* operations.getAppliedRetentionPolicy(candidate.project_id);
          const cadenceMs = effective.config.operations.cleanupCadenceMinutes * 60_000;
          const cleanupBatch = Math.max(
            1,
            Math.min(PROJECT_SCAN_LIMIT, Math.trunc(effective.config.operations.cleanupBatch)),
          );
          const parsedLastCleanup =
            candidate.last_mail_cleanup_at === null
              ? Option.none()
              : DateTime.make(candidate.last_mail_cleanup_at);
          const lastMs = Option.isSome(parsedLastCleanup)
            ? DateTime.toEpochMillis(parsedLastCleanup.value)
            : Number.NEGATIVE_INFINITY;
          if (Number.isFinite(lastMs) && nowMs - lastMs < cadenceMs) {
            return "skipped" as const;
          }

          yield* mail.cleanupProject(candidate.project_id);
          const noteRetentionCutoff = DateTime.formatIso(
            DateTime.subtract(now, { days: retention.noteRetentionDays }),
          );
          yield* sql`
            DELETE FROM civilization_notes
            WHERE rowid IN (
              SELECT rowid FROM civilization_notes
              WHERE project_id = ${candidate.project_id}
                AND resolved_at IS NOT NULL
                AND resolved_at <= ${noteRetentionCutoff}
              ORDER BY resolved_at ASC, note_id ASC
              LIMIT ${cleanupBatch}
            )
          `;
          const diagnosticRetentionCutoff = DateTime.formatIso(
            DateTime.subtract(now, { days: retention.diagnosticRetentionDays }),
          );
          yield* sql`
            DELETE FROM civilization_context_inspections
            WHERE rowid IN (
              SELECT rowid FROM civilization_context_inspections
              WHERE project_id = ${candidate.project_id}
                AND created_at <= ${diagnosticRetentionCutoff}
              ORDER BY created_at ASC, inspection_id ASC
              LIMIT ${cleanupBatch}
            )
          `;
          yield* sql`
            DELETE FROM civilization_context_references
            WHERE rowid IN (
              SELECT rowid FROM civilization_context_references
              WHERE project_id = ${candidate.project_id}
                AND created_at <= ${diagnosticRetentionCutoff}
              ORDER BY created_at ASC, context_reference_id ASC
              LIMIT ${cleanupBatch}
            )
          `;
          yield* sql`
            UPDATE civilization_project_state
            SET last_mail_cleanup_at = ${nowIso}, updated_at = ${nowIso}
            WHERE project_id = ${candidate.project_id}
          `;
          return "cleaned" as const;
        }),
      );
      if (Exit.isFailure(result)) {
        yield* Effect.logWarning("civilization.mail-cleanup.project-failed", {
          projectId: candidate.project_id,
          cause: result.cause,
        });
        continue;
      }
      if (result.value === "skipped") skipped += 1;
      else cleaned += 1;
    }

    let deletedProjectCleanups = 0;
    for (const candidate of deletedProjects) {
      const effective = yield* config.getEffective(candidate.project_id).pipe(Effect.option);
      const cleanupBatch =
        effective._tag === "Some"
          ? Math.max(
              1,
              Math.min(
                PROJECT_SCAN_LIMIT,
                Math.trunc(effective.value.config.operations.cleanupBatch),
              ),
            )
          : DEFAULT_CLEANUP_BATCH;
      const result = yield* Effect.exit(
        operations.cleanupDeletedProject({
          projectId: candidate.project_id,
          batchSize: cleanupBatch,
        }),
      );
      if (Exit.isFailure(result)) {
        yield* Effect.logWarning("civilization.deleted-project-cleanup.failed", {
          projectId: candidate.project_id,
          cause: result.cause,
        });
        continue;
      }
      deletedProjectCleanups += 1;
    }

    yield* sql`
      DELETE FROM civilization_purge_tombstones
      WHERE rowid IN (
        SELECT rowid FROM civilization_purge_tombstones
        WHERE progress_state = 'complete'
          AND purge_completed_at IS NOT NULL
          AND strftime(
            '%Y-%m-%dT%H:%M:%fZ',
            purge_completed_at,
            '+' || retention_days || ' days'
          ) <= ${nowIso}
        ORDER BY purge_completed_at ASC, project_id ASC, thread_id ASC
        LIMIT ${DEFAULT_CLEANUP_BATCH}
      )
    `;
    const deletedTombstones =
      (yield* sql<{ readonly count: number }>`SELECT changes() AS count`)[0]?.count ?? 0;

    return {
      scanned: candidates.length,
      cleaned,
      skipped,
      deletedProjectScanned: deletedProjects.length,
      deletedProjectCleanups,
      deletedTombstones,
    } as const;
  });

  return { runDue } as const;
});

export type CivilizationMailCleanupServiceShape = Effect.Success<typeof make>;

export class CivilizationMailCleanupService extends Context.Service<
  CivilizationMailCleanupService,
  CivilizationMailCleanupServiceShape
>()("t3/civilization/MailCleanupService/CivilizationMailCleanupService") {}

export const layerService = Layer.effect(CivilizationMailCleanupService, make);

export const layer = Layer.effectDiscard(
  Effect.gen(function* () {
    const cleanup = yield* CivilizationMailCleanupService;
    const scheduler = yield* Scheduler.Scheduler;
    yield* scheduler.register("civilization-mail-cleanup", cleanup.runDue().pipe(Effect.asVoid));
  }),
).pipe(Layer.provide(layerService));
