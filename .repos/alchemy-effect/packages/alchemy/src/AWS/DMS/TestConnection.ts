import type * as dms from "@distilled.cloud/aws/database-migration-service";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Endpoint } from "./Endpoint.ts";
import type { ReplicationInstance } from "./ReplicationInstance.ts";

/**
 * Runtime binding for `dms:TestConnection`.
 *
 * Bind this operation to a ({@link ReplicationInstance}, {@link Endpoint})
 * pair to initiate a connectivity test from the instance to the endpoint's
 * database. The test runs asynchronously — poll the result with
 * {@link DescribeConnections}. Provide the implementation with
 * `Effect.provide(AWS.DMS.TestConnectionHttp)`.
 * @binding
 * @section Testing Connectivity
 * @example Kick Off a Connection Test
 * ```typescript
 * // init — bind the operation to the instance + endpoint
 * const testConnection = yield* AWS.DMS.TestConnection(instance, source);
 *
 * // runtime
 * const { Connection } = yield* testConnection();
 * // Connection.Status === "testing" — poll DescribeConnections for the result
 * ```
 */
export interface TestConnection extends Binding.Service<
  TestConnection,
  "AWS.DMS.TestConnection",
  (
    instance: ReplicationInstance,
    endpoint: Endpoint,
  ) => Effect.Effect<
    () => Effect.Effect<dms.TestConnectionResponse, dms.TestConnectionError>
  >
> {}

export const TestConnection = Binding.Service<TestConnection>(
  "AWS.DMS.TestConnection",
);
