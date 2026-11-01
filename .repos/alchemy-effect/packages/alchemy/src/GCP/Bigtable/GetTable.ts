import type * as bigtable from "@distilled.cloud/gcp/bigtableadmin_v2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Table } from "./Table.ts";

export interface GetTableRequest extends Omit<
  bigtable.GetProjectsInstancesTablesRequest,
  "name"
> {}

/**
 * Runtime binding for Bigtable Admin `tables.get`.
 *
 * Bind this operation to a {@link Table} in a Function/Action init
 * phase. Provide {@link GetTableHttp}.
 *
 * ### Observing Tables
 * **Example:** Read the bound table
 * ```typescript
 * const getTable = yield* GCP.Bigtable.GetTable(users);
 * const live = yield* getTable({ view: "SCHEMA_VIEW" });
 * ```
 *
 * @binding
 * @category Bigtable
 */
export interface GetTable extends Binding.Service<
  GetTable,
  "GCP.Bigtable.GetTable",
  (
    table: Table,
  ) => Effect.Effect<
    (
      request?: GetTableRequest,
    ) => Effect.Effect<
      bigtable.Table,
      bigtable.GetProjectsInstancesTablesError,
      RuntimeContext
    >
  >
> {}

export const GetTable = Binding.Service<GetTable>("GCP.Bigtable.GetTable");
