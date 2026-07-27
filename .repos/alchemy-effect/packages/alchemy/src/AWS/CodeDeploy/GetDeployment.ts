import type * as SVC from "@distilled.cloud/aws/codedeploy";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DeploymentGroup } from "./DeploymentGroup.ts";

/**
 * Runtime binding for `codedeploy:GetDeployment` — reads a deployment's
 * status, revision, and rollout overview. CodeDeploy authorizes the call
 * against the deployment group the deployment belongs to.
 * @binding
 * @section Observing Deployments
 * @example Poll a Deployment's Status
 * ```typescript
 * const getDeployment = yield* AWS.CodeDeploy.GetDeployment(group);
 *
 * const { deploymentInfo } = yield* getDeployment({ deploymentId });
 * ```
 */
export interface GetDeployment extends Binding.Service<
  GetDeployment,
  "AWS.CodeDeploy.GetDeployment",
  <G extends DeploymentGroup>(
    group: G,
  ) => Effect.Effect<
    (
      request: SVC.GetDeploymentInput,
    ) => Effect.Effect<SVC.GetDeploymentOutput, SVC.GetDeploymentError>
  >
> {}
export const GetDeployment = Binding.Service<GetDeployment>(
  "AWS.CodeDeploy.GetDeployment",
);
