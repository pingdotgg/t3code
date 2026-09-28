import { Clock, Effect, Layer, Option, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import { EventId } from "@t3tools/contracts";

import { toPersistenceSqlError } from "../Errors.ts";
import { redactAuditPayload } from "../../orchestration/auditRedaction.ts";
import {
  WorktreeCleanupFailureResult,
  WorktreeCleanupIntent,
  WorktreeCleanupJob,
  WorktreeCleanupJobRepository,
  WorktreeCleanupReservation,
  type WorktreeCleanupJobRepositoryShape,
} from "../Services/WorktreeCleanupJobs.ts";

const ThreadRequest = Schema.Struct({ threadId: WorktreeCleanupJob.fields.threadId });
const DueJobsRequest = Schema.Struct({ now: WorktreeCleanupJob.fields.requestedAt });
const ReservationByPathRequest = Schema.Struct({
  canonicalWorktreePath: Schema.String,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const recordAuditTransition = (input: {
    readonly threadId: WorktreeCleanupJob["threadId"];
    readonly eventType:
      | "cleanup.requested"
      | "cleanup.queued"
      | "cleanup.started"
      | "cleanup.completed"
      | "cleanup.failed"
      | "cleanup.cancelled";
    readonly suffix: string;
    readonly occurredAt: string;
    readonly payload: unknown;
  }) =>
    Effect.gen(function* () {
      const linked = yield* sql<{
        readonly operationId: string;
        readonly attemptId: string;
        readonly sourceThreadId: string;
        readonly sourceTurnId: string | null;
        readonly sourceMessageId: string | null;
        readonly contextJson: string;
      }>`
        SELECT
          operation_id AS "operationId",
          attempt_id AS "attemptId",
          source_thread_id AS "sourceThreadId",
          source_turn_id AS "sourceTurnId",
          source_message_id AS "sourceMessageId",
          context_json AS "contextJson"
        FROM delegation_audit_events
        WHERE child_thread_id = ${input.threadId}
          AND attempt_id IS NOT NULL
        ORDER BY sequence DESC
        LIMIT 1
      `;
      const attempt = linked[0];
      if (!attempt) return;

      const safe = redactAuditPayload(input.payload);
      yield* sql`
        INSERT OR IGNORE INTO delegation_audit_events (
          event_id,
          operation_id,
          attempt_id,
          source_thread_id,
          source_turn_id,
          source_message_id,
          child_thread_id,
          event_type,
          occurred_at,
          evidence_status,
          redacted,
          context_json,
          payload_json
        )
        VALUES (
          ${EventId.make(
            `delegation-audit:${attempt.operationId}:${attempt.attemptId}:${input.eventType}:${input.suffix}`,
          )},
          ${attempt.operationId},
          ${attempt.attemptId},
          ${attempt.sourceThreadId},
          ${attempt.sourceTurnId},
          ${attempt.sourceMessageId},
          ${input.threadId},
          ${input.eventType},
          ${input.occurredAt},
          ${safe.evidenceStatus},
          ${safe.redacted ? 1 : 0},
          ${attempt.contextJson},
          ${JSON.stringify(safe.payload)}
        )
      `;
    });

  const getJobRow = SqlSchema.findOneOption({
    Request: ThreadRequest,
    Result: WorktreeCleanupJob,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          cwd,
          worktree_path AS "worktreePath",
          canonical_worktree_path AS "canonicalWorktreePath",
          requested_at AS "requestedAt",
          source,
          status,
          attempt_count AS "attemptCount",
          next_attempt_at AS "nextAttemptAt",
          last_reason AS "lastReason",
          last_error AS "lastError"
        FROM worktree_cleanup_jobs
        WHERE thread_id = ${threadId}
      `,
  });

  const getReservationByPath = SqlSchema.findOneOption({
    Request: ReservationByPathRequest,
    Result: WorktreeCleanupReservation,
    execute: ({ canonicalWorktreePath }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          canonical_worktree_path AS "canonicalWorktreePath",
          reserved_at AS "reservedAt"
        FROM worktree_cleanup_reservations
        WHERE canonical_worktree_path = ${canonicalWorktreePath}
      `,
  });

  const enqueueJob = SqlSchema.void({
    Request: WorktreeCleanupIntent,
    execute: (intent) => {
      const allowTerminalReset = intent.allowTerminalReset ? 1 : 0;
      return sql`
        INSERT INTO worktree_cleanup_jobs (
          thread_id,
          cwd,
          worktree_path,
          canonical_worktree_path,
          requested_at,
          source,
          status,
          attempt_count,
          next_attempt_at,
          last_reason,
          last_error
        )
        VALUES (
          ${intent.threadId},
          ${intent.cwd},
          ${intent.worktreePath},
          ${intent.canonicalWorktreePath},
          ${intent.requestedAt},
          ${intent.source},
          'waiting',
          0,
          ${intent.requestedAt},
          NULL,
          NULL
        )
        ON CONFLICT (thread_id)
        DO UPDATE SET
          cwd = CASE
            WHEN worktree_cleanup_jobs.status = 'removing'
              THEN worktree_cleanup_jobs.cwd
            ELSE excluded.cwd
          END,
          worktree_path = CASE
            WHEN worktree_cleanup_jobs.status = 'removing'
              THEN worktree_cleanup_jobs.worktree_path
            ELSE excluded.worktree_path
          END,
          canonical_worktree_path = CASE
            WHEN worktree_cleanup_jobs.status = 'removing'
              THEN worktree_cleanup_jobs.canonical_worktree_path
            ELSE excluded.canonical_worktree_path
          END,
          requested_at = CASE
            WHEN worktree_cleanup_jobs.status = 'removing'
              THEN worktree_cleanup_jobs.requested_at
            ELSE excluded.requested_at
          END,
          source = CASE
            WHEN worktree_cleanup_jobs.status = 'removing'
              THEN worktree_cleanup_jobs.source
            ELSE excluded.source
          END,
          status = CASE
            WHEN ${allowTerminalReset}
              AND worktree_cleanup_jobs.status IN ('cancelled', 'completed', 'needs-attention')
              THEN 'waiting'
            ELSE worktree_cleanup_jobs.status
          END,
          attempt_count = CASE
            WHEN ${allowTerminalReset}
              AND worktree_cleanup_jobs.status IN ('cancelled', 'completed', 'needs-attention')
              THEN 0
            ELSE worktree_cleanup_jobs.attempt_count
          END,
          next_attempt_at = CASE
            WHEN ${allowTerminalReset}
              AND worktree_cleanup_jobs.status IN ('cancelled', 'completed', 'needs-attention')
              THEN excluded.next_attempt_at
            ELSE worktree_cleanup_jobs.next_attempt_at
          END,
          last_reason = CASE
            WHEN ${allowTerminalReset}
              AND worktree_cleanup_jobs.status IN ('cancelled', 'completed', 'needs-attention')
              THEN NULL
            ELSE worktree_cleanup_jobs.last_reason
          END,
          last_error = CASE
            WHEN ${allowTerminalReset}
              AND worktree_cleanup_jobs.status IN ('cancelled', 'completed', 'needs-attention')
              THEN NULL
            ELSE worktree_cleanup_jobs.last_error
          END
        WHERE worktree_cleanup_jobs.status NOT IN ('cancelled', 'completed')
          OR ${allowTerminalReset}
      `;
    },
  });

  const listJobs = SqlSchema.findAll({
    Request: Schema.Void,
    Result: WorktreeCleanupJob,
    execute: () =>
      sql`
        SELECT
          thread_id AS "threadId",
          cwd,
          worktree_path AS "worktreePath",
          canonical_worktree_path AS "canonicalWorktreePath",
          requested_at AS "requestedAt",
          source,
          status,
          attempt_count AS "attemptCount",
          next_attempt_at AS "nextAttemptAt",
          last_reason AS "lastReason",
          last_error AS "lastError"
        FROM worktree_cleanup_jobs
        ORDER BY requested_at ASC, thread_id ASC
      `,
  });

  const listDueJobs = SqlSchema.findAll({
    Request: DueJobsRequest,
    Result: WorktreeCleanupJob,
    execute: ({ now }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          cwd,
          worktree_path AS "worktreePath",
          canonical_worktree_path AS "canonicalWorktreePath",
          requested_at AS "requestedAt",
          source,
          status,
          attempt_count AS "attemptCount",
          next_attempt_at AS "nextAttemptAt",
          last_reason AS "lastReason",
          last_error AS "lastError"
        FROM worktree_cleanup_jobs
        WHERE status = 'waiting'
          AND (next_attempt_at IS NULL OR next_attempt_at <= ${now})
        ORDER BY next_attempt_at ASC, requested_at ASC, thread_id ASC
      `,
  });

  const pathHasReservation = SqlSchema.findOne({
    Request: ReservationByPathRequest,
    Result: Schema.Struct({ found: Schema.Number }),
    execute: ({ canonicalWorktreePath }) =>
      sql`
        SELECT EXISTS(
          SELECT 1
          FROM worktree_cleanup_reservations
          WHERE canonical_worktree_path = ${canonicalWorktreePath}
        ) AS found
      `,
  });

  const tryReserveForRemoval = (input: {
    readonly threadId: WorktreeCleanupJob["threadId"];
    readonly canonicalWorktreePath: string;
    readonly reservedAt: WorktreeCleanupJob["requestedAt"];
  }) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const eligibleJob = yield* getJobRow({ threadId: input.threadId });
        if (
          Option.isNone(eligibleJob) ||
          eligibleJob.value.status !== "waiting" ||
          eligibleJob.value.canonicalWorktreePath !== input.canonicalWorktreePath ||
          (eligibleJob.value.nextAttemptAt !== null &&
            eligibleJob.value.nextAttemptAt > input.reservedAt)
        ) {
          return Option.none<{
            readonly cleanup: WorktreeCleanupJob;
            readonly reservation: WorktreeCleanupReservation;
          }>();
        }

        yield* sql`
          INSERT INTO worktree_cleanup_reservations (
            canonical_worktree_path,
            thread_id,
            reserved_at
          )
          VALUES (
            ${input.canonicalWorktreePath},
            ${input.threadId},
            ${input.reservedAt}
          )
          ON CONFLICT DO NOTHING
        `;

        const reservation = yield* getReservationByPath({
          canonicalWorktreePath: input.canonicalWorktreePath,
        });
        if (Option.isNone(reservation) || reservation.value.threadId !== input.threadId) {
          return Option.none<{
            readonly cleanup: WorktreeCleanupJob;
            readonly reservation: WorktreeCleanupReservation;
          }>();
        }

        yield* sql`
          UPDATE worktree_cleanup_jobs
          SET status = 'removing'
          WHERE thread_id = ${input.threadId}
            AND status = 'waiting'
        `;
        yield* recordAuditTransition({
          threadId: input.threadId,
          eventType: "cleanup.started",
          suffix: `${eligibleJob.value.attemptCount}:${input.reservedAt}`,
          occurredAt: input.reservedAt,
          payload: {
            jobId: input.threadId,
            status: "removing",
            attemptCount: eligibleJob.value.attemptCount,
          },
        });

        return Option.some({
          cleanup: { ...eligibleJob.value, status: "removing" as const },
          reservation: reservation.value,
        });
      }),
    );

  const markJobNeedsAttention = (input: {
    readonly threadId: WorktreeCleanupJob["threadId"];
    readonly reason: string;
    readonly error?: string | undefined;
  }) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const current = yield* getJobRow({ threadId: input.threadId });
        if (
          Option.isNone(current) ||
          current.value.status === "cancelled" ||
          current.value.status === "completed"
        ) {
          return Option.none<WorktreeCleanupJob>();
        }

        yield* sql`
          DELETE FROM worktree_cleanup_reservations
          WHERE thread_id = ${input.threadId}
        `;
        yield* sql`
          UPDATE worktree_cleanup_jobs
          SET
            status = 'needs-attention',
            next_attempt_at = NULL,
            last_reason = ${input.reason},
            last_error = ${input.error ?? null}
          WHERE thread_id = ${input.threadId}
        `;
        const updated = yield* getJobRow({ threadId: input.threadId });
        if (Option.isSome(updated) && current.value.status !== updated.value.status) {
          const occurredAt = new Date(yield* Clock.currentTimeMillis).toISOString();
          yield* recordAuditTransition({
            threadId: input.threadId,
            eventType: "cleanup.failed",
            suffix: `${updated.value.status}:${updated.value.attemptCount}:${occurredAt}`,
            occurredAt,
            payload: {
              jobId: input.threadId,
              status: updated.value.status,
              attemptCount: updated.value.attemptCount,
              reason: updated.value.lastReason,
              error: updated.value.lastError,
              reconciliationRequired: true,
            },
          });
        }
        return updated;
      }),
    );

  const markJobCompleted = (threadId: WorktreeCleanupJob["threadId"]) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const current = yield* getJobRow({ threadId });
        if (Option.isNone(current) || current.value.status !== "removing") {
          return Option.none<WorktreeCleanupJob>();
        }

        yield* sql`
          DELETE FROM worktree_cleanup_reservations
          WHERE thread_id = ${threadId}
        `;
        yield* sql`
          UPDATE worktree_cleanup_jobs
          SET
            status = 'completed',
            next_attempt_at = NULL
          WHERE thread_id = ${threadId}
        `;
        const updated = yield* getJobRow({ threadId });
        if (Option.isSome(updated)) {
          const occurredAt = new Date(yield* Clock.currentTimeMillis).toISOString();
          yield* recordAuditTransition({
            threadId,
            eventType: "cleanup.completed",
            suffix: `${updated.value.attemptCount}:${occurredAt}`,
            occurredAt,
            payload: {
              jobId: threadId,
              status: updated.value.status,
              attemptCount: updated.value.attemptCount,
              reason: updated.value.lastReason,
            },
          });
        }
        return updated;
      }),
    );

  const markJobCompletedWithoutRemoval = (threadId: WorktreeCleanupJob["threadId"]) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const current = yield* getJobRow({ threadId });
        if (Option.isNone(current) || current.value.status !== "waiting") {
          return Option.none<WorktreeCleanupJob>();
        }

        yield* sql`
          DELETE FROM worktree_cleanup_reservations
          WHERE thread_id = ${threadId}
        `;
        yield* sql`
          UPDATE worktree_cleanup_jobs
          SET
            status = 'completed',
            next_attempt_at = NULL,
            last_reason = 'worktree-already-absent'
          WHERE thread_id = ${threadId}
            AND status = 'waiting'
        `;
        const updated = yield* getJobRow({ threadId });
        if (Option.isSome(updated)) {
          const occurredAt = new Date(yield* Clock.currentTimeMillis).toISOString();
          yield* recordAuditTransition({
            threadId,
            eventType: "cleanup.completed",
            suffix: `${updated.value.attemptCount}:already-absent:${occurredAt}`,
            occurredAt,
            payload: {
              jobId: threadId,
              status: updated.value.status,
              attemptCount: updated.value.attemptCount,
              reason: updated.value.lastReason,
            },
          });
        }
        return updated;
      }),
    );

  const deferJob = (input: {
    readonly threadId: WorktreeCleanupJob["threadId"];
    readonly nextAttemptAt: WorktreeCleanupJob["nextAttemptAt"];
    readonly reason: string;
    readonly error?: string | undefined;
  }) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const current = yield* getJobRow({ threadId: input.threadId });
        if (
          Option.isNone(current) ||
          current.value.status === "cancelled" ||
          current.value.status === "completed" ||
          current.value.status === "needs-attention"
        ) {
          return Option.none<WorktreeCleanupJob>();
        }

        yield* sql`
          UPDATE worktree_cleanup_jobs
          SET
            status = 'waiting',
            next_attempt_at = ${input.nextAttemptAt},
            last_reason = ${input.reason},
            last_error = ${input.error ?? null}
          WHERE thread_id = ${input.threadId}
            AND status IN ('waiting', 'removing')
        `;
        yield* sql`
          DELETE FROM worktree_cleanup_reservations
          WHERE thread_id = ${input.threadId}
        `;
        const updated = yield* getJobRow({ threadId: input.threadId });
        if (Option.isSome(updated)) {
          const occurredAt = new Date(yield* Clock.currentTimeMillis).toISOString();
          yield* recordAuditTransition({
            threadId: input.threadId,
            eventType: "cleanup.queued",
            suffix: `deferred:${updated.value.attemptCount}:${occurredAt}`,
            occurredAt,
            payload: {
              jobId: input.threadId,
              status: updated.value.status,
              attemptCount: updated.value.attemptCount,
              nextAttemptAt: updated.value.nextAttemptAt,
              reason: updated.value.lastReason,
              error: updated.value.lastError,
              reconciliationRequired: true,
            },
          });
        }
        return updated;
      }),
    );

  const retryJob = (input: {
    readonly threadId: WorktreeCleanupJob["threadId"];
    readonly nextAttemptAt: WorktreeCleanupJob["nextAttemptAt"];
  }) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const current = yield* getJobRow({ threadId: input.threadId });
        if (
          Option.isNone(current) ||
          current.value.status !== "needs-attention" ||
          current.value.source === "legacy"
        ) {
          return Option.none<WorktreeCleanupJob>();
        }
        yield* sql`
          UPDATE worktree_cleanup_jobs
          SET
            status = 'waiting',
            next_attempt_at = ${input.nextAttemptAt},
            last_reason = 'manual-retry',
            last_error = NULL
          WHERE thread_id = ${input.threadId}
            AND status = 'needs-attention'
        `;
        const updated = yield* getJobRow({ threadId: input.threadId });
        if (Option.isSome(updated)) {
          const occurredAt = new Date(yield* Clock.currentTimeMillis).toISOString();
          yield* recordAuditTransition({
            threadId: input.threadId,
            eventType: "cleanup.queued",
            suffix: `retry:${updated.value.attemptCount}:${occurredAt}`,
            occurredAt,
            payload: {
              jobId: input.threadId,
              status: updated.value.status,
              attemptCount: updated.value.attemptCount,
              nextAttemptAt: updated.value.nextAttemptAt,
              reason: updated.value.lastReason,
              reconciliationRequired: false,
            },
          });
        }
        return updated;
      }),
    );

  const recoverRemovingJob = (input: {
    readonly threadId: WorktreeCleanupJob["threadId"];
    readonly nextAttemptAt: WorktreeCleanupJob["nextAttemptAt"];
    readonly reason: string;
  }) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const current = yield* getJobRow({ threadId: input.threadId });
        if (Option.isNone(current) || current.value.status !== "removing") {
          return Option.none<WorktreeCleanupJob>();
        }

        yield* sql`
          DELETE FROM worktree_cleanup_reservations
          WHERE thread_id = ${input.threadId}
        `;
        yield* sql`
          UPDATE worktree_cleanup_jobs
          SET
            status = 'waiting',
            next_attempt_at = ${input.nextAttemptAt},
            last_reason = ${input.reason},
            last_error = NULL
          WHERE thread_id = ${input.threadId}
            AND status = 'removing'
        `;
        const updated = yield* getJobRow({ threadId: input.threadId });
        if (Option.isSome(updated)) {
          const occurredAt = new Date(yield* Clock.currentTimeMillis).toISOString();
          yield* recordAuditTransition({
            threadId: input.threadId,
            eventType: "cleanup.queued",
            suffix: `recovered:${updated.value.attemptCount}:${occurredAt}`,
            occurredAt,
            payload: {
              jobId: input.threadId,
              status: updated.value.status,
              attemptCount: updated.value.attemptCount,
              nextAttemptAt: updated.value.nextAttemptAt,
              reason: input.reason,
              reconciliationRequired: true,
              priorStatus: "removing",
            },
          });
        }
        return updated;
      }),
    );

  const cancelJob = (threadId: WorktreeCleanupJob["threadId"]) =>
    sql.withTransaction(
      Effect.gen(function* () {
        const current = yield* getJobRow({ threadId });
        yield* sql`
          DELETE FROM worktree_cleanup_reservations
          WHERE thread_id = ${threadId}
            AND EXISTS (
              SELECT 1
              FROM worktree_cleanup_jobs
              WHERE thread_id = ${threadId}
                AND status IN ('waiting', 'needs-attention')
            )
        `;
        yield* sql`
          UPDATE worktree_cleanup_jobs
          SET
            status = 'cancelled',
            next_attempt_at = NULL,
            last_reason = COALESCE(last_reason, 'explicitly-cancelled')
          WHERE thread_id = ${threadId}
            AND status IN ('waiting', 'needs-attention')
        `;
        if (
          Option.isSome(current) &&
          (current.value.status === "waiting" || current.value.status === "needs-attention")
        ) {
          const occurredAt = new Date(yield* Clock.currentTimeMillis).toISOString();
          yield* recordAuditTransition({
            threadId,
            eventType: "cleanup.cancelled",
            suffix: `${current.value.attemptCount}:${occurredAt}`,
            occurredAt,
            payload: {
              jobId: threadId,
              status: "cancelled",
              attemptCount: current.value.attemptCount,
              reason: current.value.lastReason ?? "explicitly-cancelled",
              reconciliationRequired: false,
            },
          });
        }
      }),
    );

  const recordJobFailure = (input: {
    readonly threadId: WorktreeCleanupJob["threadId"];
    readonly error: string;
    readonly reason?: string | undefined;
    readonly nextAttemptAt?: WorktreeCleanupJob["nextAttemptAt"] | undefined;
    readonly now?: WorktreeCleanupJob["requestedAt"] | undefined;
    readonly maxAttempts: number;
  }) =>
    Effect.gen(function* () {
      const now = input.now ?? new Date(yield* Clock.currentTimeMillis).toISOString();
      return yield* sql.withTransaction(
        Effect.gen(function* () {
          const current = yield* getJobRow({ threadId: input.threadId });
          if (
            Option.isNone(current) ||
            current.value.status === "cancelled" ||
            current.value.status === "completed" ||
            current.value.status === "needs-attention"
          ) {
            return Option.none<typeof WorktreeCleanupFailureResult.Type>();
          }

          const attemptCount = current.value.attemptCount + 1;
          const exhausted = attemptCount >= input.maxAttempts;
          yield* sql`
            DELETE FROM worktree_cleanup_reservations
            WHERE thread_id = ${input.threadId}
          `;
          yield* sql`
            UPDATE worktree_cleanup_jobs
            SET
              attempt_count = ${attemptCount},
              status = ${exhausted ? "needs-attention" : "waiting"},
              next_attempt_at = ${exhausted ? null : (input.nextAttemptAt ?? now)},
              last_reason = ${input.reason ?? "removal-failed"},
              last_error = ${input.error}
            WHERE thread_id = ${input.threadId}
          `;

          const updated = yield* getJobRow({ threadId: input.threadId });
          if (Option.isSome(updated)) {
            const job = updated.value;
            yield* recordAuditTransition({
              threadId: input.threadId,
              eventType: "cleanup.failed",
              suffix: `${job.status}:${job.attemptCount}:${now}`,
              occurredAt: now,
              payload: {
                jobId: input.threadId,
                status: job.status,
                attemptCount: job.attemptCount,
                nextAttemptAt: job.nextAttemptAt,
                reason: job.lastReason,
                error: job.lastError,
                reconciliationRequired: job.status === "needs-attention",
              },
            });
          }
          return Option.map(updated, (job) => ({
            attemptCount: job.attemptCount,
            status: job.status,
            nextAttemptAt: job.nextAttemptAt,
            lastReason: job.lastReason,
            lastError: job.lastError,
          }));
        }),
      );
    });

  return {
    enqueue: (intent) =>
      sql
        .withTransaction(
          Effect.gen(function* () {
            const previous = yield* getJobRow({ threadId: intent.threadId });
            yield* enqueueJob(intent);
            const job = yield* getJobRow({ threadId: intent.threadId });
            if (Option.isNone(job)) {
              return yield* Effect.die(
                new Error(
                  `Worktree cleanup intent disappeared while enqueueing ${intent.threadId}`,
                ),
              );
            }
            const previousIsTerminal =
              Option.isSome(previous) &&
              ["cancelled", "completed", "needs-attention"].includes(previous.value.status);
            const isNewIntent =
              Option.isNone(previous) ||
              (intent.allowTerminalReset && previousIsTerminal) ||
              (intent.allowTerminalReset &&
                Option.isSome(previous) &&
                previous.value.status === "waiting" &&
                previous.value.requestedAt !== intent.requestedAt);
            if (job.value.status === "waiting" && isNewIntent) {
              yield* recordAuditTransition({
                threadId: intent.threadId,
                eventType: "cleanup.requested",
                suffix: `requested:${intent.requestedAt}`,
                occurredAt: intent.requestedAt,
                payload: {
                  jobId: intent.threadId,
                  status: "pending-enqueue",
                  worktreePath: job.value.worktreePath,
                  canonicalWorktreePath: job.value.canonicalWorktreePath,
                  requestedAt: job.value.requestedAt,
                },
              });
              yield* recordAuditTransition({
                threadId: intent.threadId,
                eventType: "cleanup.queued",
                suffix: `queued:${job.value.attemptCount}:${job.value.requestedAt}`,
                occurredAt: intent.requestedAt,
                payload: {
                  jobId: intent.threadId,
                  status: job.value.status,
                  attemptCount: job.value.attemptCount,
                  nextAttemptAt: job.value.nextAttemptAt,
                  worktreePath: job.value.worktreePath,
                  canonicalWorktreePath: job.value.canonicalWorktreePath,
                  reason: job.value.lastReason,
                  reconciliationRequired: false,
                },
              });
            }
            return job.value;
          }),
        )
        .pipe(Effect.mapError(toPersistenceSqlError("WorktreeCleanupJobRepository.enqueue:query"))),
    list: () =>
      listJobs(undefined).pipe(
        Effect.mapError(toPersistenceSqlError("WorktreeCleanupJobRepository.list:query")),
      ),
    listDue: (input) =>
      listDueJobs(input).pipe(
        Effect.mapError(toPersistenceSqlError("WorktreeCleanupJobRepository.listDue:query")),
      ),
    getByThreadId: (threadId) =>
      getJobRow({ threadId }).pipe(
        Effect.mapError(toPersistenceSqlError("WorktreeCleanupJobRepository.getByThreadId:query")),
      ),
    hasReservationByPath: (canonicalWorktreePath) =>
      pathHasReservation({ canonicalWorktreePath }).pipe(
        Effect.map((row) => row.found === 1),
        Effect.mapError(
          toPersistenceSqlError("WorktreeCleanupJobRepository.hasReservationByPath:query"),
        ),
      ),
    tryReserveForRemoval: (input) =>
      tryReserveForRemoval(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("WorktreeCleanupJobRepository.tryReserveForRemoval:query"),
        ),
      ),
    markNeedsAttention: (input) =>
      markJobNeedsAttention(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("WorktreeCleanupJobRepository.markNeedsAttention:query"),
        ),
      ),
    defer: (input) =>
      deferJob(input).pipe(
        Effect.mapError(toPersistenceSqlError("WorktreeCleanupJobRepository.defer:query")),
      ),
    retry: (input) =>
      retryJob(input).pipe(
        Effect.mapError(toPersistenceSqlError("WorktreeCleanupJobRepository.retry:query")),
      ),
    recoverRemoving: (input) =>
      recoverRemovingJob(input).pipe(
        Effect.mapError(
          toPersistenceSqlError("WorktreeCleanupJobRepository.recoverRemoving:query"),
        ),
      ),
    markCompleted: (input) =>
      markJobCompleted(input.threadId).pipe(
        Effect.mapError(toPersistenceSqlError("WorktreeCleanupJobRepository.markCompleted:query")),
      ),
    markCompletedWithoutRemoval: (input) =>
      markJobCompletedWithoutRemoval(input.threadId).pipe(
        Effect.mapError(
          toPersistenceSqlError("WorktreeCleanupJobRepository.markCompletedWithoutRemoval:query"),
        ),
      ),
    cancelByThreadId: (threadId) =>
      cancelJob(threadId).pipe(
        Effect.mapError(
          toPersistenceSqlError("WorktreeCleanupJobRepository.cancelByThreadId:query"),
        ),
      ),
    recordFailure: (input) =>
      recordJobFailure(input).pipe(
        Effect.mapError(toPersistenceSqlError("WorktreeCleanupJobRepository.recordFailure:query")),
      ),
  } satisfies WorktreeCleanupJobRepositoryShape;
});

export const WorktreeCleanupJobRepositoryLive = Layer.effect(WorktreeCleanupJobRepository, make);
