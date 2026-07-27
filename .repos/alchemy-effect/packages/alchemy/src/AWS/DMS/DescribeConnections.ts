import type * as dms from "@distilled.cloud/aws/database-migration-service";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `dms:DescribeConnections`.
 *
 * Bind this operation (account-level) to poll the results of connection
 * tests started with {@link TestConnection} — filter by `endpoint-arn` or
 * `replication-instance-arn`. Provide the implementation with
 * `Effect.provide(AWS.DMS.DescribeConnectionsHttp)`.
 * @binding
 * @section Polling Connection Tests
 * @example Poll a Test Result for an Endpoint
 * ```typescript
 * // init — account-level, no target resource
 * const describeConnections = yield* AWS.DMS.DescribeConnections();
 *
 * // runtime
 * const { Connections } = yield* describeConnections({
 *   Filters: [{ Name: "endpoint-arn", Values: [endpointArn] }],
 * });
 * // Connections[0].Status: "testing" | "successful" | "failed"
 * ```
 */
export interface DescribeConnections extends Binding.Service<
  DescribeConnections,
  "AWS.DMS.DescribeConnections",
  () => Effect.Effect<
    (
      request?: dms.DescribeConnectionsMessage,
    ) => Effect.Effect<
      dms.DescribeConnectionsResponse,
      dms.DescribeConnectionsError
    >
  >
> {}

export const DescribeConnections = Binding.Service<DescribeConnections>(
  "AWS.DMS.DescribeConnections",
);
