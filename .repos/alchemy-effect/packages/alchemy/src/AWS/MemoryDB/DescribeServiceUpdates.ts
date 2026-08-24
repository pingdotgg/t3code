import type * as memorydb from "@distilled.cloud/aws/memorydb";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `DescribeServiceUpdates` operation (IAM action
 * `memorydb:DescribeServiceUpdates`).
 *
 * Lists the service updates (security patches, engine upgrades) available or
 * scheduled for the account's clusters — pair with
 * {@link BatchUpdateCluster} to build patch automation. Provide the
 * implementation with
 * `Effect.provide(AWS.MemoryDB.DescribeServiceUpdatesHttp)`.
 * @binding
 * @section Applying Service Updates
 * @example List Available Service Updates
 * ```typescript
 * const describeServiceUpdates = yield* MemoryDB.DescribeServiceUpdates();
 *
 * const page = yield* describeServiceUpdates({ Status: ["available"] });
 * // page.ServiceUpdates[0].ServiceUpdateName
 * ```
 */
export interface DescribeServiceUpdates extends Binding.Service<
  DescribeServiceUpdates,
  "AWS.MemoryDB.DescribeServiceUpdates",
  () => Effect.Effect<
    (
      request?: memorydb.DescribeServiceUpdatesRequest,
    ) => Effect.Effect<
      memorydb.DescribeServiceUpdatesResponse,
      memorydb.DescribeServiceUpdatesError
    >
  >
> {}
export const DescribeServiceUpdates = Binding.Service<DescribeServiceUpdates>(
  "AWS.MemoryDB.DescribeServiceUpdates",
);
