import type * as glue from "@distilled.cloud/aws/glue";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Table } from "./Table.ts";

export interface BatchGetPartitionRequest extends Omit<
  glue.BatchGetPartitionRequest,
  "DatabaseName" | "TableName" | "CatalogId"
> {}

/**
 * Runtime binding for `glue:BatchGetPartition`.
 *
 * Reads up to 1000 partitions of the bound {@link Table} by their partition
 * values in one call — the bulk variant of `GetPartition`. Values that don't
 * resolve come back in `UnprocessedKeys`. The database/table names and
 * catalog id are injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.Glue.BatchGetPartitionHttp)`.
 * @binding
 * @section Managing Partitions
 * @example Bulk-Read Partitions
 * ```typescript
 * // init
 * const batchGetPartition = yield* AWS.Glue.BatchGetPartition(table);
 *
 * // runtime
 * const { Partitions } = yield* batchGetPartition({
 *   PartitionsToGet: [{ Values: ["2026-01-01"] }, { Values: ["2026-01-02"] }],
 * });
 * ```
 */
export interface BatchGetPartition extends Binding.Service<
  BatchGetPartition,
  "AWS.Glue.BatchGetPartition",
  (
    table: Table,
  ) => Effect.Effect<
    (
      request: BatchGetPartitionRequest,
    ) => Effect.Effect<
      glue.BatchGetPartitionResponse,
      glue.BatchGetPartitionError
    >
  >
> {}

export const BatchGetPartition = Binding.Service<BatchGetPartition>(
  "AWS.Glue.BatchGetPartition",
);
