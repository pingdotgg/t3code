import type * as SVC from "@distilled.cloud/aws/codepipeline";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

export interface PutJobSuccessResultRequest
  extends SVC.PutJobSuccessResultInput {}

/**
 * Runtime binding for `codepipeline:PutJobSuccessResult` — reports success
 * for a job handed to the workload by a pipeline `Invoke` (Lambda) or
 * custom action. Without this call the action times out.
 *
 * CodePipeline job operations do not support resource-level permissions, so
 * the grant is on `*`. The binding takes no resource — the job id arrives
 * with the invocation event.
 * @binding
 * @section Job Workers
 * @example Complete an Invoke-Action Job
 * ```typescript
 * const putJobSuccess = yield* AWS.CodePipeline.PutJobSuccessResult();
 *
 * yield* putJobSuccess({
 *   jobId: event["CodePipeline.job"].id,
 *   outputVariables: { RELEASE: version },
 * });
 * ```
 */
export interface PutJobSuccessResult extends Binding.Service<
  PutJobSuccessResult,
  "AWS.CodePipeline.PutJobSuccessResult",
  () => Effect.Effect<
    (
      request: PutJobSuccessResultRequest,
    ) => Effect.Effect<
      SVC.PutJobSuccessResultResponse,
      SVC.PutJobSuccessResultError
    >
  >
> {}
export const PutJobSuccessResult = Binding.Service<PutJobSuccessResult>(
  "AWS.CodePipeline.PutJobSuccessResult",
);
