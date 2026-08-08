import type * as ECS from "@distilled.cloud/aws/ecs";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Cluster } from "./Cluster.ts";

export interface ListServicesRequest extends Omit<
  ECS.ListServicesRequest,
  "cluster"
> {}

/**
 * Runtime binding for `ecs:ListServices`.
 *
 * Bind this operation to a `Cluster` inside a function runtime to get a
 * callable that lists service ARNs in the bound cluster. The cluster ARN is
 * injected automatically and the grant is conditioned on the bound cluster.
 * @binding
 * @section Listing Services
 * @example List Fargate Services
 * ```typescript
 * const listServices = yield* AWS.ECS.ListServices(cluster);
 *
 * const response = yield* listServices({ launchType: "FARGATE" });
 * const serviceArns = response.serviceArns ?? [];
 * ```
 */
export interface ListServices extends Binding.Service<
  ListServices,
  "AWS.ECS.ListServices",
  (
    cluster: Cluster,
  ) => Effect.Effect<
    (
      request: ListServicesRequest,
    ) => Effect.Effect<ECS.ListServicesResponse, ECS.ListServicesError>
  >
> {}
export const ListServices = Binding.Service<ListServices>(
  "AWS.ECS.ListServices",
);
