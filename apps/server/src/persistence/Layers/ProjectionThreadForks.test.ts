import { ProjectId, ProviderInstanceId, ThreadId, TurnId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";

import { ProjectionThreadRepositoryLive } from "./ProjectionThreads.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";
import { ProjectionThreadRepository } from "../Services/ProjectionThreads.ts";

const layer = it.layer(
  Layer.mergeAll(
    ProjectionThreadRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
    SqlitePersistenceMemory,
  ),
);

layer("ProjectionThread fork persistence", (it) => {
  it.effect("round-trips fork lineage and side-chat state through every repository read", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadRepository;
      const threadId = ThreadId.make("thread-fork");
      const projectId = ProjectId.make("project-fork");
      const fork = {
        sourceThreadId: ThreadId.make("thread-source"),
        sourceTurnId: TurnId.make("turn-source"),
        sourceMessageId: null,
        forkedAt: "2026-09-03T12:00:00.000Z",
      };
      yield* repository.upsert({
        threadId,
        projectId,
        title: "Side chat: Source",
        modelSelection: {
          instanceId: ProviderInstanceId.make("codex"),
          model: "gpt-5.6-sol",
        },
        runtimeMode: "full-access",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        linkedPullRequest: null,
        fork,
        sideChat: 1,
        latestTurnId: null,
        createdAt: "2026-09-03T12:00:00.000Z",
        updatedAt: "2026-09-03T12:00:00.000Z",
        archivedAt: null,
        settledOverride: null,
        settledAt: null,
        unsettledAt: null,
        snoozedUntil: null,
        snoozedAt: null,
        pinnedAt: null,
        pinOrderKey: null,
        titleRegenerationRequestId: null,
        titleRegenerationStartedAt: null,
        latestUserMessageAt: null,
        pendingApprovalCount: 0,
        pendingUserInputCount: 0,
        hasActionableProposedPlan: 0,
        deletedAt: null,
      });

      const byId = Option.getOrThrow(yield* repository.getById({ threadId }));
      assert.deepEqual(byId.fork, fork);
      assert.equal(byId.sideChat, 1);

      const byProject = yield* repository.listByProjectId({ projectId });
      assert.deepEqual(byProject[0]?.fork, fork);
      assert.equal(byProject[0]?.sideChat, 1);
    }),
  );
});
