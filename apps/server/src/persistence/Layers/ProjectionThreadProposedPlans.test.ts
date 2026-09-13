import { ThreadId } from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlClient from "effect/unstable/sql/SqlClient";

import { ProjectionThreadProposedPlanRepository } from "../Services/ProjectionThreadProposedPlans.ts";
import { ProjectionThreadProposedPlanRepositoryLive } from "./ProjectionThreadProposedPlans.ts";
import { SqlitePersistenceMemory } from "./Sqlite.ts";

it.layer(
  ProjectionThreadProposedPlanRepositoryLive.pipe(Layer.provideMerge(SqlitePersistenceMemory)),
)("plan status after clock rollback", (it) => {
  it.effect.each([undefined, 42])(
    "reads plans with an optional persisted creation key: %s",
    (createdSequence) =>
      Effect.gen(function* () {
        const repository = yield* ProjectionThreadProposedPlanRepository;
        const row = {
          planId: `lookup-${createdSequence ?? "legacy"}`,
          threadId: ThreadId.make("plan-lookup"),
          turnId: null,
          planMarkdown: "Do the work",
          implementedAt: null,
          implementationThreadId: null,
          createdAt: "2026-03-01T00:00:00Z",
          updatedAt: "2026-03-01T00:00:00Z",
          ...(createdSequence === undefined ? {} : { createdSequence }),
        };
        yield* repository.upsert(row);
        const result = yield* repository.getByPlanId({
          threadId: row.threadId,
          planId: row.planId,
        });
        assert.equal(result._tag, "Some");
        if (result._tag === "Some") assert.deepEqual(result.value, row);
      }),
  );
  it.effect("uses the newest persisted plan even when an older plan has a later update time", () =>
    Effect.gen(function* () {
      const repository = yield* ProjectionThreadProposedPlanRepository;
      const sql = yield* SqlClient.SqlClient;
      const threadId = ThreadId.make("clock-plan-status");
      yield* sql`INSERT INTO projection_thread_proposed_plans
        (plan_id, thread_id, plan_markdown, implemented_at, created_at, updated_at, created_sequence)
        VALUES
          ('older', ${threadId}, '', NULL, '2026-03-01T12:00:00Z', '2026-03-01T13:00:00Z', 1),
          ('newer', ${threadId}, '', '2026-03-01T02:00:00Z', '2026-03-01T01:00:00Z', '2026-03-01T02:00:00Z', 2)`;
      assert.isFalse(yield* repository.hasActionableByThreadId({ threadId, latestTurnId: null }));
      yield* sql`UPDATE projection_thread_proposed_plans SET implemented_at = NULL WHERE plan_id = 'newer'`;
      assert.isTrue(yield* repository.hasActionableByThreadId({ threadId, latestTurnId: null }));
    }),
  );
});
