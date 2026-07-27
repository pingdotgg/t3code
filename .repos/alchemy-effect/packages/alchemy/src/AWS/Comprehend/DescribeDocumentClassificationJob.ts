import type * as comprehend from "@distilled.cloud/aws/comprehend";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `comprehend:DescribeDocumentClassificationJob` — get the
 * properties (status, input/output config, timings) of an asynchronous
 * document classification job started with {@link StartDocumentClassificationJob}.
 *
 * The binding takes no arguments and grants the action on `*` (job APIs
 * have no resource-level IAM).
 *
 * @binding
 * @section Monitoring Analysis Jobs
 * @example Poll a DocumentClassification Job
 * ```typescript
 * // init
 * const describeDocumentClassificationJob = yield* AWS.Comprehend.DescribeDocumentClassificationJob();
 *
 * // runtime
 * const job = yield* describeDocumentClassificationJob({ JobId: jobId });
 * // job.DocumentClassificationJobProperties?.JobStatus: "SUBMITTED" | "IN_PROGRESS" | "COMPLETED" | …
 * ```
 */
export interface DescribeDocumentClassificationJob extends Binding.Service<
  DescribeDocumentClassificationJob,
  "AWS.Comprehend.DescribeDocumentClassificationJob",
  () => Effect.Effect<
    (
      request: comprehend.DescribeDocumentClassificationJobRequest,
    ) => Effect.Effect<
      comprehend.DescribeDocumentClassificationJobResponse,
      comprehend.DescribeDocumentClassificationJobError
    >
  >
> {}
export const DescribeDocumentClassificationJob =
  Binding.Service<DescribeDocumentClassificationJob>(
    "AWS.Comprehend.DescribeDocumentClassificationJob",
  );
