import type * as glue from "@distilled.cloud/aws/glue";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Table } from "./Table.ts";

export interface UpdatePartitionRequest extends Omit<
  glue.UpdatePartitionRequest,
  "DatabaseName" | "TableName" | "CatalogId"
> {}

/**
 * Runtime binding for `glue:UpdatePartition`.
 *
 * Replaces the definition of one partition of the bound {@link Table} —
 * `PartitionValueList` addresses the existing partition and
 * `PartitionInput` is its new definition (location, parameters, schema).
 * The database/table names and catalog id are injected from the binding.
 * Provide the implementation with
 * `Effect.provide(AWS.Glue.UpdatePartitionHttp)`.
 * @binding
 * @section Managing Partitions
 * @example Move a Partition's Location
 * ```typescript
 * // init
 * const updatePartition = yield* AWS.Glue.UpdatePartition(table);
 *
 * // runtime
 * yield* updatePartition({
 *   PartitionValueList: ["2026-01-01"],
 *   PartitionInput: {
 *     Values: ["2026-01-01"],
 *     StorageDescriptor: { Location: "s3://my-data-lake/v2/dt=2026-01-01/" },
 *   },
 * });
 * ```
 */
export interface UpdatePartition extends Binding.Service<
  UpdatePartition,
  "AWS.Glue.UpdatePartition",
  (
    table: Table,
  ) => Effect.Effect<
    (
      request: UpdatePartitionRequest,
    ) => Effect.Effect<glue.UpdatePartitionResponse, glue.UpdatePartitionError>
  >
> {}

export const UpdatePartition = Binding.Service<UpdatePartition>(
  "AWS.Glue.UpdatePartition",
);
