import type * as dataexchange from "@distilled.cloud/aws/dataexchange";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `dataexchange:CreateJob`.
 *
 * Creates an import/export job — the Data Exchange work unit that moves
 * assets between S3 (or signed URLs, Redshift datashares, API Gateway
 * APIs, Lake Formation permissions) and a revision. Import/export jobs
 * additionally need S3 permissions on the source/destination bucket —
 * attach the matching `AWS.S3` bindings to the same host.
 * Provide the implementation with
 * `Effect.provide(AWS.DataExchange.CreateJobHttp)`.
 * @binding
 * @section Import & Export Jobs
 * @example Import S3 Objects Into A Revision
 * ```typescript
 * const createJob = yield* AWS.DataExchange.CreateJob();
 * const startJob = yield* AWS.DataExchange.StartJob();
 *
 * // runtime
 * const job = yield* createJob({
 *   Type: "IMPORT_ASSETS_FROM_S3",
 *   Details: {
 *     ImportAssetsFromS3: {
 *       DataSetId: dataSetId,
 *       RevisionId: revisionId,
 *       AssetSources: [{ Bucket: bucket, Key: "prices.csv" }],
 *     },
 *   },
 * });
 * yield* startJob({ JobId: job.Id! });
 * ```
 */
export interface CreateJob extends Binding.Service<
  CreateJob,
  "AWS.DataExchange.CreateJob",
  () => Effect.Effect<
    (
      request: dataexchange.CreateJobRequest,
    ) => Effect.Effect<
      dataexchange.CreateJobResponse,
      dataexchange.CreateJobError
    >
  >
> {}
export const CreateJob = Binding.Service<CreateJob>(
  "AWS.DataExchange.CreateJob",
);
