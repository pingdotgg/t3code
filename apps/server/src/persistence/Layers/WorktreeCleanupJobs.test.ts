import { ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { WorktreeCleanupJobRepositoryLive } from "./WorktreeCleanupJobs.ts";
import { WorktreeCleanupJobRepository } from "../Services/WorktreeCleanupJobs.ts";

const testLayer = it.layer(
  Layer.mergeAll(
    WorktreeCleanupJobRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    SqlitePersistenceMemory,
  ),
);

const at = (seconds: number) =>
  `1970-01-01T00:${String(Math.floor(seconds / 60)).padStart(2, "0")}:${String(
    seconds % 60,
  ).padStart(2, "0")}.000Z`;

const intent = (input: {
  readonly id: string;
  readonly path: string;
  readonly source?: "archive" | "delete";
  readonly requestedAt?: string;
  readonly allowTerminalReset?: boolean;
}) => ({
  threadId: ThreadId.make(input.id),
  cwd: "/tmp/project",
  worktreePath: input.path,
  canonicalWorktreePath: input.path,
  requestedAt: input.requestedAt ?? at(0),
  source: input.source ?? "archive",
  allowTerminalReset: input.allowTerminalReset ?? false,
});

testLayer("WorktreeCleanupJobRepository", (it) => {
  it.effect("keeps intents separate from canonical-path removal reservations", () =>
    Effect.gen(function* () {
      const jobs = yield* WorktreeCleanupJobRepository;
      const first = yield* jobs.enqueue(intent({ id: "cleanup-first", path: "/tmp/shared" }));
      const second = yield* jobs.enqueue(
        intent({ id: "cleanup-second", path: "/tmp/shared", source: "delete" }),
      );

      assert.equal(first.status, "waiting");
      assert.equal(second.status, "waiting");
      assert.isFalse(yield* jobs.hasReservationByPath("/tmp/shared"));
      assert.deepEqual(
        (yield* jobs.listDue({ now: at(0) })).map((job) => job.threadId),
        [first.threadId, second.threadId],
      );

      const reservation = yield* jobs.tryReserveForRemoval({
        threadId: first.threadId,
        canonicalWorktreePath: "/tmp/shared",
        reservedAt: at(0),
      });
      assert.isTrue(Option.isSome(reservation));
      assert.isTrue(yield* jobs.hasReservationByPath("/tmp/shared"));
      assert.equal(
        (yield* jobs.getByThreadId(first.threadId)).pipe(Option.getOrThrow).status,
        "removing",
      );
      assert.isTrue(
        Option.isNone(
          yield* jobs.tryReserveForRemoval({
            threadId: second.threadId,
            canonicalWorktreePath: "/tmp/shared",
            reservedAt: at(0),
          }),
        ),
      );

      const needsAttention = yield* jobs.markNeedsAttention({
        threadId: first.threadId,
        reason: "dirty-worktree",
      });
      assert.equal(needsAttention.pipe(Option.getOrThrow).status, "needs-attention");
      assert.isFalse(yield* jobs.hasReservationByPath("/tmp/shared"));

      const secondReservation = yield* jobs.tryReserveForRemoval({
        threadId: second.threadId,
        canonicalWorktreePath: "/tmp/shared",
        reservedAt: at(0),
      });
      assert.isTrue(Option.isSome(secondReservation));
      const completed = yield* jobs.markCompleted({ threadId: second.threadId });
      assert.equal(completed.pipe(Option.getOrThrow).status, "completed");
      assert.isFalse(yield* jobs.hasReservationByPath("/tmp/shared"));
    }),
  );

  it.effect(
    "persists backoff and escalates repeated failures without retaining a reservation",
    () =>
      Effect.gen(function* () {
        const jobs = yield* WorktreeCleanupJobRepository;
        const cleanup = yield* jobs.enqueue(
          intent({ id: "cleanup-retry", path: "/tmp/retry", requestedAt: at(0) }),
        );

        yield* jobs.tryReserveForRemoval({
          threadId: cleanup.threadId,
          canonicalWorktreePath: "/tmp/retry",
          reservedAt: at(0),
        });
        const firstFailure = yield* jobs.recordFailure({
          threadId: cleanup.threadId,
          error: "git unavailable",
          reason: "git-command-failed",
          now: at(1),
          nextAttemptAt: at(10),
          maxAttempts: 2,
        });
        assert.deepEqual(
          firstFailure,
          Option.some({
            attemptCount: 1,
            status: "waiting",
            nextAttemptAt: at(10),
            lastReason: "git-command-failed",
            lastError: "git unavailable",
          }),
        );
        assert.isFalse(yield* jobs.hasReservationByPath("/tmp/retry"));
        assert.deepEqual(yield* jobs.listDue({ now: at(9) }), []);
        assert.equal((yield* jobs.listDue({ now: at(10) })).length, 1);

        yield* jobs.tryReserveForRemoval({
          threadId: cleanup.threadId,
          canonicalWorktreePath: "/tmp/retry",
          reservedAt: at(10),
        });
        const secondFailure = yield* jobs.recordFailure({
          threadId: cleanup.threadId,
          error: "git still unavailable",
          reason: "git-command-failed",
          now: at(11),
          nextAttemptAt: at(20),
          maxAttempts: 2,
        });
        assert.equal(secondFailure.pipe(Option.getOrThrow).status, "needs-attention");
        assert.isFalse(yield* jobs.hasReservationByPath("/tmp/retry"));
        assert.isFalse(
          (yield* jobs.listDue({ now: at(100) })).some((job) => job.threadId === cleanup.threadId),
        );
      }),
  );

  it.effect(
    "persists linked cleanup transitions and redacts errors before writing audit evidence",
    () =>
      Effect.gen(function* () {
        const jobs = yield* WorktreeCleanupJobRepository;
        const sql = yield* SqlClient.SqlClient;
        const sourceThreadId = ThreadId.make("audit-source");
        const childThreadId = ThreadId.make("audit-child");
        const context = {
          authorization: {
            sourceThreadId,
            sourceTurnId: null,
            initiatingMessageId: null,
            scope: "orchestration:operate",
          },
          toolName: "create_nested_threads",
          toolVersion: "1.0.0",
          toolCallId: "test-call",
          providerInstanceId: null,
          model: null,
          workspaceRoot: "/tmp/project",
          gitRevision: null,
          buildRevision: "test-build",
        };
        yield* sql`
            INSERT INTO delegation_audit_events (
              event_id, operation_id, attempt_id, source_thread_id, source_turn_id,
              source_message_id, child_thread_id, event_type, occurred_at, evidence_status,
              redacted, context_json, payload_json
            )
            VALUES (
              'audit-linked-child', 'audit-operation', 'audit-attempt', ${sourceThreadId},
              NULL, NULL, ${childThreadId}, 'thread.created', ${at(0)}, 'complete', 0,
              ${JSON.stringify(context)}, '{}'
            )
          `;

        const cleanup = yield* jobs.enqueue(
          intent({
            id: childThreadId,
            path: "/tmp/audit-child",
            source: "delete",
            requestedAt: at(0),
          }),
        );
        yield* jobs.tryReserveForRemoval({
          threadId: cleanup.threadId,
          canonicalWorktreePath: cleanup.canonicalWorktreePath,
          reservedAt: at(0),
        });
        yield* jobs.recordFailure({
          threadId: cleanup.threadId,
          error: "Bearer test-secret-with-more-than-20-chars",
          reason: "git-command-failed",
          now: at(1),
          nextAttemptAt: at(10),
          maxAttempts: 1,
        });
        yield* jobs.retry({ threadId: cleanup.threadId, nextAttemptAt: at(20) });
        yield* jobs.tryReserveForRemoval({
          threadId: cleanup.threadId,
          canonicalWorktreePath: cleanup.canonicalWorktreePath,
          reservedAt: at(20),
        });
        yield* jobs.markCompleted({ threadId: cleanup.threadId });

        const auditRows = yield* sql<{
          readonly event_type: string;
          readonly payload_json: string;
        }>`
            SELECT event_type, payload_json
            FROM delegation_audit_events
            WHERE operation_id = 'audit-operation'
            ORDER BY sequence ASC
          `;
        const cleanupRows = auditRows.filter((row) => row.event_type.startsWith("cleanup."));
        assert.deepEqual(
          cleanupRows.map((row) => row.event_type),
          [
            "cleanup.requested",
            "cleanup.queued",
            "cleanup.started",
            "cleanup.failed",
            "cleanup.queued",
            "cleanup.started",
            "cleanup.completed",
          ],
        );
        assert.include(cleanupRows[3]?.payload_json ?? "", "[REDACTED]");
        assert.notInclude(cleanupRows[3]?.payload_json ?? "", "test-secret");
        assert.include(cleanupRows[3]?.payload_json ?? "", '"status":"needs-attention"');
        assert.include(cleanupRows[6]?.payload_json ?? "", '"status":"completed"');
      }),
  );

  it.effect("preserves explicit cancellation and does not reactivate cancelled rows", () =>
    Effect.gen(function* () {
      const jobs = yield* WorktreeCleanupJobRepository;
      const cleanup = yield* jobs.enqueue(
        intent({ id: "cleanup-cancelled", path: "/tmp/cancelled" }),
      );
      yield* jobs.cancelByThreadId(cleanup.threadId);

      const cancelled = yield* jobs.getByThreadId(cleanup.threadId);
      assert.equal(cancelled.pipe(Option.getOrThrow).status, "cancelled");
      assert.isFalse(yield* jobs.hasReservationByPath("/tmp/cancelled"));

      const reenqueue = yield* jobs.enqueue(
        intent({ id: "cleanup-cancelled", path: "/tmp/cancelled", source: "delete" }),
      );
      assert.equal(reenqueue.status, "cancelled");
      assert.equal(
        (yield* jobs.getByThreadId(cleanup.threadId)).pipe(Option.getOrThrow).status,
        "cancelled",
      );
    }),
  );

  it.effect("does not cancel an in-progress removal or release its reservation", () =>
    Effect.gen(function* () {
      const jobs = yield* WorktreeCleanupJobRepository;
      const cleanup = yield* jobs.enqueue(
        intent({ id: "cleanup-removing", path: "/tmp/removing" }),
      );
      yield* jobs.tryReserveForRemoval({
        threadId: cleanup.threadId,
        canonicalWorktreePath: "/tmp/removing",
        reservedAt: at(0),
      });
      const lifecycleRefresh = yield* jobs.enqueue(
        intent({
          id: "cleanup-removing",
          path: "/tmp/reassigned",
          allowTerminalReset: true,
          source: "delete",
          requestedAt: at(10),
        }),
      );
      assert.equal(lifecycleRefresh.status, "removing");
      assert.equal(lifecycleRefresh.worktreePath, "/tmp/removing");
      assert.equal(lifecycleRefresh.canonicalWorktreePath, "/tmp/removing");
      assert.equal(lifecycleRefresh.requestedAt, at(0));
      assert.equal(lifecycleRefresh.source, "archive");

      yield* jobs.cancelByThreadId(cleanup.threadId);

      assert.equal(
        (yield* jobs.getByThreadId(cleanup.threadId)).pipe(Option.getOrThrow).status,
        "removing",
      );
      assert.isTrue(yield* jobs.hasReservationByPath("/tmp/removing"));
    }),
  );

  it.effect("revives needs-attention only for explicit cleanup consent", () =>
    Effect.gen(function* () {
      const jobs = yield* WorktreeCleanupJobRepository;
      const cleanup = yield* jobs.enqueue(
        intent({ id: "cleanup-needs-attention", path: "/tmp/reviewed" }),
      );
      yield* jobs.tryReserveForRemoval({
        threadId: cleanup.threadId,
        canonicalWorktreePath: "/tmp/reviewed",
        reservedAt: at(0),
      });
      yield* jobs.recordFailure({
        threadId: cleanup.threadId,
        error: "permanent failure",
        now: at(1),
        maxAttempts: 1,
      });

      const reactivated = yield* jobs.enqueue(
        intent({
          id: "cleanup-needs-attention",
          path: "/tmp/reviewed-again",
          source: "delete",
          requestedAt: at(10),
          allowTerminalReset: true,
        }),
      );

      assert.equal(reactivated.status, "waiting");
      assert.equal(reactivated.worktreePath, "/tmp/reviewed-again");
      assert.equal(reactivated.source, "delete");
      assert.equal(reactivated.attemptCount, 0);
      assert.equal(reactivated.nextAttemptAt, at(10));
      assert.equal(reactivated.lastReason, null);
      assert.equal(reactivated.lastError, null);
    }),
  );

  it.effect("returns a reserved removal to waiting when cleanup is deferred", () =>
    Effect.gen(function* () {
      const jobs = yield* WorktreeCleanupJobRepository;
      const cleanup = yield* jobs.enqueue(
        intent({ id: "cleanup-deferred", path: "/tmp/deferred" }),
      );
      yield* jobs.tryReserveForRemoval({
        threadId: cleanup.threadId,
        canonicalWorktreePath: "/tmp/deferred",
        reservedAt: at(0),
      });

      const deferred = yield* jobs.defer({
        threadId: cleanup.threadId,
        nextAttemptAt: at(10),
        reason: "dirty-worktree",
      });

      assert.equal(deferred.pipe(Option.getOrThrow).status, "waiting");
      assert.equal(deferred.pipe(Option.getOrThrow).nextAttemptAt, at(10));
      assert.isFalse(yield* jobs.hasReservationByPath("/tmp/deferred"));
      assert.isFalse(
        (yield* jobs.listDue({ now: at(9) })).some((job) => job.threadId === cleanup.threadId),
      );
      assert.isTrue(
        (yield* jobs.listDue({ now: at(10) })).some((job) => job.threadId === cleanup.threadId),
      );
    }),
  );

  it.effect("reactivates a terminal row only for an explicit new lifecycle", () =>
    Effect.gen(function* () {
      const jobs = yield* WorktreeCleanupJobRepository;
      const cleanup = yield* jobs.enqueue(intent({ id: "cleanup-reused", path: "/tmp/reused" }));
      yield* jobs.cancelByThreadId(cleanup.threadId);

      const reactivated = yield* jobs.enqueue(
        intent({
          id: "cleanup-reused",
          path: "/tmp/reused-again",
          source: "delete",
          allowTerminalReset: true,
        }),
      );

      assert.equal(reactivated.status, "waiting");
      assert.equal(reactivated.worktreePath, "/tmp/reused-again");
      assert.equal(reactivated.source, "delete");
      assert.equal(reactivated.attemptCount, 0);
    }),
  );

  it.effect("can complete a waiting intent when another alias already removed the path", () =>
    Effect.gen(function* () {
      const jobs = yield* WorktreeCleanupJobRepository;
      const cleanup = yield* jobs.enqueue(
        intent({ id: "cleanup-already-absent", path: "/tmp/already-absent" }),
      );

      const completed = yield* jobs.markCompletedWithoutRemoval({
        threadId: cleanup.threadId,
      });

      assert.equal(completed.pipe(Option.getOrThrow).status, "completed");
      assert.equal(
        (yield* jobs.getByThreadId(cleanup.threadId)).pipe(Option.getOrThrow).lastReason,
        "worktree-already-absent",
      );
      assert.isFalse(
        (yield* jobs.listDue({ now: at(100) })).some((job) => job.threadId === cleanup.threadId),
      );
    }),
  );

  it.effect("does not offer legacy rows for manual retry", () =>
    Effect.gen(function* () {
      const jobs = yield* WorktreeCleanupJobRepository;
      const threadId = ThreadId.make("legacy-retry");
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        INSERT INTO worktree_cleanup_jobs (
          thread_id, cwd, worktree_path, canonical_worktree_path,
          requested_at, source, status
        )
        VALUES (
          ${threadId}, '/tmp/project', '/tmp/legacy-retry', '/tmp/legacy-retry',
          ${at(0)}, 'legacy', 'needs-attention'
        )
      `;

      assert.isTrue(
        Option.isNone(
          yield* jobs.retry({
            threadId,
            nextAttemptAt: at(1),
          }),
        ),
      );
      assert.equal(
        (yield* jobs.getByThreadId(threadId)).pipe(Option.getOrThrow).status,
        "needs-attention",
      );
    }),
  );
});
