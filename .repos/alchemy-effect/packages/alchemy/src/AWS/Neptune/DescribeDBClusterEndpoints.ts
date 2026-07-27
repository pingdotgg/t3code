import type * as neptune from "@distilled.cloud/aws/neptune";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `DescribeDBClusterEndpoints` operation (IAM action
 * `rds:DescribeDBClusterEndpoints`).
 *
 * Lists a Neptune cluster's endpoints — the writer, reader, and any custom
 * endpoints — so a function can discover the host names to route Gremlin or
 * openCypher traffic to. Provide the implementation with
 * `Effect.provide(AWS.Neptune.DescribeDBClusterEndpointsHttp)`.
 * @binding
 * @section Monitoring Clusters
 * @example Discover a Cluster's Endpoints
 * ```typescript
 * const describeDBClusterEndpoints =
 *   yield* AWS.Neptune.DescribeDBClusterEndpoints();
 *
 * const page = yield* describeDBClusterEndpoints({
 *   DBClusterIdentifier: clusterId,
 * });
 * const endpoints = page.DBClusterEndpoints?.map((e) => e.Endpoint);
 * ```
 */
export interface DescribeDBClusterEndpoints extends Binding.Service<
  DescribeDBClusterEndpoints,
  "AWS.Neptune.DescribeDBClusterEndpoints",
  () => Effect.Effect<
    (
      request?: neptune.DescribeDBClusterEndpointsMessage,
    ) => Effect.Effect<
      neptune.DBClusterEndpointMessage,
      neptune.DescribeDBClusterEndpointsError
    >
  >
> {}
export const DescribeDBClusterEndpoints =
  Binding.Service<DescribeDBClusterEndpoints>(
    "AWS.Neptune.DescribeDBClusterEndpoints",
  );
