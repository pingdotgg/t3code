import type * as glue from "@distilled.cloud/aws/glue";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Table } from "./Table.ts";

export interface CreatePartitionRequest extends Omit<
  glue.CreatePartitionRequest,
  "DatabaseName" | "TableName" | "CatalogId"
> {}

/**
 * Runtime binding for `glue:CreatePartition`.
 *
 * Registers a new partition on the bound {@link Table} — the write half of
 * the classic "data landed in S3, register the partition so Athena sees it"
 * pipeline. Fails with the typed `AlreadyExistsException` if the partition
 * is already registered. The database/table names and catalog id are
 * injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.Glue.CreatePartitionHttp)`.
 * @binding
 * @section Managing Partitions
 * @example Register a New Partition
 * ```typescript
 * // init
 * const createPartition = yield* AWS.Glue.CreatePartition(table);
 *
 * // runtime — idempotent registration
 * yield* createPartition({
 *   PartitionInput: {
 *     Values: ["2026-01-01"],
 *     StorageDescriptor: { Location: "s3://my-data-lake/events/dt=2026-01-01/" },
 *   },
 * }).pipe(Effect.catchTag("AlreadyExistsException", () => Effect.void));
 * ```
 */
export interface CreatePartition extends Binding.Service<
  CreatePartition,
  "AWS.Glue.CreatePartition",
  (
    table: Table,
  ) => Effect.Effect<
    (
      request: CreatePartitionRequest,
    ) => Effect.Effect<glue.CreatePartitionResponse, glue.CreatePartitionError>
  >
> {}

export const CreatePartition = Binding.Service<CreatePartition>(
  "AWS.Glue.CreatePartition",
);
