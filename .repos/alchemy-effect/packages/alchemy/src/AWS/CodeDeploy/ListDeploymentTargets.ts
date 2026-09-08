import type * as SVC from "@distilled.cloud/aws/codedeploy";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DeploymentGroup } from "./DeploymentGroup.ts";

/**
 * Runtime binding for `codedeploy:ListDeploymentTargets` — lists the target
 * ids of a deployment (optionally filtered by target status).
 * ### Observing Deployment Targets
 * **Example:** List Failed Targets
 * ```typescript
 * const listDeploymentTargets =
 *   yield* AWS.CodeDeploy.ListDeploymentTargets(group);
 *
 * const { targetIds } = yield* listDeploymentTargets({
 *   deploymentId,
 *   targetFilters: { TargetStatus: ["Failed"] },
 * });
 * ```
 *
 * @binding
 */
export interface ListDeploymentTargets extends Binding.Service<
  ListDeploymentTargets,
  "AWS.CodeDeploy.ListDeploymentTargets",
  <G extends DeploymentGroup>(
    group: G,
  ) => Effect.Effect<
    (
      request: SVC.ListDeploymentTargetsInput,
    ) => Effect.Effect<
      SVC.ListDeploymentTargetsOutput,
      SVC.ListDeploymentTargetsError
    >
  >
> {}
export const ListDeploymentTargets = Binding.Service<ListDeploymentTargets>(
  "AWS.CodeDeploy.ListDeploymentTargets",
);
