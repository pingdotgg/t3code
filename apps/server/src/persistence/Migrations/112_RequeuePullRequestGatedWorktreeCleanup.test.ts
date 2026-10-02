import { assert, it } from "@effect/vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { runMigrations } from "../Migrations.ts";
import * as NodeSqliteClient from "../NodeSqliteClient.ts";

it.effect("requeues only cleanup jobs that were blocked by the retired pull-request gate", () =>
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    yield* runMigrations({ toMigrationInclusive: 111 });

    const rows: ReadonlyArray<readonly [string, string, string]> = [
      ["no-pr", "needs-attention", "no-pull-request"],
      ["pr-branch", "needs-attention", "pull-request-worktree-branch-mismatch"],
      ["pr-closed", "needs-attention", "pull-request-closed-unmerged"],
      ["pr-open", "waiting", "pull-request-not-merged"],
      ["pr-unavailable", "waiting", "pull-request-unavailable"],
      ["removal-failed", "needs-attention", "removal-failed"],
      ["deleted-owner", "needs-attention", "archived-thread-was-deleted"],
      ["dirty", "waiting", "dirty-worktree"],
      ["done", "completed", "worktree-already-absent"],
    ];
    yield* Effect.forEach(
      rows,
      ([threadId, status, reason]) => sql`
        INSERT INTO worktree_cleanup_jobs (
          thread_id, cwd, worktree_path, canonical_worktree_path, requested_at, source,
          status, attempt_count, next_attempt_at, last_reason, last_error
        )
        VALUES (
          ${threadId}, '/repo', ${`/worktrees/${threadId}`}, ${`/worktrees/${threadId}`},
          '2026-01-01T00:00:00.000Z', 'archive', ${status}, 4, '2099-01-01T00:00:00.000Z',
          ${reason}, 'old error'
        )
      `,
    );

    yield* runMigrations({ toMigrationInclusive: 112 });

    const result = yield* sql<{
      readonly threadId: string;
      readonly status: string;
      readonly attemptCount: number;
      readonly nextAttemptAt: string | null;
      readonly lastReason: string | null;
    }>`
      SELECT
        thread_id AS "threadId",
        status,
        attempt_count AS "attemptCount",
        next_attempt_at AS "nextAttemptAt",
        last_reason AS "lastReason"
      FROM worktree_cleanup_jobs
      ORDER BY thread_id
    `;
    const byId = new Map(result.map((row) => [row.threadId, row]));

    for (const requeued of ["no-pr", "pr-branch", "pr-closed", "pr-open", "pr-unavailable"]) {
      const row = byId.get(requeued);
      assert.strictEqual(row?.status, "waiting", requeued);
      assert.strictEqual(row?.attemptCount, 0, requeued);
      assert.strictEqual(row?.lastReason, null, requeued);
      assert.isTrue((row?.nextAttemptAt ?? "") < "2099-01-01", requeued);
    }
    assert.strictEqual(byId.get("removal-failed")?.status, "waiting");
    assert.strictEqual(byId.get("deleted-owner")?.status, "needs-attention");
    assert.strictEqual(byId.get("dirty")?.lastReason, "dirty-worktree");
    assert.strictEqual(byId.get("done")?.status, "completed");
  }).pipe(Effect.provide(NodeSqliteClient.layerMemory())),
);
