import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import { IsoDateTime } from "@t3tools/contracts";

import { toPersistenceSqlError } from "../Errors.ts";
import {
  ListProjectionUsageFactsInput,
  ProjectionUsageFact,
  ProjectionUsageRepository,
  type ProjectionUsageRepositoryShape,
  ProjectionUsageSessionModelSum,
  RedactProjectionUsageThreadInput,
} from "../Services/ProjectionUsage.ts";

const ProjectionUsageFactDbRowSchema = ProjectionUsageFact.mapFields(
  Struct.assign({
    stale: Schema.Number,
  }),
);

const EarliestObservedAtRowSchema = Schema.Struct({
  earliestObservedAt: Schema.NullOr(IsoDateTime),
});

function toProjectionUsageFact(
  row: Schema.Schema.Type<typeof ProjectionUsageFactDbRowSchema>,
): ProjectionUsageFact {
  return {
    ...row,
    stale: row.stale === 1,
  };
}

const makeProjectionUsageRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionUsageFactRow = SqlSchema.void({
    Request: ProjectionUsageFact,
    execute: (row) =>
      sql`
        INSERT INTO projection_usage_facts (
          fact_id,
          thread_id,
          turn_id,
          project_id,
          provider,
          provider_instance_id,
          provider_session_id,
          model,
          model_raw,
          reasoning_effort,
          kind,
          input_tokens,
          cached_input_tokens,
          cache_creation_tokens,
          output_tokens,
          reasoning_output_tokens,
          cost_micro_usd,
          stale,
          observed_at
        )
        VALUES (
          ${row.factId},
          ${row.threadId},
          ${row.turnId},
          ${row.projectId},
          ${row.provider},
          ${row.providerInstanceId},
          ${row.providerSessionId},
          ${row.model},
          ${row.modelRaw},
          ${row.reasoningEffort},
          ${row.kind},
          ${row.inputTokens},
          ${row.cachedInputTokens},
          ${row.cacheCreationTokens},
          ${row.outputTokens},
          ${row.reasoningOutputTokens},
          ${row.costMicroUsd},
          ${row.stale ? 1 : 0},
          ${row.observedAt}
        )
        ON CONFLICT (fact_id)
        DO UPDATE SET
          thread_id = excluded.thread_id,
          turn_id = excluded.turn_id,
          project_id = excluded.project_id,
          provider = excluded.provider,
          provider_instance_id = excluded.provider_instance_id,
          provider_session_id = excluded.provider_session_id,
          model = excluded.model,
          model_raw = excluded.model_raw,
          reasoning_effort = excluded.reasoning_effort,
          kind = excluded.kind,
          input_tokens = excluded.input_tokens,
          cached_input_tokens = excluded.cached_input_tokens,
          cache_creation_tokens = excluded.cache_creation_tokens,
          output_tokens = excluded.output_tokens,
          reasoning_output_tokens = excluded.reasoning_output_tokens,
          cost_micro_usd = excluded.cost_micro_usd,
          stale = excluded.stale,
          observed_at = excluded.observed_at
      `,
  });

  const redactProjectionUsageThreadRows = SqlSchema.void({
    Request: RedactProjectionUsageThreadInput,
    execute: ({ threadId }) =>
      sql`
        UPDATE projection_usage_facts
        SET thread_id = 'deleted', project_id = NULL
        WHERE thread_id = ${threadId}
      `,
  });

  const listProjectionUsageFactRows = SqlSchema.findAll({
    Request: ListProjectionUsageFactsInput,
    Result: ProjectionUsageFactDbRowSchema,
    execute: ({ sinceIso, untilIso }) =>
      sql`
        SELECT
          fact_id AS "factId",
          thread_id AS "threadId",
          turn_id AS "turnId",
          project_id AS "projectId",
          provider,
          provider_instance_id AS "providerInstanceId",
          provider_session_id AS "providerSessionId",
          model,
          model_raw AS "modelRaw",
          reasoning_effort AS "reasoningEffort",
          kind,
          input_tokens AS "inputTokens",
          cached_input_tokens AS "cachedInputTokens",
          cache_creation_tokens AS "cacheCreationTokens",
          output_tokens AS "outputTokens",
          reasoning_output_tokens AS "reasoningOutputTokens",
          cost_micro_usd AS "costMicroUsd",
          stale,
          observed_at AS "observedAt"
        FROM projection_usage_facts
        WHERE (${sinceIso ?? null} IS NULL OR observed_at >= ${sinceIso ?? null})
          AND (${untilIso ?? null} IS NULL OR observed_at < ${untilIso ?? null})
        ORDER BY observed_at ASC
      `,
  });

  const readSessionModelSums = SqlSchema.findAll({
    Request: Schema.Struct({ providerSessionId: Schema.String }),
    Result: ProjectionUsageSessionModelSum,
    execute: ({ providerSessionId }) =>
      sql`
        SELECT
          model,
          COALESCE(SUM(input_tokens), 0) AS "inputTokens",
          COALESCE(SUM(cached_input_tokens), 0) AS "cachedInputTokens",
          COALESCE(SUM(cache_creation_tokens), 0) AS "cacheCreationTokens",
          COALESCE(SUM(output_tokens), 0) AS "outputTokens",
          COALESCE(SUM(reasoning_output_tokens), 0) AS "reasoningOutputTokens",
          COALESCE(SUM(COALESCE(cost_micro_usd, 0)), 0) AS "costMicroUsd"
        FROM projection_usage_facts
        WHERE provider_session_id = ${providerSessionId}
          AND kind IN ('final', 'interval')
        GROUP BY model
      `,
  });

  const readEarliestObservedAt = SqlSchema.findOne({
    Request: Schema.Void,
    Result: EarliestObservedAtRowSchema,
    execute: () =>
      sql`
        SELECT MIN(observed_at) AS "earliestObservedAt"
        FROM projection_usage_facts
      `,
  });

  const upsertFact: ProjectionUsageRepositoryShape["upsertFact"] = (row) =>
    upsertProjectionUsageFactRow(row).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionUsageRepository.upsertFact:query")),
    );

  const redactThread: ProjectionUsageRepositoryShape["redactThread"] = (input) =>
    redactProjectionUsageThreadRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionUsageRepository.redactThread:query")),
    );

  const listFacts: ProjectionUsageRepositoryShape["listFacts"] = (input) =>
    listProjectionUsageFactRows(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionUsageRepository.listFacts:query")),
      Effect.map((rows) => rows.map(toProjectionUsageFact)),
    );

  const earliestObservedAt: ProjectionUsageRepositoryShape["earliestObservedAt"] = () =>
    readEarliestObservedAt(undefined).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionUsageRepository.earliestObservedAt:query")),
      Effect.map((row) => row.earliestObservedAt),
    );

  const sumBySessionModel: ProjectionUsageRepositoryShape["sumBySessionModel"] = (input) =>
    readSessionModelSums(input).pipe(
      Effect.mapError(toPersistenceSqlError("ProjectionUsageRepository.sumBySessionModel:query")),
    );

  return {
    upsertFact,
    redactThread,
    listFacts,
    earliestObservedAt,
    sumBySessionModel,
  } satisfies ProjectionUsageRepositoryShape;
});

export const ProjectionUsageRepositoryLive = Layer.effect(
  ProjectionUsageRepository,
  makeProjectionUsageRepository,
);
