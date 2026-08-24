import type * as SVC from "@distilled.cloud/aws/codedeploy";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DeploymentGroup } from "./DeploymentGroup.ts";

/**
 * Runtime binding for `codedeploy:ContinueDeployment` — for a blue/green
 * deployment paused in the ready state (`actionOnTimeout:
 * "STOP_DEPLOYMENT"`), starts rerouting traffic to the replacement
 * environment without waiting for the configured wait time.
 * @binding
 * @section Controlling Deployments
 * @example Approve Traffic Rerouting
 * ```typescript
 * const continueDeployment = yield* AWS.CodeDeploy.ContinueDeployment(group);
 *
 * yield* continueDeployment({
 *   deploymentId,
 *   deploymentWaitType: "READY_WAIT",
 * });
 * ```
 */
export interface ContinueDeployment extends Binding.Service<
  ContinueDeployment,
  "AWS.CodeDeploy.ContinueDeployment",
  <G extends DeploymentGroup>(
    group: G,
  ) => Effect.Effect<
    (
      request: SVC.ContinueDeploymentInput,
    ) => Effect.Effect<
      SVC.ContinueDeploymentResponse,
      SVC.ContinueDeploymentError
    >
  >
> {}
export const ContinueDeployment = Binding.Service<ContinueDeployment>(
  "AWS.CodeDeploy.ContinueDeployment",
);
