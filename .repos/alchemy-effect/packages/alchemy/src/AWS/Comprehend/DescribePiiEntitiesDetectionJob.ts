import type * as comprehend from "@distilled.cloud/aws/comprehend";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `comprehend:DescribePiiEntitiesDetectionJob` — get the
 * properties (status, input/output config, timings) of an asynchronous
 * PII entity detection job started with {@link StartPiiEntitiesDetectionJob}.
 *
 * The binding takes no arguments and grants the action on `*` (job APIs
 * have no resource-level IAM).
 *
 * @binding
 * @section Monitoring Analysis Jobs
 * @example Poll a PiiEntitiesDetection Job
 * ```typescript
 * // init
 * const describePiiEntitiesDetectionJob = yield* AWS.Comprehend.DescribePiiEntitiesDetectionJob();
 *
 * // runtime
 * const job = yield* describePiiEntitiesDetectionJob({ JobId: jobId });
 * // job.PiiEntitiesDetectionJobProperties?.JobStatus: "SUBMITTED" | "IN_PROGRESS" | "COMPLETED" | …
 * ```
 */
export interface DescribePiiEntitiesDetectionJob extends Binding.Service<
  DescribePiiEntitiesDetectionJob,
  "AWS.Comprehend.DescribePiiEntitiesDetectionJob",
  () => Effect.Effect<
    (
      request: comprehend.DescribePiiEntitiesDetectionJobRequest,
    ) => Effect.Effect<
      comprehend.DescribePiiEntitiesDetectionJobResponse,
      comprehend.DescribePiiEntitiesDetectionJobError
    >
  >
> {}
export const DescribePiiEntitiesDetectionJob =
  Binding.Service<DescribePiiEntitiesDetectionJob>(
    "AWS.Comprehend.DescribePiiEntitiesDetectionJob",
  );
