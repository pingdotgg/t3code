import type * as comprehendmedical from "@distilled.cloud/aws/comprehendmedical";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `comprehendmedical:DescribeEntitiesDetectionV2Job` — get the properties and status of an asynchronous medical entity detection job.
 *
 * Comprehend Medical has no resource-level IAM, so the binding takes no
 * arguments and grants `comprehendmedical:DescribeEntitiesDetectionV2Job` on `*`. Provide the
 * implementation with `Effect.provide(AWS.ComprehendMedical.DescribeEntitiesDetectionV2JobHttp)`.
 *
 * @binding
 * @section Batch Entity Detection Jobs
 * @example Poll a Job's Status
 * ```typescript
 * // init
 * const describeEntitiesDetectionV2Job = yield* AWS.ComprehendMedical.DescribeEntitiesDetectionV2Job();
 *
 * // runtime
 * const status = yield* describeEntitiesDetectionV2Job({ JobId: jobId });
 * console.log(status.ComprehendMedicalAsyncJobProperties?.JobStatus);
 * ```
 */
export interface DescribeEntitiesDetectionV2Job extends Binding.Service<
  DescribeEntitiesDetectionV2Job,
  "AWS.ComprehendMedical.DescribeEntitiesDetectionV2Job",
  () => Effect.Effect<
    (
      request: comprehendmedical.DescribeEntitiesDetectionV2JobRequest,
    ) => Effect.Effect<
      comprehendmedical.DescribeEntitiesDetectionV2JobResponse,
      comprehendmedical.DescribeEntitiesDetectionV2JobError
    >
  >
> {}
export const DescribeEntitiesDetectionV2Job =
  Binding.Service<DescribeEntitiesDetectionV2Job>(
    "AWS.ComprehendMedical.DescribeEntitiesDetectionV2Job",
  );
