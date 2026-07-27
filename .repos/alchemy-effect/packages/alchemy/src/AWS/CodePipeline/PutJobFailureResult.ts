import type * as SVC from "@distilled.cloud/aws/codepipeline";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface PutJobFailureResultRequest
  extends SVC.PutJobFailureResultInput {}

/**
 * Runtime binding for `codepipeline:PutJobFailureResult` — reports failure
 * for a job handed to the workload by a pipeline `Invoke` (Lambda) or
 * custom action, failing the action immediately instead of timing out.
 *
 * CodePipeline job operations do not support resource-level permissions, so
 * the grant is on `*`. The binding takes no resource — the job id arrives
 * with the invocation event.
 * @binding
 * @section Job Workers
 * @example Fail an Invoke-Action Job
 * ```typescript
 * const putJobFailure = yield* AWS.CodePipeline.PutJobFailureResult();
 *
 * yield* putJobFailure({
 *   jobId: event["CodePipeline.job"].id,
 *   failureDetails: { type: "JobFailed", message: "smoke test failed" },
 * });
 * ```
 */
export interface PutJobFailureResult extends Binding.Service<
  PutJobFailureResult,
  "AWS.CodePipeline.PutJobFailureResult",
  () => Effect.Effect<
    (
      request: PutJobFailureResultRequest,
    ) => Effect.Effect<
      SVC.PutJobFailureResultResponse,
      SVC.PutJobFailureResultError
    >
  >
> {}
export const PutJobFailureResult = Binding.Service<PutJobFailureResult>(
  "AWS.CodePipeline.PutJobFailureResult",
);
