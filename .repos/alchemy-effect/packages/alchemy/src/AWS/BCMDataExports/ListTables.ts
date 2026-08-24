import type * as bcm from "@distilled.cloud/aws/bcm-data-exports";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Request for {@link ListTables}.
 */
export interface ListTablesRequest extends bcm.ListTablesRequest {}

/**
 * Runtime binding for `bcm-data-exports:ListTables`.
 *
 * An account-level operation (the table dictionary is not tied to any
 * export) that enumerates every table available to Data Exports queries,
 * with each table's configurable properties. Useful for query builders that
 * present the available data sources. Provide the implementation with
 * `Effect.provide(AWS.BCMDataExports.ListTablesHttp)`.
 * @binding
 * @section Browsing the Table Dictionary
 * @example List the Available Tables
 * ```typescript
 * // init — account-level binding takes no resource
 * const listTables = yield* AWS.BCMDataExports.ListTables();
 *
 * // runtime
 * const result = yield* listTables();
 * const names = (result.Tables ?? []).map((table) => table.TableName);
 * ```
 */
export interface ListTables extends Binding.Service<
  ListTables,
  "AWS.BCMDataExports.ListTables",
  () => Effect.Effect<
    (
      request?: ListTablesRequest,
    ) => Effect.Effect<bcm.ListTablesResponse, bcm.ListTablesError>
  >
> {}

export const ListTables = Binding.Service<ListTables>(
  "AWS.BCMDataExports.ListTables",
);
