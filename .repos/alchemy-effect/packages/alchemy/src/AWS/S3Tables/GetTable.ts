import type * as s3tables from "@distilled.cloud/aws/s3tables";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Table } from "./Table.ts";

/**
 * Runtime binding for the `GetTable` operation (IAM action
 * `s3tables:GetTable` on the table ARN).
 *
 * Reads the bound {@link Table}'s details — its current `versionToken`,
 * `metadataLocation`, `warehouseLocation`, and format. The version token and
 * metadata location are the inputs to the Iceberg commit protocol (see
 * {@link UpdateTableMetadataLocation}). Provide the implementation with
 * `Effect.provide(AWS.S3Tables.GetTableHttp)`.
 * @binding
 * @section Reading Table Metadata
 * @example Read the table's current version
 * ```typescript
 * const getTable = yield* AWS.S3Tables.GetTable(table);
 *
 * const { versionToken, metadataLocation, warehouseLocation } =
 *   yield* getTable();
 * ```
 */
export interface GetTable extends Binding.Service<
  GetTable,
  "AWS.S3Tables.GetTable",
  (
    table: Table,
  ) => Effect.Effect<
    () => Effect.Effect<s3tables.GetTableResponse, s3tables.GetTableError>
  >
> {}
export const GetTable = Binding.Service<GetTable>("AWS.S3Tables.GetTable");
