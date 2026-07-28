import type * as SVC from "@distilled.cloud/aws/codedeploy";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DeploymentGroup } from "./DeploymentGroup.ts";

/**
 * Runtime binding for `codedeploy:BatchGetDeploymentTargets` — reads up to
 * 25 deployment targets of a deployment in one call.
 * @binding
 * @section Observing Deployment Targets
 * @example Read Several Targets
 * ```typescript
 * const batchGetDeploymentTargets =
 *   yield* AWS.CodeDeploy.BatchGetDeploymentTargets(group);
 *
 * const { deploymentTargets } = yield* batchGetDeploymentTargets({
 *   deploymentId,
 *   targetIds,
 * });
 * ```
 */
export interface BatchGetDeploymentTargets extends Binding.Service<
  BatchGetDeploymentTargets,
  "AWS.CodeDeploy.BatchGetDeploymentTargets",
  <G extends DeploymentGroup>(
    group: G,
  ) => Effect.Effect<
    (
      request: SVC.BatchGetDeploymentTargetsInput,
    ) => Effect.Effect<
      SVC.BatchGetDeploymentTargetsOutput,
      SVC.BatchGetDeploymentTargetsError
    >
  >
> {}
export const BatchGetDeploymentTargets =
  Binding.Service<BatchGetDeploymentTargets>(
    "AWS.CodeDeploy.BatchGetDeploymentTargets",
  );
