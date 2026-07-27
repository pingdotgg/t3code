import type * as glue from "@distilled.cloud/aws/glue";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Table } from "./Table.ts";

export interface DeletePartitionRequest extends Omit<
  glue.DeletePartitionRequest,
  "DatabaseName" | "TableName" | "CatalogId"
> {}

/**
 * Runtime binding for `glue:DeletePartition`.
 *
 * Deregisters one partition of the bound {@link Table} by its partition
 * values (the underlying data is untouched). Fails with the typed
 * `EntityNotFoundException` when the partition is already gone. The
 * database/table names and catalog id are injected from the binding.
 * Provide the implementation with
 * `Effect.provide(AWS.Glue.DeletePartitionHttp)`.
 * @binding
 * @section Managing Partitions
 * @example Deregister a Partition
 * ```typescript
 * // init
 * const deletePartition = yield* AWS.Glue.DeletePartition(table);
 *
 * // runtime — idempotent removal
 * yield* deletePartition({ PartitionValues: ["2026-01-01"] }).pipe(
 *   Effect.catchTag("EntityNotFoundException", () => Effect.void),
 * );
 * ```
 */
export interface DeletePartition extends Binding.Service<
  DeletePartition,
  "AWS.Glue.DeletePartition",
  (
    table: Table,
  ) => Effect.Effect<
    (
      request: DeletePartitionRequest,
    ) => Effect.Effect<glue.DeletePartitionResponse, glue.DeletePartitionError>
  >
> {}

export const DeletePartition = Binding.Service<DeletePartition>(
  "AWS.Glue.DeletePartition",
);
