import { assert, it } from "@effect/vitest";
import { GitPullRequestAssociation, ProjectId, ThreadId } from "@t3tools/contracts";
import { Effect, Layer, Option } from "effect";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { PullRequestCreationIntentRepository } from "../Services/PullRequestCreationIntents.ts";
import { PullRequestCreationIntentRepositoryLive } from "./PullRequestCreationIntents.ts";

const repositoryLayer = it.layer(
  PullRequestCreationIntentRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
);

repositoryLayer("PullRequestCreationIntentRepository", (it) => {
  it.effect("preserves observed PRs across stale retries and removes completed intents", () =>
    Effect.gen(function* () {
      const repository = yield* PullRequestCreationIntentRepository;
      const intent = {
        actionId: "create-pr-action",
        threadId: ThreadId.make("thread-1"),
        projectId: ProjectId.make("project-1"),
        cwd: "/repo/worktree",
        localBranch: "feature/fix",
        headBranch: "feature/fix",
        headSelector: "feature/fix",
        baseBranch: "main",
        headSha: "0123456789abcdef",
        requestedAt: "2026-09-08T00:00:00.000Z",
        nextAttemptAt: "2026-09-08T00:00:30.000Z",
        attemptCount: 0,
        pullRequest: null,
      };
      const pullRequest = {
        number: 42,
        title: "Fix the feature",
        url: "https://github.com/acme/app/pull/42",
        baseBranch: "main",
        headBranch: "feature/fix",
        headSha: intent.headSha,
        isCrossRepository: false,
        headRepositoryNameWithOwner: "acme/app",
        state: "open",
      } satisfies typeof GitPullRequestAssociation.Type;

      yield* repository.insert(intent);

      const due = yield* repository.listDue({
        now: "2026-09-08T00:00:30.000Z",
        limit: 10,
      });
      assert.deepStrictEqual(due, [intent]);

      const observed = { ...intent, pullRequest };
      yield* repository.save(observed);
      const stored = yield* repository.getByActionId({ actionId: intent.actionId });
      assert.deepStrictEqual(Option.getOrNull(stored), observed);

      yield* repository.save(intent);
      const retried = yield* repository.getByActionId({ actionId: intent.actionId });
      assert.deepStrictEqual(Option.getOrNull(retried), observed);

      yield* repository.deleteByActionId({ actionId: intent.actionId });
      assert.deepStrictEqual(
        Option.getOrNull(yield* repository.getByActionId({ actionId: intent.actionId })),
        null,
      );
    }),
  );
});
