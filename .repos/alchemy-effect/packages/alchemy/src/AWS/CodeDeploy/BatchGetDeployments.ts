import type * as SVC from "@distilled.cloud/aws/codedeploy";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DeploymentGroup } from "./DeploymentGroup.ts";

/**
 * Runtime binding for `codedeploy:BatchGetDeployments` — reads up to 25
 * deployments in one call. CodeDeploy authorizes the call against the
 * deployment group the deployments belong to.
 * @binding
 * @section Observing Deployments
 * @example Read Several Deployments
 * ```typescript
 * const batchGetDeployments = yield* AWS.CodeDeploy.BatchGetDeployments(group);
 *
 * const { deploymentsInfo } = yield* batchGetDeployments({
 *   deploymentIds: ["d-ABCDEF123", "d-GHIJKL456"],
 * });
 * ```
 */
export interface BatchGetDeployments extends Binding.Service<
  BatchGetDeployments,
  "AWS.CodeDeploy.BatchGetDeployments",
  <G extends DeploymentGroup>(
    group: G,
  ) => Effect.Effect<
    (
      request: SVC.BatchGetDeploymentsInput,
    ) => Effect.Effect<
      SVC.BatchGetDeploymentsOutput,
      SVC.BatchGetDeploymentsError
    >
  >
> {}
export const BatchGetDeployments = Binding.Service<BatchGetDeployments>(
  "AWS.CodeDeploy.BatchGetDeployments",
);
