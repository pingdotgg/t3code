import type * as SVC from "@distilled.cloud/aws/codepipeline";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface AcknowledgeJobRequest extends SVC.AcknowledgeJobInput {}

/**
 * Runtime binding for `codepipeline:AcknowledgeJob` — confirms receipt of a
 * job returned by `PollForJobs` so the pipeline knows a worker has claimed
 * it. Used for custom actions only; the `nonce` must be the one returned
 * with the polled job.
 *
 * CodePipeline job operations do not support resource-level permissions, so
 * the grant is on `*`. The binding takes no resource — job ids come from
 * polling.
 * @binding
 * @section Job Workers
 * @example Claim a Polled Job
 * ```typescript
 * const acknowledgeJob = yield* AWS.CodePipeline.AcknowledgeJob();
 *
 * const { status } = yield* acknowledgeJob({ jobId, nonce });
 * ```
 */
export interface AcknowledgeJob extends Binding.Service<
  AcknowledgeJob,
  "AWS.CodePipeline.AcknowledgeJob",
  () => Effect.Effect<
    (
      request: AcknowledgeJobRequest,
    ) => Effect.Effect<SVC.AcknowledgeJobOutput, SVC.AcknowledgeJobError>
  >
> {}
export const AcknowledgeJob = Binding.Service<AcknowledgeJob>(
  "AWS.CodePipeline.AcknowledgeJob",
);
