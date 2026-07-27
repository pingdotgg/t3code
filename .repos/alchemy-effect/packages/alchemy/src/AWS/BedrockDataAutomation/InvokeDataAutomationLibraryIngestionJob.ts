import type * as bda from "@distilled.cloud/aws/bedrock-data-automation";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DataAutomationLibrary } from "./DataAutomationLibrary.ts";

/**
 * `InvokeDataAutomationLibraryIngestionJob` request with `libraryArn`
 * injected from the bound {@link DataAutomationLibrary}.
 */
export interface InvokeDataAutomationLibraryIngestionJobRequest extends Omit<
  bda.InvokeDataAutomationLibraryIngestionJobRequest,
  "libraryArn"
> {}

/**
 * Runtime binding for the `InvokeDataAutomationLibraryIngestionJob`
 * operation (IAM action `bedrock:InvokeDataAutomationLibraryIngestionJob` on
 * the library ARN) — start an asynchronous ingestion job that upserts or
 * deletes entities in the bound library from a deployed Function.
 *
 * Entities can be passed inline (`inputConfiguration.inlinePayload`) or as
 * an S3 object; results are written to `outputConfiguration.s3Uri` with the
 * caller's S3 permissions. Provide the implementation with
 * `Effect.provide(AWS.BedrockDataAutomation.InvokeDataAutomationLibraryIngestionJobHttp)`.
 * @binding
 * @section Library Ingestion
 * @example Upsert A Vocabulary Entity Inline
 * ```typescript
 * // deploy time — bind the library
 * const ingest =
 *   yield* AWS.BedrockDataAutomation.InvokeDataAutomationLibraryIngestionJob(library);
 *
 * // runtime — upsert one vocabulary entity
 * const { jobArn } = yield* ingest({
 *   entityType: "VOCABULARY",
 *   operationType: "UPSERT",
 *   inputConfiguration: {
 *     inlinePayload: {
 *       upsertEntitiesInfo: [
 *         {
 *           vocabulary: {
 *             language: "EN",
 *             phrases: [{ text: "Alchemy", displayAsText: "Alchemy" }],
 *           },
 *         },
 *       ],
 *     },
 *   },
 *   outputConfiguration: { s3Uri: `s3://${bucket}/library-results/` },
 * });
 * ```
 */
export interface InvokeDataAutomationLibraryIngestionJob extends Binding.Service<
  InvokeDataAutomationLibraryIngestionJob,
  "AWS.BedrockDataAutomation.InvokeDataAutomationLibraryIngestionJob",
  (
    library: DataAutomationLibrary,
  ) => Effect.Effect<
    (
      request: InvokeDataAutomationLibraryIngestionJobRequest,
    ) => Effect.Effect<
      bda.InvokeDataAutomationLibraryIngestionJobResponse,
      bda.InvokeDataAutomationLibraryIngestionJobError
    >
  >
> {}
export const InvokeDataAutomationLibraryIngestionJob =
  Binding.Service<InvokeDataAutomationLibraryIngestionJob>(
    "AWS.BedrockDataAutomation.InvokeDataAutomationLibraryIngestionJob",
  );
