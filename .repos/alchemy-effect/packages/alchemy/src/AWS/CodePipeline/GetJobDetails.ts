import type * as SVC from "@distilled.cloud/aws/codepipeline";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface GetJobDetailsRequest extends SVC.GetJobDetailsInput {}

/**
 * Runtime binding for `codepipeline:GetJobDetails` — fetches the details of
 * a job handed to a custom/Invoke action, including input artifacts and the
 * temporary artifact-store credentials (returned as `Redacted` values).
 *
 * CodePipeline job operations do not support resource-level permissions, so
 * the grant is on `*`. The binding takes no resource — the job id arrives
 * with the invocation event.
 * @binding
 * @section Job Workers
 * @example Fetch Job Details
 * ```typescript
 * const getJobDetails = yield* AWS.CodePipeline.GetJobDetails();
 *
 * const { jobDetails } = yield* getJobDetails({ jobId });
 * ```
 */
export interface GetJobDetails extends Binding.Service<
  GetJobDetails,
  "AWS.CodePipeline.GetJobDetails",
  () => Effect.Effect<
    (
      request: GetJobDetailsRequest,
    ) => Effect.Effect<SVC.GetJobDetailsOutput, SVC.GetJobDetailsError>
  >
> {}
export const GetJobDetails = Binding.Service<GetJobDetails>(
  "AWS.CodePipeline.GetJobDetails",
);
