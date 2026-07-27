import type * as dms from "@distilled.cloud/aws/database-migration-service";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `dms:DescribeOrderableReplicationInstances`.
 *
 * Bind this operation (account-level) to enumerate the replication instance
 * classes and storage ranges orderable in the region — e.g. for tooling that
 * right-sizes migration infrastructure. Provide the implementation with
 * `Effect.provide(AWS.DMS.DescribeOrderableReplicationInstancesHttp)`.
 * @binding
 * @section Sizing Replication Instances
 * @example List Orderable Instance Classes
 * ```typescript
 * // init — account-level, no target resource
 * const orderable = yield* AWS.DMS.DescribeOrderableReplicationInstances();
 *
 * // runtime
 * const { OrderableReplicationInstances } = yield* orderable();
 * ```
 */
export interface DescribeOrderableReplicationInstances extends Binding.Service<
  DescribeOrderableReplicationInstances,
  "AWS.DMS.DescribeOrderableReplicationInstances",
  () => Effect.Effect<
    (
      request?: dms.DescribeOrderableReplicationInstancesMessage,
    ) => Effect.Effect<
      dms.DescribeOrderableReplicationInstancesResponse,
      dms.DescribeOrderableReplicationInstancesError
    >
  >
> {}

export const DescribeOrderableReplicationInstances =
  Binding.Service<DescribeOrderableReplicationInstances>(
    "AWS.DMS.DescribeOrderableReplicationInstances",
  );
