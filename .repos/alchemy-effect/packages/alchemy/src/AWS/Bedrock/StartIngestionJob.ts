import type * as bedrock from "@distilled.cloud/aws/bedrock-agent";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DataSource } from "./DataSource.ts";

/**
 * The `StartIngestionJob` request with the binding-injected
 * `knowledgeBaseId` and `dataSourceId` removed — they are supplied
 * automatically from the bound {@link DataSource}.
 */
export interface StartIngestionJobRequest extends Omit<
  bedrock.StartIngestionJobRequest,
  "knowledgeBaseId" | "dataSourceId"
> {}

/**
 * Runtime binding for `bedrock-agent:StartIngestionJob` — kick off an
 * ingestion (sync) job that reads the bound {@link DataSource}'s content
 * and indexes it into its knowledge base.
 *
 * The binding grants the function `bedrock:StartIngestionJob` scoped to the
 * data source's parent knowledge base. Poll the returned job with
 * {@link GetIngestionJob} until its status settles.
 *
 * @binding
 * @section Syncing a Data Source
 * @example Start an Ingestion Job
 * ```typescript
 * // init
 * const startIngestionJob = yield* Bedrock.StartIngestionJob(dataSource);
 *
 * // runtime
 * const { ingestionJob } = yield* startIngestionJob({
 *   description: "nightly refresh",
 * });
 * const jobId = ingestionJob.ingestionJobId;
 * ```
 */
export interface StartIngestionJob extends Binding.Service<
  StartIngestionJob,
  "AWS.Bedrock.StartIngestionJob",
  <D extends DataSource>(
    dataSource: D,
  ) => Effect.Effect<
    (
      request: StartIngestionJobRequest,
    ) => Effect.Effect<
      bedrock.StartIngestionJobResponse,
      bedrock.StartIngestionJobError
    >
  >
> {}
export const StartIngestionJob = Binding.Service<StartIngestionJob>(
  "AWS.Bedrock.StartIngestionJob",
);
