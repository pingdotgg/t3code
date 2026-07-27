import type * as s3tables from "@distilled.cloud/aws/s3tables";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Table } from "./Table.ts";

/**
 * `UpdateTableMetadataLocation` request with `tableBucketARN`, `namespace`,
 * and `name` injected from the bound {@link Table}.
 */
export interface UpdateTableMetadataLocationRequest extends Omit<
  s3tables.UpdateTableMetadataLocationRequest,
  "tableBucketARN" | "namespace" | "name"
> {}

/**
 * Runtime binding for the `UpdateTableMetadataLocation` operation (IAM
 * action `s3tables:UpdateTableMetadataLocation` on the table ARN).
 *
 * Commits a new Iceberg metadata file for the bound {@link Table} — the
 * write half of the Iceberg commit protocol: read the current version with
 * {@link GetTableMetadataLocation}, write a new metadata file into the
 * table's warehouse, then commit it here with the observed `versionToken`.
 * A stale token fails with the typed `ConflictException` (another writer
 * committed first). Provide the implementation with
 * `Effect.provide(AWS.S3Tables.UpdateTableMetadataLocationHttp)`.
 * @binding
 * @section The Iceberg Commit Protocol
 * @example Commit a new metadata file
 * ```typescript
 * const getTableMetadataLocation =
 *   yield* AWS.S3Tables.GetTableMetadataLocation(table);
 * const updateTableMetadataLocation =
 *   yield* AWS.S3Tables.UpdateTableMetadataLocation(table);
 *
 * const { versionToken, warehouseLocation } =
 *   yield* getTableMetadataLocation();
 * // ... write `${warehouseLocation}/metadata/00001-….metadata.json` ...
 * yield* updateTableMetadataLocation({
 *   versionToken,
 *   metadataLocation: `${warehouseLocation}/metadata/00001-….metadata.json`,
 * });
 * ```
 */
export interface UpdateTableMetadataLocation extends Binding.Service<
  UpdateTableMetadataLocation,
  "AWS.S3Tables.UpdateTableMetadataLocation",
  (
    table: Table,
  ) => Effect.Effect<
    (
      request: UpdateTableMetadataLocationRequest,
    ) => Effect.Effect<
      s3tables.UpdateTableMetadataLocationResponse,
      s3tables.UpdateTableMetadataLocationError
    >
  >
> {}
export const UpdateTableMetadataLocation =
  Binding.Service<UpdateTableMetadataLocation>(
    "AWS.S3Tables.UpdateTableMetadataLocation",
  );
