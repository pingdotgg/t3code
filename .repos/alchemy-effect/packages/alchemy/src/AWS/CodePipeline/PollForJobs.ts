import type * as SVC from "@distilled.cloud/aws/codepipeline";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface PollForJobsRequest extends SVC.PollForJobsInput {}

/**
 * Runtime binding for `codepipeline:PollForJobs` — fetches pending jobs for
 * a custom action type so a job worker can claim and execute them. Valid
 * only for action types with `Custom` in the owner field; returned jobs
 * include the temporary artifact-store credentials (as `Redacted` values)
 * and any secret configuration values.
 *
 * CodePipeline grants job-worker polling on `*` (the action-type sub-ARN is
 * also honored, but the binding takes no resource — the action type is a
 * request field).
 * @binding
 * @section Job Workers
 * @example Poll for Custom-Action Jobs
 * ```typescript
 * const pollForJobs = yield* AWS.CodePipeline.PollForJobs();
 *
 * const { jobs } = yield* pollForJobs({
 *   actionTypeId: {
 *     category: "Build",
 *     owner: "Custom",
 *     provider: "MyBuilder",
 *     version: "1",
 *   },
 *   maxBatchSize: 1,
 * });
 * ```
 */
export interface PollForJobs extends Binding.Service<
  PollForJobs,
  "AWS.CodePipeline.PollForJobs",
  () => Effect.Effect<
    (
      request: PollForJobsRequest,
    ) => Effect.Effect<SVC.PollForJobsOutput, SVC.PollForJobsError>
  >
> {}
export const PollForJobs = Binding.Service<PollForJobs>(
  "AWS.CodePipeline.PollForJobs",
);
