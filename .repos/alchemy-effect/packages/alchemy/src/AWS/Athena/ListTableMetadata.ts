import type * as athena from "@distilled.cloud/aws/athena";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DataCatalog } from "./DataCatalog.ts";

/**
 * Runtime binding for `athena:ListTableMetadata`.
 *
 * Lists table metadata for a database in the bound data catalog — the
 * catalog name is injected automatically; `Expression` filters table names.
 * Provide the implementation with
 * `Effect.provide(AWS.Athena.ListTableMetadataHttp)`.
 * @binding
 * @section Browsing Catalog Metadata
 * @example List a Database's Tables
 * ```typescript
 * // init — bind the operation to the data catalog
 * const listTableMetadata = yield* AWS.Athena.ListTableMetadata(catalog);
 *
 * // runtime
 * const res = yield* listTableMetadata({ DatabaseName: "analytics" });
 * console.log(res.TableMetadataList?.map((t) => t.Name));
 * ```
 */
export interface ListTableMetadata extends Binding.Service<
  ListTableMetadata,
  "AWS.Athena.ListTableMetadata",
  (
    catalog: DataCatalog,
  ) => Effect.Effect<
    (
      request: Omit<athena.ListTableMetadataInput, "CatalogName">,
    ) => Effect.Effect<
      athena.ListTableMetadataOutput,
      athena.ListTableMetadataError
    >
  >
> {}

export const ListTableMetadata = Binding.Service<ListTableMetadata>(
  "AWS.Athena.ListTableMetadata",
);
