import type * as dms from "@distilled.cloud/aws/database-migration-service";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Endpoint } from "./Endpoint.ts";

/**
 * Runtime binding for `dms:DescribeSchemas`.
 *
 * Bind this operation to an {@link Endpoint} to list the schemas DMS
 * discovered at the endpoint's database (populated by a prior
 * `RefreshSchemas` run against a replication instance). Provide the
 * implementation with `Effect.provide(AWS.DMS.DescribeSchemasHttp)`.
 * @binding
 * @section Listing Discovered Schemas
 * @example List Schemas at a Source Endpoint
 * ```typescript
 * // init — bind the operation to the endpoint
 * const describeSchemas = yield* AWS.DMS.DescribeSchemas(source);
 *
 * // runtime
 * const { Schemas } = yield* describeSchemas();
 * ```
 */
export interface DescribeSchemas extends Binding.Service<
  DescribeSchemas,
  "AWS.DMS.DescribeSchemas",
  (
    endpoint: Endpoint,
  ) => Effect.Effect<
    (
      request?: Omit<dms.DescribeSchemasMessage, "EndpointArn">,
    ) => Effect.Effect<dms.DescribeSchemasResponse, dms.DescribeSchemasError>
  >
> {}

export const DescribeSchemas = Binding.Service<DescribeSchemas>(
  "AWS.DMS.DescribeSchemas",
);
