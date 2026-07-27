import type * as glue from "@distilled.cloud/aws/glue";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Table } from "./Table.ts";

export interface GetPartitionRequest extends Omit<
  glue.GetPartitionRequest,
  "DatabaseName" | "TableName" | "CatalogId"
> {}

/**
 * Runtime binding for `glue:GetPartition`.
 *
 * Reads a single partition of the bound {@link Table} by its partition
 * values. Fails with the typed `EntityNotFoundException` when the partition
 * does not exist. The database/table names and catalog id are injected from
 * the binding. Provide the implementation with
 * `Effect.provide(AWS.Glue.GetPartitionHttp)`.
 * @binding
 * @section Managing Partitions
 * @example Read One Partition
 * ```typescript
 * // init
 * const getPartition = yield* AWS.Glue.GetPartition(table);
 *
 * // runtime
 * const { Partition } = yield* getPartition({
 *   PartitionValues: ["2026-01-01"],
 * });
 * ```
 */
export interface GetPartition extends Binding.Service<
  GetPartition,
  "AWS.Glue.GetPartition",
  (
    table: Table,
  ) => Effect.Effect<
    (
      request: GetPartitionRequest,
    ) => Effect.Effect<glue.GetPartitionResponse, glue.GetPartitionError>
  >
> {}

export const GetPartition = Binding.Service<GetPartition>(
  "AWS.Glue.GetPartition",
);
