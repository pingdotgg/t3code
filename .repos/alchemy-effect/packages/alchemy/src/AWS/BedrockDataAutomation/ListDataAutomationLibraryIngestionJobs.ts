import type * as bda from "@distilled.cloud/aws/bedrock-data-automation";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DataAutomationLibrary } from "./DataAutomationLibrary.ts";

/**
 * `ListDataAutomationLibraryIngestionJobs` request with `libraryArn`
 * injected from the bound {@link DataAutomationLibrary}.
 */
export interface ListDataAutomationLibraryIngestionJobsRequest extends Omit<
  bda.ListDataAutomationLibraryIngestionJobsRequest,
  "libraryArn"
> {}

/**
 * Runtime binding for the `ListDataAutomationLibraryIngestionJobs` operation
 * (IAM action `bedrock:ListDataAutomationLibraryIngestionJobs` on the
 * library ARN) — page through the bound library's ingestion jobs from a
 * deployed Function.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.BedrockDataAutomation.ListDataAutomationLibraryIngestionJobsHttp)`.
 * @binding
 * @section Library Ingestion
 * @example List Recent Ingestion Jobs
 * ```typescript
 * // deploy time — bind the library
 * const listJobs =
 *   yield* AWS.BedrockDataAutomation.ListDataAutomationLibraryIngestionJobs(library);
 *
 * // runtime — first page of jobs
 * const { jobs } = yield* listJobs({ maxResults: 25 });
 * ```
 */
export interface ListDataAutomationLibraryIngestionJobs extends Binding.Service<
  ListDataAutomationLibraryIngestionJobs,
  "AWS.BedrockDataAutomation.ListDataAutomationLibraryIngestionJobs",
  (
    library: DataAutomationLibrary,
  ) => Effect.Effect<
    (
      request: ListDataAutomationLibraryIngestionJobsRequest,
    ) => Effect.Effect<
      bda.ListDataAutomationLibraryIngestionJobsResponse,
      bda.ListDataAutomationLibraryIngestionJobsError
    >
  >
> {}
export const ListDataAutomationLibraryIngestionJobs =
  Binding.Service<ListDataAutomationLibraryIngestionJobs>(
    "AWS.BedrockDataAutomation.ListDataAutomationLibraryIngestionJobs",
  );
