import type * as ECS from "@distilled.cloud/aws/ecs";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Service } from "./Service.ts";

export interface DescribeServiceDeploymentsRequest
  extends ECS.DescribeServiceDeploymentsRequest {}

/**
 * Runtime binding for `ecs:DescribeServiceDeployments`.
 *
 * Bind this operation to a `Service` inside a function runtime to get a
 * callable that describes the bound service's deployments — rollout state,
 * circuit-breaker status, target service revision. The host is granted
 * `ecs:DescribeServiceDeployments` on the service's deployments (deployment
 * ARNs are only known at runtime, e.g. from `ListServiceDeployments`).
 * @binding
 * @section Service Deployments
 * @example Inspect a Deployment's Rollout State
 * ```typescript
 * const describeServiceDeployments =
 *   yield* AWS.ECS.DescribeServiceDeployments(service);
 *
 * const response = yield* describeServiceDeployments({
 *   serviceDeploymentArns: [deploymentArn],
 * });
 * const status = response.serviceDeployments?.[0]?.status;
 * ```
 */
export interface DescribeServiceDeployments extends Binding.Service<
  DescribeServiceDeployments,
  "AWS.ECS.DescribeServiceDeployments",
  (
    service: Service,
  ) => Effect.Effect<
    (
      request: DescribeServiceDeploymentsRequest,
    ) => Effect.Effect<
      ECS.DescribeServiceDeploymentsResponse,
      ECS.DescribeServiceDeploymentsError
    >
  >
> {}
export const DescribeServiceDeployments =
  Binding.Service<DescribeServiceDeployments>(
    "AWS.ECS.DescribeServiceDeployments",
  );
