import type * as athena from "@distilled.cloud/aws/athena";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DataCatalog } from "./DataCatalog.ts";

/**
 * Runtime binding for `athena:ListDatabases`.
 *
 * Lists the databases in the bound data catalog — the catalog name is
 * injected automatically. Provide the implementation with
 * `Effect.provide(AWS.Athena.ListDatabasesHttp)`.
 * @binding
 * @section Browsing Catalog Metadata
 * @example List Databases in the Catalog
 * ```typescript
 * // init — bind the operation to the data catalog
 * const listDatabases = yield* AWS.Athena.ListDatabases(catalog);
 *
 * // runtime
 * const res = yield* listDatabases({});
 * console.log(res.DatabaseList?.map((db) => db.Name));
 * ```
 */
export interface ListDatabases extends Binding.Service<
  ListDatabases,
  "AWS.Athena.ListDatabases",
  (
    catalog: DataCatalog,
  ) => Effect.Effect<
    (
      request: Omit<athena.ListDatabasesInput, "CatalogName">,
    ) => Effect.Effect<athena.ListDatabasesOutput, athena.ListDatabasesError>
  >
> {}

export const ListDatabases = Binding.Service<ListDatabases>(
  "AWS.Athena.ListDatabases",
);
