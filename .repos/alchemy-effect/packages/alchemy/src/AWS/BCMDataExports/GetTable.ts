import type * as bcm from "@distilled.cloud/aws/bcm-data-exports";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link GetTable}.
 */
export interface GetTableRequest extends bcm.GetTableRequest {}

/**
 * Runtime binding for `bcm-data-exports:GetTable`.
 *
 * An account-level operation (the table dictionary is not tied to any
 * export) that reads the schema of a Data Exports table — its columns,
 * data types, and descriptions for the given table properties. Useful for
 * query builders that validate an SQL statement's columns before calling
 * `UpdateExport`. Provide the implementation with
 * `Effect.provide(AWS.BCMDataExports.GetTableHttp)`.
 * @binding
 * @section Browsing the Table Dictionary
 * @example Read a Table's Schema
 * ```typescript
 * // init — account-level binding takes no resource
 * const getTable = yield* AWS.BCMDataExports.GetTable();
 *
 * // runtime
 * const table = yield* getTable({ TableName: "COST_AND_USAGE_REPORT" });
 * const columns = (table.Schema ?? []).map((column) => column.Name);
 * ```
 */
export interface GetTable extends Binding.Service<
  GetTable,
  "AWS.BCMDataExports.GetTable",
  () => Effect.Effect<
    (
      request: GetTableRequest,
    ) => Effect.Effect<bcm.GetTableResponse, bcm.GetTableError>
  >
> {}

export const GetTable = Binding.Service<GetTable>(
  "AWS.BCMDataExports.GetTable",
);
