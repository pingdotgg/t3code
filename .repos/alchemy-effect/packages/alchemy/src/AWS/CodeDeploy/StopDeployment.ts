import type * as SVC from "@distilled.cloud/aws/codedeploy";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DeploymentGroup } from "./DeploymentGroup.ts";

/**
 * Runtime binding for `codedeploy:StopDeployment` — attempts to stop an
 * ongoing deployment of the bound deployment group (optionally rolling
 * back).
 * @binding
 * @section Controlling Deployments
 * @example Stop and Roll Back
 * ```typescript
 * const stopDeployment = yield* AWS.CodeDeploy.StopDeployment(group);
 *
 * const { status } = yield* stopDeployment({
 *   deploymentId,
 *   autoRollbackEnabled: true,
 * });
 * ```
 */
export interface StopDeployment extends Binding.Service<
  StopDeployment,
  "AWS.CodeDeploy.StopDeployment",
  <G extends DeploymentGroup>(
    group: G,
  ) => Effect.Effect<
    (
      request: SVC.StopDeploymentInput,
    ) => Effect.Effect<SVC.StopDeploymentOutput, SVC.StopDeploymentError>
  >
> {}
export const StopDeployment = Binding.Service<StopDeployment>(
  "AWS.CodeDeploy.StopDeployment",
);
