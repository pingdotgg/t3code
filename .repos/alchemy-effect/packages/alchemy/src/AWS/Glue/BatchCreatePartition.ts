import type * as glue from "@distilled.cloud/aws/glue";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Table } from "./Table.ts";

export interface BatchCreatePartitionRequest extends Omit<
  glue.BatchCreatePartitionRequest,
  "DatabaseName" | "TableName" | "CatalogId"
> {}

/**
 * Runtime binding for `glue:BatchCreatePartition`.
 *
 * Registers up to 100 partitions on the bound {@link Table} in one call —
 * the bulk variant of `CreatePartition` for backfills. Per-partition
 * failures come back in the response's `Errors` list. The database/table
 * names and catalog id are injected from the binding. Provide the
 * implementation with `Effect.provide(AWS.Glue.BatchCreatePartitionHttp)`.
 * @binding
 * @section Managing Partitions
 * @example Backfill Partitions
 * ```typescript
 * // init
 * const batchCreatePartition = yield* AWS.Glue.BatchCreatePartition(table);
 *
 * // runtime
 * const { Errors } = yield* batchCreatePartition({
 *   PartitionInputList: days.map((dt) => ({ Values: [dt] })),
 * });
 * ```
 */
export interface BatchCreatePartition extends Binding.Service<
  BatchCreatePartition,
  "AWS.Glue.BatchCreatePartition",
  (
    table: Table,
  ) => Effect.Effect<
    (
      request: BatchCreatePartitionRequest,
    ) => Effect.Effect<
      glue.BatchCreatePartitionResponse,
      glue.BatchCreatePartitionError
    >
  >
> {}

export const BatchCreatePartition = Binding.Service<BatchCreatePartition>(
  "AWS.Glue.BatchCreatePartition",
);
