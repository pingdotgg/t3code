import type * as glue from "@distilled.cloud/aws/glue";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Table } from "./Table.ts";

export interface BatchDeletePartitionRequest extends Omit<
  glue.BatchDeletePartitionRequest,
  "DatabaseName" | "TableName" | "CatalogId"
> {}

/**
 * Runtime binding for `glue:BatchDeletePartition`.
 *
 * Deletes up to 25 partitions of the bound {@link Table} in one call — the
 * bulk variant of `DeletePartition` for retention sweeps. Per-partition
 * failures come back in the response's `Errors` list. The database/table
 * names and catalog id are injected from the binding. Provide the
 * implementation with `Effect.provide(AWS.Glue.BatchDeletePartitionHttp)`.
 * @binding
 * @section Managing Partitions
 * @example Expire Old Partitions
 * ```typescript
 * // init
 * const batchDeletePartition = yield* AWS.Glue.BatchDeletePartition(table);
 *
 * // runtime
 * const { Errors } = yield* batchDeletePartition({
 *   PartitionsToDelete: expired.map((dt) => ({ Values: [dt] })),
 * });
 * ```
 */
export interface BatchDeletePartition extends Binding.Service<
  BatchDeletePartition,
  "AWS.Glue.BatchDeletePartition",
  (
    table: Table,
  ) => Effect.Effect<
    (
      request: BatchDeletePartitionRequest,
    ) => Effect.Effect<
      glue.BatchDeletePartitionResponse,
      glue.BatchDeletePartitionError
    >
  >
> {}

export const BatchDeletePartition = Binding.Service<BatchDeletePartition>(
  "AWS.Glue.BatchDeletePartition",
);
