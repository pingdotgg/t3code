import type * as SVC from "@distilled.cloud/aws/codedeploy";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DeploymentGroup } from "./DeploymentGroup.ts";

export interface CreateDeploymentRequest extends Omit<
  SVC.CreateDeploymentInput,
  "applicationName" | "deploymentGroupName"
> {}

/**
 * Runtime binding for `codedeploy:CreateDeployment` — lets a workload start
 * a deployment through the bound deployment group (e.g. shifting a Lambda
 * alias or rolling an EC2 fleet to a new revision).
 *
 * The response carries the created `deploymentId`, which can be observed
 * with the {@link GetDeployment} binding.
 * @binding
 * @section Starting Deployments
 * @example Deploy a Registered Revision
 * ```typescript
 * const createDeployment = yield* AWS.CodeDeploy.CreateDeployment(group);
 *
 * const { deploymentId } = yield* createDeployment({
 *   revision: {
 *     revisionType: "S3",
 *     s3Location: { bucket, key, bundleType: "zip" },
 *   },
 * });
 * ```
 */
export interface CreateDeployment extends Binding.Service<
  CreateDeployment,
  "AWS.CodeDeploy.CreateDeployment",
  <G extends DeploymentGroup>(
    group: G,
  ) => Effect.Effect<
    (
      request?: CreateDeploymentRequest,
    ) => Effect.Effect<SVC.CreateDeploymentOutput, SVC.CreateDeploymentError>
  >
> {}
export const CreateDeployment = Binding.Service<CreateDeployment>(
  "AWS.CodeDeploy.CreateDeployment",
);
