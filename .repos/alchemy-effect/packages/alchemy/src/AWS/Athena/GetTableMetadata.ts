import type * as athena from "@distilled.cloud/aws/athena";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DataCatalog } from "./DataCatalog.ts";

/**
 * Runtime binding for `athena:GetTableMetadata`.
 *
 * Reads a single table's metadata (columns, partition keys, table type) from
 * the bound data catalog — the catalog name is injected automatically.
 * Provide the implementation with
 * `Effect.provide(AWS.Athena.GetTableMetadataHttp)`.
 * @binding
 * @section Browsing Catalog Metadata
 * @example Read a Table's Columns
 * ```typescript
 * // init — bind the operation to the data catalog
 * const getTableMetadata = yield* AWS.Athena.GetTableMetadata(catalog);
 *
 * // runtime
 * const res = yield* getTableMetadata({
 *   DatabaseName: "analytics",
 *   TableName: "orders",
 * });
 * console.log(res.TableMetadata?.Columns?.map((c) => c.Name));
 * ```
 */
export interface GetTableMetadata extends Binding.Service<
  GetTableMetadata,
  "AWS.Athena.GetTableMetadata",
  (
    catalog: DataCatalog,
  ) => Effect.Effect<
    (
      request: Omit<athena.GetTableMetadataInput, "CatalogName">,
    ) => Effect.Effect<
      athena.GetTableMetadataOutput,
      athena.GetTableMetadataError
    >
  >
> {}

export const GetTableMetadata = Binding.Service<GetTableMetadata>(
  "AWS.Athena.GetTableMetadata",
);
