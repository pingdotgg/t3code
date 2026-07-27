import type * as bedrock from "@distilled.cloud/aws/bedrock-agent";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DataSource } from "./DataSource.ts";

/**
 * The `StopIngestionJob` request with the binding-injected
 * `knowledgeBaseId` and `dataSourceId` removed — they are supplied
 * automatically from the bound {@link DataSource}.
 */
export interface StopIngestionJobRequest extends Omit<
  bedrock.StopIngestionJobRequest,
  "knowledgeBaseId" | "dataSourceId"
> {}

/**
 * Runtime binding for `bedrock-agent:StopIngestionJob` — stop an in-flight
 * ingestion job on the bound {@link DataSource}.
 *
 * The binding grants the function `bedrock:StopIngestionJob` scoped to the
 * data source's parent knowledge base.
 *
 * @binding
 * @section Syncing a Data Source
 * @example Stop a Running Ingestion Job
 * ```typescript
 * // init
 * const stopIngestionJob = yield* Bedrock.StopIngestionJob(dataSource);
 *
 * // runtime
 * const { ingestionJob } = yield* stopIngestionJob({
 *   ingestionJobId: jobId,
 * });
 * ```
 */
export interface StopIngestionJob extends Binding.Service<
  StopIngestionJob,
  "AWS.Bedrock.StopIngestionJob",
  <D extends DataSource>(
    dataSource: D,
  ) => Effect.Effect<
    (
      request: StopIngestionJobRequest,
    ) => Effect.Effect<
      bedrock.StopIngestionJobResponse,
      bedrock.StopIngestionJobError
    >
  >
> {}
export const StopIngestionJob = Binding.Service<StopIngestionJob>(
  "AWS.Bedrock.StopIngestionJob",
);
