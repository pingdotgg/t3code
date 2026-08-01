import { Effect, Layer, Schema } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  WorktreeCleanupFailureResult,
  WorktreeCleanupJob,
  WorktreeCleanupJobRepository,
  type WorktreeCleanupJobRepositoryShape,
} from "../Services/WorktreeCleanupJobs.ts";

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertJob = SqlSchema.void({
    Request: WorktreeCleanupJob,
    execute: (job) =>
      sql`
        INSERT INTO worktree_cleanup_jobs (
          thread_id,
          cwd,
          worktree_path,
          requested_at,
          status
        )
        VALUES (
          ${job.threadId},
          ${job.cwd},
          ${job.worktreePath},
          ${job.requestedAt},
          'pending'
        )
        ON CONFLICT (thread_id)
        DO UPDATE SET
          cwd = excluded.cwd,
          worktree_path = excluded.worktree_path,
          requested_at = excluded.requested_at,
          status = 'pending',
          attempt_count = 0,
          last_error = NULL
      `,
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
          requested_at AS "requestedAt"
        FROM worktree_cleanup_jobs
        WHERE status = 'pending'
        ORDER BY requested_at ASC, thread_id ASC
      `,
  });

  const getPendingJob = SqlSchema.findOneOption({
    Request: Schema.Struct({ threadId: WorktreeCleanupJob.fields.threadId }),
    Result: WorktreeCleanupJob,
    execute: ({ threadId }) =>
      sql`
        SELECT
          thread_id AS "threadId",
          cwd,
          worktree_path AS "worktreePath",
          requested_at AS "requestedAt"
        FROM worktree_cleanup_jobs
        WHERE thread_id = ${threadId}
          AND status = 'pending'
      `,
  });

  const cancelJob = SqlSchema.void({
    Request: Schema.Struct({ threadId: WorktreeCleanupJob.fields.threadId }),
    execute: ({ threadId }) =>
      sql`
        UPDATE worktree_cleanup_jobs
        SET status = 'cancelled'
        WHERE thread_id = ${threadId}
      `,
  });

  const deleteJob = SqlSchema.void({
    Request: Schema.Struct({ threadId: WorktreeCleanupJob.fields.threadId }),
    execute: ({ threadId }) =>
      sql`
        DELETE FROM worktree_cleanup_jobs
        WHERE thread_id = ${threadId}
      `,
  });

  const recordJobFailure = SqlSchema.findOneOption({
    Request: Schema.Struct({
      threadId: WorktreeCleanupJob.fields.threadId,
      error: Schema.String,
      maxAttempts: Schema.Int,
    }),
    Result: WorktreeCleanupFailureResult,
    execute: ({ threadId, error, maxAttempts }) =>
      sql`
        UPDATE worktree_cleanup_jobs
        SET
          attempt_count = attempt_count + 1,
          last_error = ${error},
          status = CASE
            WHEN attempt_count + 1 >= ${maxAttempts} THEN 'cancelled'
            ELSE 'pending'
          END
        WHERE thread_id = ${threadId}
          AND status = 'pending'
        RETURNING
          attempt_count AS "attemptCount",
          status
      `,
  });

  const worktreePathExists = SqlSchema.findOne({
    Request: Schema.Struct({ worktreePath: Schema.String }),
    Result: Schema.Struct({ found: Schema.Number }),
    execute: ({ worktreePath }) =>
      sql`
        SELECT EXISTS(
          SELECT 1
          FROM worktree_cleanup_jobs
          WHERE worktree_path = ${worktreePath}
            AND status = 'pending'
        ) AS found
      `,
  });

  return {
    upsert: (job) =>
      upsertJob(job).pipe(
        Effect.mapError(toPersistenceSqlError("WorktreeCleanupJobRepository.upsert:query")),
      ),
    list: () =>
      listJobs(undefined).pipe(
        Effect.mapError(toPersistenceSqlError("WorktreeCleanupJobRepository.list:query")),
      ),
    getPendingByThreadId: (threadId) =>
      getPendingJob({ threadId }).pipe(
        Effect.mapError(
          toPersistenceSqlError("WorktreeCleanupJobRepository.getPendingByThreadId:query"),
        ),
      ),
    existsByPath: (worktreePath) =>
      worktreePathExists({ worktreePath }).pipe(
        Effect.map((row) => row.found === 1),
        Effect.mapError(toPersistenceSqlError("WorktreeCleanupJobRepository.existsByPath:query")),
      ),
    cancelByThreadId: (threadId) =>
      cancelJob({ threadId }).pipe(
        Effect.mapError(
          toPersistenceSqlError("WorktreeCleanupJobRepository.cancelByThreadId:query"),
        ),
      ),
    recordFailure: (input) =>
      recordJobFailure(input).pipe(
        Effect.mapError(toPersistenceSqlError("WorktreeCleanupJobRepository.recordFailure:query")),
      ),
    deleteByThreadId: (threadId) =>
      deleteJob({ threadId }).pipe(
        Effect.mapError(
          toPersistenceSqlError("WorktreeCleanupJobRepository.deleteByThreadId:query"),
        ),
      ),
  } satisfies WorktreeCleanupJobRepositoryShape;
});

export const WorktreeCleanupJobRepositoryLive = Layer.effect(WorktreeCleanupJobRepository, make);
