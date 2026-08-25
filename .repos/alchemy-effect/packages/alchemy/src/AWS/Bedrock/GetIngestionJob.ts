import type * as bedrock from "@distilled.cloud/aws/bedrock-agent";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DataSource } from "./DataSource.ts";

/**
 * The `GetIngestionJob` request with the binding-injected `knowledgeBaseId`
 * and `dataSourceId` removed — they are supplied automatically from the
 * bound {@link DataSource}.
 */
export interface GetIngestionJobRequest extends Omit<
  bedrock.GetIngestionJobRequest,
  "knowledgeBaseId" | "dataSourceId"
> {}

/**
 * Runtime binding for `bedrock-agent:GetIngestionJob` — read the status and
 * statistics of an ingestion job started on the bound {@link DataSource}.
 *
 * The binding grants the function `bedrock:GetIngestionJob` scoped to the
 * data source's parent knowledge base.
 *
 * @binding
 * @section Syncing a Data Source
 * @example Poll an Ingestion Job to Completion
 * ```typescript
 * // init
 * const getIngestionJob = yield* Bedrock.GetIngestionJob(dataSource);
 *
 * // runtime
 * const { ingestionJob } = yield* getIngestionJob({
 *   ingestionJobId: jobId,
 * }).pipe(
 *   Effect.repeat({
 *     schedule: Schedule.spaced("5 seconds"),
 *     until: (r) =>
 *       r.ingestionJob.status === "COMPLETE" ||
 *       r.ingestionJob.status === "FAILED",
 *     times: 36,
 *   }),
 * );
 * ```
 */
export interface GetIngestionJob extends Binding.Service<
  GetIngestionJob,
  "AWS.Bedrock.GetIngestionJob",
  <D extends DataSource>(
    dataSource: D,
  ) => Effect.Effect<
    (
      request: GetIngestionJobRequest,
    ) => Effect.Effect<
      bedrock.GetIngestionJobResponse,
      bedrock.GetIngestionJobError
    >
  >
> {}
export const GetIngestionJob = Binding.Service<GetIngestionJob>(
  "AWS.Bedrock.GetIngestionJob",
);
