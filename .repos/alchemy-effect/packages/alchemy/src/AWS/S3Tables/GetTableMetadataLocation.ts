import type * as s3tables from "@distilled.cloud/aws/s3tables";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Table } from "./Table.ts";

/**
 * Runtime binding for the `GetTableMetadataLocation` operation (IAM action
 * `s3tables:GetTableMetadataLocation` on the table ARN).
 *
 * Reads the bound {@link Table}'s current metadata location and version
 * token — the read half of the Iceberg commit protocol: read the current
 * metadata, write a new metadata file to the warehouse, then commit it with
 * {@link UpdateTableMetadataLocation}. Provide the implementation with
 * `Effect.provide(AWS.S3Tables.GetTableMetadataLocationHttp)`.
 * @binding
 * @section The Iceberg Commit Protocol
 * @example Read the current metadata location
 * ```typescript
 * const getTableMetadataLocation =
 *   yield* AWS.S3Tables.GetTableMetadataLocation(table);
 *
 * const { versionToken, metadataLocation, warehouseLocation } =
 *   yield* getTableMetadataLocation();
 * ```
 */
export interface GetTableMetadataLocation extends Binding.Service<
  GetTableMetadataLocation,
  "AWS.S3Tables.GetTableMetadataLocation",
  (
    table: Table,
  ) => Effect.Effect<
    () => Effect.Effect<
      s3tables.GetTableMetadataLocationResponse,
      s3tables.GetTableMetadataLocationError
    >
  >
> {}
export const GetTableMetadataLocation =
  Binding.Service<GetTableMetadataLocation>(
    "AWS.S3Tables.GetTableMetadataLocation",
  );
