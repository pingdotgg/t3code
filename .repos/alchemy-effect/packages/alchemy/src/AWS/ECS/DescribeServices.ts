import type * as ECS from "@distilled.cloud/aws/ecs";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

export interface DescribeServicesRequest extends Omit<
  ECS.DescribeServicesRequest,
  "cluster"
> {}

/**
 * Runtime binding for `ecs:DescribeServices`.
 *
 * Bind this operation to a `Cluster` inside a function runtime to get a
 * callable that describes services in the bound cluster. The cluster ARN is
 * injected automatically and the host is granted `ecs:DescribeServices` on
 * the cluster's services.
 * @binding
 * @section Describing Services
 * @example Check a Service's Deployment Status
 * ```typescript
 * const describeServices = yield* AWS.ECS.DescribeServices(cluster);
 *
 * const response = yield* describeServices({ services: [serviceName] });
 * const runningCount = response.services?.[0]?.runningCount;
 * ```
 */
export interface DescribeServices extends Binding.Service<
  DescribeServices,
  "AWS.ECS.DescribeServices",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request: DescribeServicesRequest,
    ) => Effect.Effect<ECS.DescribeServicesResponse, ECS.DescribeServicesError>
  >
> {}
export const DescribeServices = Binding.Service<DescribeServices>(
  "AWS.ECS.DescribeServices",
);
