import type * as ECS from "@distilled.cloud/aws/ecs";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Service } from "./Service.ts";

export interface ContinueServiceDeploymentRequest
  extends ECS.ContinueServiceDeploymentRequest {}

/**
 * Runtime binding for `ecs:ContinueServiceDeployment`.
 *
 * Bind this operation to a `Service` inside a function runtime to get a
 * callable that resumes a blue/green deployment paused at a lifecycle-hook
 * stage — the canonical consumer is the deployment lifecycle-hook Lambda
 * that validates the green revision and then approves (or vetoes) the
 * traffic shift. The host is granted `ecs:ContinueServiceDeployment` on the
 * bound service's deployments.
 * @binding
 * @section Service Deployments
 * @example Approve a Lifecycle-Hook Stage
 * ```typescript
 * const continueServiceDeployment =
 *   yield* AWS.ECS.ContinueServiceDeployment(service);
 *
 * yield* continueServiceDeployment({
 *   serviceDeploymentArn: deploymentArn,
 *   hookId,
 * });
 * ```
 */
export interface ContinueServiceDeployment extends Binding.Service<
  ContinueServiceDeployment,
  "AWS.ECS.ContinueServiceDeployment",
  (
    service: Service,
  ) => Effect.Effect<
    (
      request: ContinueServiceDeploymentRequest,
    ) => Effect.Effect<
      ECS.ContinueServiceDeploymentResponse,
      ECS.ContinueServiceDeploymentError
    >
  >
> {}
export const ContinueServiceDeployment =
  Binding.Service<ContinueServiceDeployment>(
    "AWS.ECS.ContinueServiceDeployment",
  );
