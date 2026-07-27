import type * as SVC from "@distilled.cloud/aws/codedeploy";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DeploymentGroup } from "./DeploymentGroup.ts";

export interface ListDeploymentsRequest extends Omit<
  SVC.ListDeploymentsInput,
  "applicationName" | "deploymentGroupName"
> {}

/**
 * Runtime binding for `codedeploy:ListDeployments` — lists the deployment
 * ids of the bound deployment group (optionally filtered by status or
 * create-time range).
 * @binding
 * @section Observing Deployments
 * @example List In-Progress Deployments
 * ```typescript
 * const listDeployments = yield* AWS.CodeDeploy.ListDeployments(group);
 *
 * const { deployments } = yield* listDeployments({
 *   includeOnlyStatuses: ["InProgress"],
 * });
 * ```
 */
export interface ListDeployments extends Binding.Service<
  ListDeployments,
  "AWS.CodeDeploy.ListDeployments",
  <G extends DeploymentGroup>(
    group: G,
  ) => Effect.Effect<
    (
      request?: ListDeploymentsRequest,
    ) => Effect.Effect<SVC.ListDeploymentsOutput, SVC.ListDeploymentsError>
  >
> {}
export const ListDeployments = Binding.Service<ListDeployments>(
  "AWS.CodeDeploy.ListDeployments",
);
