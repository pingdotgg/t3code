import type * as dms from "@distilled.cloud/aws/database-migration-service";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Endpoint } from "./Endpoint.ts";
import type { ReplicationInstance } from "./ReplicationInstance.ts";

/**
 * Runtime binding for `dms:RefreshSchemas`.
 *
 * Bind this operation to a ({@link ReplicationInstance}, {@link Endpoint})
 * pair to (re)discover the schemas at the endpoint's database using the
 * instance's compute. The refresh runs asynchronously — poll it with
 * {@link DescribeRefreshSchemasStatus}, then list the result with
 * {@link DescribeSchemas}. Provide the implementation with
 * `Effect.provide(AWS.DMS.RefreshSchemasHttp)`.
 * @binding
 * @section Refreshing Schemas
 * @example Kick Off a Schema Refresh
 * ```typescript
 * // init — bind the operation to the instance + endpoint
 * const refreshSchemas = yield* AWS.DMS.RefreshSchemas(instance, source);
 *
 * // runtime
 * const { RefreshSchemasStatus } = yield* refreshSchemas();
 * ```
 */
export interface RefreshSchemas extends Binding.Service<
  RefreshSchemas,
  "AWS.DMS.RefreshSchemas",
  (
    instance: ReplicationInstance,
    endpoint: Endpoint,
  ) => Effect.Effect<
    () => Effect.Effect<dms.RefreshSchemasResponse, dms.RefreshSchemasError>
  >
> {}

export const RefreshSchemas = Binding.Service<RefreshSchemas>(
  "AWS.DMS.RefreshSchemas",
);
