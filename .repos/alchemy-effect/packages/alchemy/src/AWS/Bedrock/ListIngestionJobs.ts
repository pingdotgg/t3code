import type * as bedrock from "@distilled.cloud/aws/bedrock-agent";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DataSource } from "./DataSource.ts";

/**
 * The `ListIngestionJobs` request with the binding-injected
 * `knowledgeBaseId` and `dataSourceId` removed — they are supplied
 * automatically from the bound {@link DataSource}.
 */
export interface ListIngestionJobsRequest extends Omit<
  bedrock.ListIngestionJobsRequest,
  "knowledgeBaseId" | "dataSourceId"
> {}

/**
 * Runtime binding for `bedrock-agent:ListIngestionJobs` — list the ingestion
 * jobs that have run against the bound {@link DataSource}, optionally
 * filtered and sorted.
 *
 * The binding grants the function `bedrock:ListIngestionJobs` scoped to the
 * data source's parent knowledge base.
 *
 * @binding
 * @section Syncing a Data Source
 * @example List Recent Ingestion Jobs
 * ```typescript
 * // init
 * const listIngestionJobs = yield* Bedrock.ListIngestionJobs(dataSource);
 *
 * // runtime
 * const { ingestionJobSummaries } = yield* listIngestionJobs({
 *   sortBy: { attribute: "STARTED_AT", order: "DESCENDING" },
 *   maxResults: 10,
 * });
 * ```
 */
export interface ListIngestionJobs extends Binding.Service<
  ListIngestionJobs,
  "AWS.Bedrock.ListIngestionJobs",
  <D extends DataSource>(
    dataSource: D,
  ) => Effect.Effect<
    (
      request: ListIngestionJobsRequest,
    ) => Effect.Effect<
      bedrock.ListIngestionJobsResponse,
      bedrock.ListIngestionJobsError
    >
  >
> {}
export const ListIngestionJobs = Binding.Service<ListIngestionJobs>(
  "AWS.Bedrock.ListIngestionJobs",
);
