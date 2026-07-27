import type * as bda from "@distilled.cloud/aws/bedrock-data-automation";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DataAutomationLibrary } from "./DataAutomationLibrary.ts";

/**
 * `GetDataAutomationLibraryIngestionJob` request with `libraryArn` injected
 * from the bound {@link DataAutomationLibrary}.
 */
export interface GetDataAutomationLibraryIngestionJobRequest extends Omit<
  bda.GetDataAutomationLibraryIngestionJobRequest,
  "libraryArn"
> {}

/**
 * Runtime binding for the `GetDataAutomationLibraryIngestionJob` operation
 * (IAM action `bedrock:GetDataAutomationLibraryIngestionJob` on the library
 * ARN) — poll the status of a library ingestion job from a deployed
 * Function.
 *
 * Provide the implementation with
 * `Effect.provide(AWS.BedrockDataAutomation.GetDataAutomationLibraryIngestionJobHttp)`.
 * @binding
 * @section Library Ingestion
 * @example Poll An Ingestion Job
 * ```typescript
 * // deploy time — bind the library
 * const getJob =
 *   yield* AWS.BedrockDataAutomation.GetDataAutomationLibraryIngestionJob(library);
 *
 * // runtime — check the job started by the ingestion binding
 * const { job } = yield* getJob({ jobArn });
 * if (job?.jobStatus === "COMPLETED") {
 *   yield* Effect.log(`ingestion results at ${job.outputConfiguration.s3Uri}`);
 * }
 * ```
 */
export interface GetDataAutomationLibraryIngestionJob extends Binding.Service<
  GetDataAutomationLibraryIngestionJob,
  "AWS.BedrockDataAutomation.GetDataAutomationLibraryIngestionJob",
  (
    library: DataAutomationLibrary,
  ) => Effect.Effect<
    (
      request: GetDataAutomationLibraryIngestionJobRequest,
    ) => Effect.Effect<
      bda.GetDataAutomationLibraryIngestionJobResponse,
      bda.GetDataAutomationLibraryIngestionJobError
    >
  >
> {}
export const GetDataAutomationLibraryIngestionJob =
  Binding.Service<GetDataAutomationLibraryIngestionJob>(
    "AWS.BedrockDataAutomation.GetDataAutomationLibraryIngestionJob",
  );
