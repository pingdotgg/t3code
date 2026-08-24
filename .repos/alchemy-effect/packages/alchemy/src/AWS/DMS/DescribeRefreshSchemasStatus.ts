import type * as dms from "@distilled.cloud/aws/database-migration-service";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Endpoint } from "./Endpoint.ts";

/**
 * Runtime binding for `dms:DescribeRefreshSchemasStatus`.
 *
 * Bind this operation to an {@link Endpoint} to poll the status of the last
 * `RefreshSchemas` run against it (`refreshing`, `successful`, `failed`).
 * Provide the implementation with
 * `Effect.provide(AWS.DMS.DescribeRefreshSchemasStatusHttp)`.
 * @binding
 * @section Polling a Schema Refresh
 * @example Wait for a Refresh to Complete
 * ```typescript
 * // init — bind the operation to the endpoint
 * const refreshStatus = yield* AWS.DMS.DescribeRefreshSchemasStatus(source);
 *
 * // runtime
 * const { RefreshSchemasStatus } = yield* refreshStatus();
 * if (RefreshSchemasStatus?.Status === "successful") {
 *   // schemas are ready to describe
 * }
 * ```
 */
export interface DescribeRefreshSchemasStatus extends Binding.Service<
  DescribeRefreshSchemasStatus,
  "AWS.DMS.DescribeRefreshSchemasStatus",
  (
    endpoint: Endpoint,
  ) => Effect.Effect<
    () => Effect.Effect<
      dms.DescribeRefreshSchemasStatusResponse,
      dms.DescribeRefreshSchemasStatusError
    >
  >
> {}

export const DescribeRefreshSchemasStatus =
  Binding.Service<DescribeRefreshSchemasStatus>(
    "AWS.DMS.DescribeRefreshSchemasStatus",
  );
