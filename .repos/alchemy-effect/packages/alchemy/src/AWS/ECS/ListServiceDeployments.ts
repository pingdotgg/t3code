import type * as ECS from "@distilled.cloud/aws/ecs";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Service } from "./Service.ts";

export interface ListServiceDeploymentsRequest extends Omit<
  ECS.ListServiceDeploymentsRequest,
  "service" | "cluster"
> {}

/**
 * Runtime binding for `ecs:ListServiceDeployments`.
 *
 * Bind this operation to a `Service` inside a function runtime to get a
 * callable that lists the bound service's deployments (newest first). The
 * service and cluster ARNs are injected automatically and the host is
 * granted `ecs:ListServiceDeployments` on the service.
 * @binding
 * @section Service Deployments
 * @example Find the In-Progress Deployment
 * ```typescript
 * const listServiceDeployments = yield* AWS.ECS.ListServiceDeployments(service);
 *
 * const response = yield* listServiceDeployments({
 *   status: ["IN_PROGRESS"],
 * });
 * const deploymentArn = response.serviceDeployments?.[0]?.serviceDeploymentArn;
 * ```
 */
export interface ListServiceDeployments extends Binding.Service<
  ListServiceDeployments,
  "AWS.ECS.ListServiceDeployments",
  (
    service: Service,
  ) => Effect.Effect<
    (
      request: ListServiceDeploymentsRequest,
    ) => Effect.Effect<
      ECS.ListServiceDeploymentsResponse,
      ECS.ListServiceDeploymentsError
    >
  >
> {}
export const ListServiceDeployments = Binding.Service<ListServiceDeployments>(
  "AWS.ECS.ListServiceDeployments",
);
