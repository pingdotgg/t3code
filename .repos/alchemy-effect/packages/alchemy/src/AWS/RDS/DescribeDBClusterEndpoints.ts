import type * as rds from "@distilled.cloud/aws/rds";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `DescribeDBClusterEndpoints` operation (IAM action
 * `rds:DescribeDBClusterEndpoints`).
 *
 * Lists an Aurora cluster's endpoints (writer, reader, and custom
 * endpoints) with their status and member lists. Provide the implementation with
 * `Effect.provide(AWS.RDS.DescribeDBClusterEndpointsHttp)`.
 * @binding
 * @section Monitoring Databases
 * @example List a Cluster's Endpoints
 * ```typescript
 * const describeDBClusterEndpoints =
 *   yield* AWS.RDS.DescribeDBClusterEndpoints();
 *
 * const page = yield* describeDBClusterEndpoints({
 *   DBClusterIdentifier: clusterId,
 * });
 * ```
 */
export interface DescribeDBClusterEndpoints extends Binding.Service<
  DescribeDBClusterEndpoints,
  "AWS.RDS.DescribeDBClusterEndpoints",
  () => Effect.Effect<
    (
      request?: rds.DescribeDBClusterEndpointsMessage,
    ) => Effect.Effect<
      rds.DBClusterEndpointMessage,
      rds.DescribeDBClusterEndpointsError
    >
  >
> {}
export const DescribeDBClusterEndpoints =
  Binding.Service<DescribeDBClusterEndpoints>(
    "AWS.RDS.DescribeDBClusterEndpoints",
  );
