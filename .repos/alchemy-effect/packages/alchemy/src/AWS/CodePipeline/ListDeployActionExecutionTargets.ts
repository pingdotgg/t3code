import type * as SVC from "@distilled.cloud/aws/codepipeline";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Pipeline } from "./Pipeline.ts";

export interface ListDeployActionExecutionTargetsRequest extends Omit<
  SVC.ListDeployActionExecutionTargetsInput,
  "pipelineName"
> {}

/**
 * Runtime binding for `codepipeline:ListDeployActionExecutionTargets` —
 * enumerates the targets (instances, tasks, functions) a deploy action
 * execution rolled out to.
 * @binding
 * @section Observing Pipelines
 * @example List Deploy Targets
 * ```typescript
 * const listTargets =
 *   yield* AWS.CodePipeline.ListDeployActionExecutionTargets(pipeline);
 *
 * const { targets } = yield* listTargets({
 *   actionExecutionId: actionExecutionId,
 * });
 * ```
 */
export interface ListDeployActionExecutionTargets extends Binding.Service<
  ListDeployActionExecutionTargets,
  "AWS.CodePipeline.ListDeployActionExecutionTargets",
  <P extends Pipeline>(
    pipeline: P,
  ) => Effect.Effect<
    (
      request: ListDeployActionExecutionTargetsRequest,
    ) => Effect.Effect<
      SVC.ListDeployActionExecutionTargetsOutput,
      SVC.ListDeployActionExecutionTargetsError
    >
  >
> {}
export const ListDeployActionExecutionTargets =
  Binding.Service<ListDeployActionExecutionTargets>(
    "AWS.CodePipeline.ListDeployActionExecutionTargets",
  );
