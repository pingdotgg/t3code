import type * as SD from "@distilled.cloud/aws/servicediscovery";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Service } from "./Service.ts";

export interface DiscoverInstancesRequest extends Omit<
  SD.DiscoverInstancesRequest,
  "NamespaceName" | "ServiceName"
> {}

/**
 * Runtime binding for `servicediscovery:DiscoverInstances` — the Cloud Map
 * data-plane query that returns a randomized list of registered (by default
 * healthy) instances of a service.
 *
 * Bind this operation to a `Service` inside a function runtime to get a
 * callable that automatically injects the namespace and service names.
 * @binding
 * @section Discovering Instances
 * @example Discover Healthy Instances
 * ```typescript
 * const discover = yield* AWS.CloudMap.DiscoverInstances(service);
 *
 * const { Instances } = yield* discover({});
 * for (const instance of Instances ?? []) {
 *   console.log(instance.InstanceId, instance.Attributes?.AWS_INSTANCE_IPV4);
 * }
 * ```
 *
 * @example Include Unhealthy Instances
 * ```typescript
 * const { Instances } = yield* discover({ HealthStatus: "ALL" });
 * ```
 */
export interface DiscoverInstances extends Binding.Service<
  DiscoverInstances,
  "AWS.CloudMap.DiscoverInstances",
  <S extends Service>(
    service: S,
  ) => Effect.Effect<
    (
      request?: DiscoverInstancesRequest,
    ) => Effect.Effect<SD.DiscoverInstancesResponse, SD.DiscoverInstancesError>
  >
> {}
export const DiscoverInstances = Binding.Service<DiscoverInstances>(
  "AWS.CloudMap.DiscoverInstances",
);
