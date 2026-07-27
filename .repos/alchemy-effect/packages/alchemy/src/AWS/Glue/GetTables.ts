import type * as glue from "@distilled.cloud/aws/glue";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Database } from "./Database.ts";

export interface GetTablesRequest extends Omit<
  glue.GetTablesRequest,
  "DatabaseName" | "CatalogId"
> {}

/**
 * Runtime binding for `glue:GetTables`.
 *
 * Lists the table definitions of the bound {@link Database} (optionally
 * filtered by an `Expression` pattern, paginated via `NextToken`) — runtime
 * schema discovery over the Data Catalog. The database name and catalog id
 * are injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.Glue.GetTablesHttp)`.
 * @binding
 * @section Reading the Data Catalog
 * @example Enumerate a Database's Tables
 * ```typescript
 * // init
 * const getTables = yield* AWS.Glue.GetTables(database);
 *
 * // runtime
 * const { TableList } = yield* getTables({ Expression: "events_*" });
 * const names = (TableList ?? []).map((t) => t.Name);
 * ```
 */
export interface GetTables extends Binding.Service<
  GetTables,
  "AWS.Glue.GetTables",
  (
    database: Database,
  ) => Effect.Effect<
    (
      request?: GetTablesRequest,
    ) => Effect.Effect<glue.GetTablesResponse, glue.GetTablesError>
  >
> {}

export const GetTables = Binding.Service<GetTables>("AWS.Glue.GetTables");
