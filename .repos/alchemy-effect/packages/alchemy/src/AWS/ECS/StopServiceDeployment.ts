import type * as ECS from "@distilled.cloud/aws/ecs";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Service } from "./Service.ts";

export interface StopServiceDeploymentRequest
  extends ECS.StopServiceDeploymentRequest {}

/**
 * Runtime binding for `ecs:StopServiceDeployment`.
 *
 * Bind this operation to a `Service` inside a function runtime to get a
 * callable that stops an in-progress deployment of the bound service —
 * either abandoning it or rolling back to the last completed revision.
 * The host is granted `ecs:StopServiceDeployment` on the service's
 * deployments.
 * @binding
 * @section Service Deployments
 * @example Roll Back a Bad Deployment
 * ```typescript
 * const stopServiceDeployment = yield* AWS.ECS.StopServiceDeployment(service);
 *
 * yield* stopServiceDeployment({
 *   serviceDeploymentArn: deploymentArn,
 *   stopType: "ROLLBACK",
 * });
 * ```
 */
export interface StopServiceDeployment extends Binding.Service<
  StopServiceDeployment,
  "AWS.ECS.StopServiceDeployment",
  (
    service: Service,
  ) => Effect.Effect<
    (
      request: StopServiceDeploymentRequest,
    ) => Effect.Effect<
      ECS.StopServiceDeploymentResponse,
      ECS.StopServiceDeploymentError
    >
  >
> {}
export const StopServiceDeployment = Binding.Service<StopServiceDeployment>(
  "AWS.ECS.StopServiceDeployment",
);
