import type * as glue from "@distilled.cloud/aws/glue";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Table } from "./Table.ts";

export interface BatchUpdatePartitionRequest extends Omit<
  glue.BatchUpdatePartitionRequest,
  "DatabaseName" | "TableName" | "CatalogId"
> {}

/**
 * Runtime binding for `glue:BatchUpdatePartition`.
 *
 * Rewrites up to 100 partitions of the bound {@link Table} in one call — the
 * bulk variant of `UpdatePartition`. Per-partition failures come back in the
 * response's `Errors` list. The database/table names and catalog id are
 * injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.Glue.BatchUpdatePartitionHttp)`.
 * @binding
 * @section Managing Partitions
 * @example Bulk-Update Partition Parameters
 * ```typescript
 * // init
 * const batchUpdatePartition = yield* AWS.Glue.BatchUpdatePartition(table);
 *
 * // runtime
 * const { Errors } = yield* batchUpdatePartition({
 *   Entries: [
 *     {
 *       PartitionValueList: ["2026-01-01"],
 *       PartitionInput: {
 *         Values: ["2026-01-01"],
 *         Parameters: { compacted: "true" },
 *       },
 *     },
 *   ],
 * });
 * ```
 */
export interface BatchUpdatePartition extends Binding.Service<
  BatchUpdatePartition,
  "AWS.Glue.BatchUpdatePartition",
  (
    table: Table,
  ) => Effect.Effect<
    (
      request: BatchUpdatePartitionRequest,
    ) => Effect.Effect<
      glue.BatchUpdatePartitionResponse,
      glue.BatchUpdatePartitionError
    >
  >
> {}

export const BatchUpdatePartition = Binding.Service<BatchUpdatePartition>(
  "AWS.Glue.BatchUpdatePartition",
);
