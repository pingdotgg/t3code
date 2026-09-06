import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionThreadProposedPlansInput,
  HasActionableProjectionThreadProposedPlanInput,
  GetProjectionThreadProposedPlanInput,
  ListProjectionThreadProposedPlansInput,
  ProjectionThreadProposedPlan,
  ProjectionThreadProposedPlanRepository,
  type ProjectionThreadProposedPlanRepositoryShape,
} from "../Services/ProjectionThreadProposedPlans.ts";

const makeProjectionThreadProposedPlanRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionThreadProposedPlanRow = SqlSchema.void({
    Request: ProjectionThreadProposedPlan,
    execute: (row) => sql`
      INSERT INTO projection_thread_proposed_plans (
        plan_id,
        thread_id,
        turn_id,
        plan_markdown,
        implemented_at,
        implementation_thread_id,
        created_at,
        updated_at
      )
      VALUES (
        ${row.planId},
        ${row.threadId},
        ${row.turnId},
        ${row.planMarkdown},
        ${row.implementedAt},
        ${row.implementationThreadId},
        ${row.createdAt},
        ${row.updatedAt}
      )
      ON CONFLICT (plan_id)
      DO UPDATE SET
        thread_id = excluded.thread_id,
        turn_id = excluded.turn_id,
        plan_markdown = excluded.plan_markdown,
        implemented_at = excluded.implemented_at,
        implementation_thread_id = excluded.implementation_thread_id,
        created_at = excluded.created_at,
        updated_at = excluded.updated_at
    `,
  });

  const getProjectionThreadProposedPlanRow = SqlSchema.findOneOption({
    Request: GetProjectionThreadProposedPlanInput,
    Result: ProjectionThreadProposedPlan,
    execute: ({ threadId, planId }) => sql`
      SELECT
        plan_id AS "planId",
        thread_id AS "threadId",
        turn_id AS "turnId",
        plan_markdown AS "planMarkdown",
        implemented_at AS "implementedAt",
        implementation_thread_id AS "implementationThreadId",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM projection_thread_proposed_plans
      WHERE thread_id = ${threadId} AND plan_id = ${planId}
    `,
  });

  const listProjectionThreadProposedPlanRows = SqlSchema.findAll({
    Request: ListProjectionThreadProposedPlansInput,
    Result: ProjectionThreadProposedPlan,
    execute: ({ threadId }) => sql`
      SELECT
        plan_id AS "planId",
        thread_id AS "threadId",
        turn_id AS "turnId",
        plan_markdown AS "planMarkdown",
        implemented_at AS "implementedAt",
        implementation_thread_id AS "implementationThreadId",
        created_at AS "createdAt",
        updated_at AS "updatedAt"
      FROM projection_thread_proposed_plans
      WHERE thread_id = ${threadId}
      ORDER BY created_at ASC, plan_id ASC
    `,
  });

  const deleteProjectionThreadProposedPlanRows = SqlSchema.void({
    Request: DeleteProjectionThreadProposedPlansInput,
    execute: ({ threadId }) => sql`
      DELETE FROM projection_thread_proposed_plans
      WHERE thread_id = ${threadId}
    `,
  });

  const listPlanStatusCandidates = SqlSchema.findAll({
    Request: HasActionableProjectionThreadProposedPlanInput,
    Result: Schema.Struct({
      planId: ProjectionThreadProposedPlan.fields.planId,
      implementedAt: ProjectionThreadProposedPlan.fields.implementedAt,
      updatedAt: ProjectionThreadProposedPlan.fields.updatedAt,
    }),
    execute: ({ threadId, latestTurnId }) => sql`
      SELECT
        plan_id AS "planId",
        implemented_at AS "implementedAt",
        updated_at AS "updatedAt"
      FROM projection_thread_proposed_plans
      WHERE thread_id = ${threadId}
        AND (
          turn_id = ${latestTurnId}
          OR NOT EXISTS (
            SELECT 1 FROM projection_thread_proposed_plans
            WHERE thread_id = ${threadId} AND turn_id = ${latestTurnId}
          )
        )
      ORDER BY created_at ASC, plan_id ASC
    `,
  });

  const hasActionableByThreadId = Effect.fn(
    "ProjectionThreadProposedPlanRepository.hasActionableByThreadId",
  )(
    function* (input: HasActionableProjectionThreadProposedPlanInput) {
      const candidates = yield* listPlanStatusCandidates(input);
      let selected: (typeof candidates)[number] | undefined;
      // Timestamps and IDs use localeCompare, not SQLite byte order. Replace
      // equal candidates to preserve the stable order of listByThreadId.
      for (const candidate of candidates) {
        if (
          selected === undefined ||
          (candidate.updatedAt.localeCompare(selected.updatedAt) ||
            candidate.planId.localeCompare(selected.planId)) >= 0
        ) {
          selected = candidate;
        }
      }
      return selected?.implementedAt === null;
    },
    Effect.mapError(
      toPersistenceSqlError("ProjectionThreadProposedPlanRepository.hasActionableByThreadId:query"),
    ),
  );

  const upsert: ProjectionThreadProposedPlanRepositoryShape["upsert"] = (row) =>
    upsertProjectionThreadProposedPlanRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionThreadProposedPlanRepository.upsert:query")),
    );

  const getByPlanId: ProjectionThreadProposedPlanRepositoryShape["getByPlanId"] = (input) =>
    getProjectionThreadProposedPlanRow(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadProposedPlanRepository.getByPlanId:query"),
      ),
    );

  const listByThreadId: ProjectionThreadProposedPlanRepositoryShape["listByThreadId"] = (input) =>
    listProjectionThreadProposedPlanRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadProposedPlanRepository.listByThreadId:query"),
      ),
    );

  const deleteByThreadId: ProjectionThreadProposedPlanRepositoryShape["deleteByThreadId"] = (
    input,
  ) =>
    deleteProjectionThreadProposedPlanRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionThreadProposedPlanRepository.deleteByThreadId:query"),
      ),
    );

  return {
    upsert,
    listByThreadId,
    hasActionableByThreadId,
    getByPlanId,
    deleteByThreadId,
  } satisfies ProjectionThreadProposedPlanRepositoryShape;
});

export const ProjectionThreadProposedPlanRepositoryLive = Layer.effect(
  ProjectionThreadProposedPlanRepository,
  makeProjectionThreadProposedPlanRepository,
);
