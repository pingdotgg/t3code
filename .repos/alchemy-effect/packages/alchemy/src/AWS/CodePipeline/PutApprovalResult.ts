import type * as SVC from "@distilled.cloud/aws/codepipeline";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Pipeline } from "./Pipeline.ts";

export interface PutApprovalResultRequest extends Omit<
  SVC.PutApprovalResultInput,
  "pipelineName"
> {}

/**
 * Runtime binding for `codepipeline:PutApprovalResult` — answers a manual
 * approval action with `Approved` or `Rejected`. The approval `token` comes
 * from the action's `latestExecution` in {@link GetPipelineState}.
 * @binding
 * @section Approvals
 * @example Approve a Manual Approval Action
 * ```typescript
 * const putApproval = yield* AWS.CodePipeline.PutApprovalResult(pipeline);
 *
 * yield* putApproval({
 *   stageName: "Approve",
 *   actionName: "ManualApproval",
 *   token: approvalToken,
 *   result: { status: "Approved", summary: "LGTM" },
 * });
 * ```
 */
export interface PutApprovalResult extends Binding.Service<
  PutApprovalResult,
  "AWS.CodePipeline.PutApprovalResult",
  <P extends Pipeline>(
    pipeline: P,
  ) => Effect.Effect<
    (
      request: PutApprovalResultRequest,
    ) => Effect.Effect<SVC.PutApprovalResultOutput, SVC.PutApprovalResultError>
  >
> {}
export const PutApprovalResult = Binding.Service<PutApprovalResult>(
  "AWS.CodePipeline.PutApprovalResult",
);
