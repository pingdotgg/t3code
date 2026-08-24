import type * as comprehendmedical from "@distilled.cloud/aws/comprehendmedical";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `comprehendmedical:StopEntitiesDetectionV2Job` — stop an in-progress asynchronous medical entity detection job.
 *
 * Comprehend Medical has no resource-level IAM, so the binding takes no
 * arguments and grants `comprehendmedical:StopEntitiesDetectionV2Job` on `*`. Provide the
 * implementation with `Effect.provide(AWS.ComprehendMedical.StopEntitiesDetectionV2JobHttp)`.
 *
 * @binding
 * @section Batch Entity Detection Jobs
 * @example Stop a Running Job
 * ```typescript
 * // init
 * const stopEntitiesDetectionV2Job = yield* AWS.ComprehendMedical.StopEntitiesDetectionV2Job();
 *
 * // runtime
 * yield* stopEntitiesDetectionV2Job({ JobId: jobId });
 * ```
 */
export interface StopEntitiesDetectionV2Job extends Binding.Service<
  StopEntitiesDetectionV2Job,
  "AWS.ComprehendMedical.StopEntitiesDetectionV2Job",
  () => Effect.Effect<
    (
      request: comprehendmedical.StopEntitiesDetectionV2JobRequest,
    ) => Effect.Effect<
      comprehendmedical.StopEntitiesDetectionV2JobResponse,
      comprehendmedical.StopEntitiesDetectionV2JobError
    >
  >
> {}
export const StopEntitiesDetectionV2Job =
  Binding.Service<StopEntitiesDetectionV2Job>(
    "AWS.ComprehendMedical.StopEntitiesDetectionV2Job",
  );
