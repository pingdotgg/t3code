import type * as athena from "@distilled.cloud/aws/athena";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { DataCatalog } from "./DataCatalog.ts";

/**
 * Runtime binding for `athena:GetDatabase`.
 *
 * Reads a single database's metadata from the bound data catalog — the
 * catalog name is injected automatically. Provide the implementation with
 * `Effect.provide(AWS.Athena.GetDatabaseHttp)`.
 * @binding
 * @section Browsing Catalog Metadata
 * @example Read a Database from the Catalog
 * ```typescript
 * // init — bind the operation to the data catalog
 * const getDatabase = yield* AWS.Athena.GetDatabase(catalog);
 *
 * // runtime
 * const res = yield* getDatabase({ DatabaseName: "analytics" });
 * console.log(res.Database?.Name);
 * ```
 */
export interface GetDatabase extends Binding.Service<
  GetDatabase,
  "AWS.Athena.GetDatabase",
  (
    catalog: DataCatalog,
  ) => Effect.Effect<
    (
      request: Omit<athena.GetDatabaseInput, "CatalogName">,
    ) => Effect.Effect<athena.GetDatabaseOutput, athena.GetDatabaseError>
  >
> {}

export const GetDatabase = Binding.Service<GetDatabase>(
  "AWS.Athena.GetDatabase",
);
