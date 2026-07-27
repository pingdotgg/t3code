import type * as glue from "@distilled.cloud/aws/glue";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Table } from "./Table.ts";

export interface GetTableRequest extends Omit<
  glue.GetTableRequest,
  "DatabaseName" | "Name" | "CatalogId"
> {}

/**
 * Runtime binding for `glue:GetTable`.
 *
 * Reads the bound {@link Table}'s full catalog definition — columns, storage
 * descriptor, partition keys, and parameters — so a function can introspect
 * the schema it is writing against. The database/table names and catalog id
 * are injected from the binding. Provide the implementation with
 * `Effect.provide(AWS.Glue.GetTableHttp)`.
 * @binding
 * @section Reading the Data Catalog
 * @example Introspect the Table Schema
 * ```typescript
 * // init
 * const getTable = yield* AWS.Glue.GetTable(table);
 *
 * // runtime
 * const { Table } = yield* getTable();
 * const columns = Table?.StorageDescriptor?.Columns ?? [];
 * ```
 */
export interface GetTable extends Binding.Service<
  GetTable,
  "AWS.Glue.GetTable",
  (
    table: Table,
  ) => Effect.Effect<
    (
      request?: GetTableRequest,
    ) => Effect.Effect<glue.GetTableResponse, glue.GetTableError>
  >
> {}

export const GetTable = Binding.Service<GetTable>("AWS.Glue.GetTable");
