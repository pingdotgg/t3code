import { ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import { Effect, Layer, Option } from "effect";

import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { WorktreeCleanupJobRepositoryLive } from "./WorktreeCleanupJobs.ts";
import { WorktreeCleanupJobRepository } from "../Services/WorktreeCleanupJobs.ts";

const testLayer = it.layer(
  Layer.mergeAll(
    WorktreeCleanupJobRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    SqlitePersistenceMemory,
  ),
);

testLayer("WorktreeCleanupJobRepository", (it) => {
  it.effect("cancels retained jobs without reserving their path", () =>
    Effect.gen(function* () {
      const jobs = yield* WorktreeCleanupJobRepository;
      const threadId = ThreadId.make("thread-cleanup-job");
      const worktreePath = "/tmp/worktree-cleanup-job";
      const job = {
        threadId,
        cwd: "/tmp/project",
        worktreePath,
        requestedAt: "2026-07-30T00:00:00.000Z",
      };

      yield* jobs.upsert(job);
      assert.isTrue(yield* jobs.existsByPath(worktreePath));
      assert.deepEqual(yield* jobs.getPendingByThreadId(threadId), Option.some(job));

      assert.deepEqual(
        yield* jobs.recordFailure({
          threadId,
          error: "first failure",
          maxAttempts: 2,
        }),
        Option.some({ attemptCount: 1, status: "pending" }),
      );
      assert.isTrue(yield* jobs.existsByPath(worktreePath));
      assert.deepEqual(
        yield* jobs.recordFailure({
          threadId,
          error: "second failure",
          maxAttempts: 2,
        }),
        Option.some({ attemptCount: 2, status: "cancelled" }),
      );
      assert.isFalse(yield* jobs.existsByPath(worktreePath));

      yield* jobs.upsert(job);
      yield* jobs.cancelByThreadId(threadId);
      assert.isFalse(yield* jobs.existsByPath(worktreePath));
      assert.isTrue(Option.isNone(yield* jobs.getPendingByThreadId(threadId)));
      assert.deepEqual(yield* jobs.list(), []);

      yield* jobs.upsert({
        ...job,
        threadId: ThreadId.make("thread-cleanup-job-reused"),
      });
      assert.isTrue(yield* jobs.existsByPath(worktreePath));
    }),
  );
});
