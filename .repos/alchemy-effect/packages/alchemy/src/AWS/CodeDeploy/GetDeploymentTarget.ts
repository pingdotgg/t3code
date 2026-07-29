import type * as SVC from "@distilled.cloud/aws/codedeploy";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DeploymentGroup } from "./DeploymentGroup.ts";

/**
 * Runtime binding for `codedeploy:GetDeploymentTarget` — reads one
 * deployment target (instance, Lambda function, or ECS task set) of a
 * deployment, including per-lifecycle-event status.
 * @binding
 * @section Observing Deployment Targets
 * @example Read a Target's Status
 * ```typescript
 * const getDeploymentTarget = yield* AWS.CodeDeploy.GetDeploymentTarget(group);
 *
 * const { deploymentTarget } = yield* getDeploymentTarget({
 *   deploymentId,
 *   targetId,
 * });
 * ```
 */
export interface GetDeploymentTarget extends Binding.Service<
  GetDeploymentTarget,
  "AWS.CodeDeploy.GetDeploymentTarget",
  <G extends DeploymentGroup>(
    group: G,
  ) => Effect.Effect<
    (
      request: SVC.GetDeploymentTargetInput,
    ) => Effect.Effect<
      SVC.GetDeploymentTargetOutput,
      SVC.GetDeploymentTargetError
    >
  >
> {}
export const GetDeploymentTarget = Binding.Service<GetDeploymentTarget>(
  "AWS.CodeDeploy.GetDeploymentTarget",
);
