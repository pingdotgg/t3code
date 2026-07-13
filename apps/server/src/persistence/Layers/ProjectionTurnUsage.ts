import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Struct from "effect/Struct";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as SqlSchema from "effect/unstable/sql/SqlSchema";

import { toPersistenceDecodeError, toPersistenceSqlError } from "../Errors.ts";
import {
  DeleteProjectionTurnUsageByThreadInput,
  ListProjectionTurnUsageByThreadInput,
  ProjectionTurnUsage,
  ProjectionTurnUsageRepository,
  ProjectionUsageSummaryInput,
  type ProjectionTurnUsageRepositoryShape,
  type ProjectionUsageBucket,
  type ProjectionUsageSummary,
} from "../Services/ProjectionTurnUsage.ts";

const ProjectionTurnUsageDbRowSchema = ProjectionTurnUsage.mapFields(
  Struct.assign({
    usage: Schema.fromJsonString(ProjectionTurnUsage.fields.usage),
  }),
);

type Usage = typeof ProjectionTurnUsage.fields.usage.Type;

function toPersistenceSqlOrDecodeError(sqlOperation: string, decodeOperation: string) {
  return (cause: unknown) =>
    Schema.isSchemaError(cause)
      ? toPersistenceDecodeError(decodeOperation)(cause)
      : toPersistenceSqlError(sqlOperation)(cause);
}

function addUsage(left: Usage, right: Usage): Usage {
  const total = (key: keyof Usage) =>
    ((left[key] as number | undefined) ?? 0) + ((right[key] as number | undefined) ?? 0);
  return {
    usedTokens: total("usedTokens"),
    totalProcessedTokens: total("totalProcessedTokens"),
    inputTokens: total("inputTokens"),
    uncachedInputTokens: total("uncachedInputTokens"),
    cachedInputTokens: total("cachedInputTokens"),
    cacheCreationInputTokens: total("cacheCreationInputTokens"),
    cacheReadInputTokens: total("cacheReadInputTokens"),
    outputTokens: total("outputTokens"),
    reasoningOutputTokens: total("reasoningOutputTokens"),
  };
}

function emptyUsage(): Usage {
  return { usedTokens: 0 };
}

function bucketCost(rows: ReadonlyArray<ProjectionTurnUsage>): {
  readonly totalCostUsd: number | null;
  readonly costIsPartial: boolean;
} {
  let total = 0;
  let hasCost = false;
  for (const row of rows) {
    const cost = row.usage.cost?.totalCostUsd;
    if (cost === undefined) continue;
    hasCost = true;
    total += cost;
  }
  return {
    totalCostUsd: hasCost ? total : null,
    costIsPartial: rows.some((row) => !row.usage.cost),
  };
}

function makeBucket(
  id: string,
  label: string,
  rows: ReadonlyArray<ProjectionTurnUsage>,
): ProjectionUsageBucket {
  const cost = bucketCost(rows);
  return {
    id,
    label,
    turns: rows.length,
    usage: rows.reduce((acc, row) => addUsage(acc, row.usage), emptyUsage()),
    totalCostUsd: cost.totalCostUsd,
    costIsPartial: cost.costIsPartial,
  };
}

function groupRows(
  rows: ReadonlyArray<ProjectionTurnUsage>,
  key: (row: ProjectionTurnUsage) => string,
  label: (row: ProjectionTurnUsage) => string,
): ProjectionUsageBucket[] {
  const groups = new Map<string, ProjectionTurnUsage[]>();
  const labels = new Map<string, string>();
  for (const row of rows) {
    const id = key(row);
    const entries = groups.get(id) ?? [];
    entries.push(row);
    groups.set(id, entries);
    labels.set(id, label(row));
  }
  return [...groups.entries()]
    .map(([id, entries]) => makeBucket(id, labels.get(id) ?? id, entries))
    .toSorted(
      (left, right) =>
        right.usage.usedTokens - left.usage.usedTokens || left.id.localeCompare(right.id),
    );
}

function summarizeRows(rows: ReadonlyArray<ProjectionTurnUsage>): ProjectionUsageSummary {
  const totalUsage = rows.reduce((acc, row) => addUsage(acc, row.usage), emptyUsage());
  const cost = bucketCost(rows);
  return {
    totalTurns: rows.length,
    totalInputTokens: totalUsage.inputTokens ?? 0,
    totalUncachedInputTokens: totalUsage.uncachedInputTokens ?? 0,
    totalCachedInputTokens: totalUsage.cachedInputTokens ?? 0,
    totalCacheCreationInputTokens: totalUsage.cacheCreationInputTokens ?? 0,
    totalCacheReadInputTokens: totalUsage.cacheReadInputTokens ?? 0,
    totalOutputTokens: totalUsage.outputTokens ?? 0,
    totalReasoningOutputTokens: totalUsage.reasoningOutputTokens ?? 0,
    totalProcessedTokens: totalUsage.totalProcessedTokens ?? totalUsage.usedTokens,
    totalCostUsd: cost.totalCostUsd,
    costIsPartial: cost.costIsPartial,
    byProvider: groupRows(
      rows,
      (row) => row.providerInstanceId ?? row.provider,
      (row) => row.providerInstanceId ?? row.provider,
    ),
    byModel: groupRows(
      rows,
      (row) => `${row.providerInstanceId ?? row.provider}:${row.model ?? "unknown"}`,
      (row) => row.model ?? "Unknown model",
    ),
  };
}

const makeProjectionTurnUsageRepository = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const upsertProjectionTurnUsage = SqlSchema.void({
    Request: ProjectionTurnUsage,
    execute: (row) => sql`
      INSERT INTO projection_turn_usage (
        thread_id,
        turn_id,
        provider,
        provider_instance_id,
        model,
        usage_json,
        updated_at
      )
      VALUES (
        ${row.threadId},
        ${row.turnId},
        ${row.provider},
        ${row.providerInstanceId},
        ${row.model},
        ${JSON.stringify(row.usage)},
        ${row.updatedAt}
      )
      ON CONFLICT (thread_id, turn_id)
      DO UPDATE SET
        provider = excluded.provider,
        provider_instance_id = excluded.provider_instance_id,
        model = excluded.model,
        usage_json = excluded.usage_json,
        updated_at = excluded.updated_at
    `,
  });

  const listProjectionTurnUsageByThread = SqlSchema.findAll({
    Request: ListProjectionTurnUsageByThreadInput,
    Result: ProjectionTurnUsageDbRowSchema,
    execute: ({ threadId }) => sql`
      SELECT
        thread_id AS "threadId",
        turn_id AS "turnId",
        provider,
        provider_instance_id AS "providerInstanceId",
        model,
        usage_json AS "usage",
        updated_at AS "updatedAt"
      FROM projection_turn_usage
      WHERE thread_id = ${threadId}
      ORDER BY updated_at ASC, turn_id ASC
    `,
  });

  const summarizeProjectionTurnUsageRows = SqlSchema.findAll({
    Request: ProjectionUsageSummaryInput,
    Result: ProjectionTurnUsageDbRowSchema,
    execute: ({ since, until, providerInstanceId, threadId }) => sql`
      SELECT
        thread_id AS "threadId",
        turn_id AS "turnId",
        provider,
        provider_instance_id AS "providerInstanceId",
        model,
        usage_json AS "usage",
        updated_at AS "updatedAt"
      FROM projection_turn_usage
      WHERE updated_at >= ${since}
        AND (${until ?? null} IS NULL OR updated_at <= ${until ?? null})
        AND (${providerInstanceId ?? null} IS NULL OR provider_instance_id = ${providerInstanceId ?? null})
        AND (${threadId ?? null} IS NULL OR thread_id = ${threadId ?? null})
      ORDER BY updated_at ASC, thread_id ASC, turn_id ASC
    `,
  });

  const deleteProjectionTurnUsageByThread = SqlSchema.void({
    Request: DeleteProjectionTurnUsageByThreadInput,
    execute: ({ threadId }) => sql`
      DELETE FROM projection_turn_usage
      WHERE thread_id = ${threadId}
    `,
  });

  const upsert: ProjectionTurnUsageRepositoryShape["upsert"] = (row) =>
    upsertProjectionTurnUsage(row).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionTurnUsageRepository.upsert:query",
          "ProjectionTurnUsageRepository.upsert:encodeRequest",
        ),
      ),
    );

  const listByThreadId: ProjectionTurnUsageRepositoryShape["listByThreadId"] = (input) =>
    listProjectionTurnUsageByThread(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionTurnUsageRepository.listByThreadId:query",
          "ProjectionTurnUsageRepository.listByThreadId:decodeRows",
        ),
      ),
    );

  const summarize: ProjectionTurnUsageRepositoryShape["summarize"] = (input) =>
    summarizeProjectionTurnUsageRows(input).pipe(
      Effect.mapError(
        toPersistenceSqlOrDecodeError(
          "ProjectionTurnUsageRepository.summarize:query",
          "ProjectionTurnUsageRepository.summarize:decodeRows",
        ),
      ),
      Effect.map(summarizeRows),
    );

  const deleteByThreadId: ProjectionTurnUsageRepositoryShape["deleteByThreadId"] = (input) =>
    deleteProjectionTurnUsageByThread(input).pipe(
      Effect.mapError(
        toPersistenceSqlError("ProjectionTurnUsageRepository.deleteByThreadId:query"),
      ),
    );

  return {
    upsert,
    listByThreadId,
    summarize,
    deleteByThreadId,
  } satisfies ProjectionTurnUsageRepositoryShape;
});

export const ProjectionTurnUsageRepositoryLive = Layer.effect(
  ProjectionTurnUsageRepository,
  makeProjectionTurnUsageRepository,
);
