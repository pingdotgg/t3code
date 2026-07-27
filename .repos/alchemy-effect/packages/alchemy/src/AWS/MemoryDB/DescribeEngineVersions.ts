import type * as memorydb from "@distilled.cloud/aws/memorydb";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `DescribeEngineVersions` operation (IAM action
 * `memorydb:DescribeEngineVersions`).
 *
 * Lists the engine versions MemoryDB supports (redis/valkey) and their
 * parameter group families — e.g. upgrade automation that checks whether a
 * newer engine version is available before scheduling a cluster update.
 * Provide the implementation with
 * `Effect.provide(AWS.MemoryDB.DescribeEngineVersionsHttp)`.
 * @binding
 * @section Applying Service Updates
 * @example List Supported Valkey Versions
 * ```typescript
 * const describeEngineVersions = yield* MemoryDB.DescribeEngineVersions();
 *
 * const page = yield* describeEngineVersions({ Engine: "valkey" });
 * // page.EngineVersions[0].EngineVersion
 * ```
 */
export interface DescribeEngineVersions extends Binding.Service<
  DescribeEngineVersions,
  "AWS.MemoryDB.DescribeEngineVersions",
  () => Effect.Effect<
    (
      request?: memorydb.DescribeEngineVersionsRequest,
    ) => Effect.Effect<
      memorydb.DescribeEngineVersionsResponse,
      memorydb.DescribeEngineVersionsError
    >
  >
> {}
export const DescribeEngineVersions = Binding.Service<DescribeEngineVersions>(
  "AWS.MemoryDB.DescribeEngineVersions",
);
