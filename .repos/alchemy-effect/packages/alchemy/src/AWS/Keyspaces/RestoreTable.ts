import type * as keyspaces from "@distilled.cloud/aws/keyspaces";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Keyspace } from "./Keyspace.ts";
import type { Table } from "./Table.ts";

export interface RestoreTableRequest extends Omit<
  keyspaces.RestoreTableRequest,
  "sourceKeyspaceName" | "sourceTableName" | "targetKeyspaceName"
> {}

/**
 * Runtime binding for `cassandra:Restore` (the Keyspaces `RestoreTable`
 * operation).
 *
 * Bind this operation to a source `Table` (which must have point-in-time
 * recovery enabled) and a target `Keyspace` to get a callable that restores
 * the source table's continuous backup into a new table of the target
 * keyspace, automatically injecting the source keyspace/table and target
 * keyspace names. `RestoreTable` is asynchronous — the response returns the
 * new table's ARN while it provisions in the `RESTORING` state. Provide the
 * `RestoreTableHttp` layer on the Function to satisfy the binding.
 * @binding
 * @section Backup and Restore
 * @example Restore to the Current Time
 * ```typescript
 * const restore = yield* AWS.Keyspaces.RestoreTable(sourceTable, keyspace);
 *
 * const { restoredTableARN } = yield* restore({
 *   targetTableName: "orders_restored",
 * });
 * ```
 *
 * @example Restore to a Point in Time
 * ```typescript
 * const { restoredTableARN } = yield* restore({
 *   targetTableName: "orders_before_incident",
 *   restoreTimestamp: new Date("2026-07-14T12:00:00Z"),
 * });
 * ```
 */
export interface RestoreTable extends Binding.Service<
  RestoreTable,
  "AWS.Keyspaces.RestoreTable",
  <From extends Table, To extends Keyspace>(
    source: From,
    targetKeyspace: To,
  ) => Effect.Effect<
    (
      request: RestoreTableRequest,
    ) => Effect.Effect<
      keyspaces.RestoreTableResponse,
      keyspaces.RestoreTableError
    >
  >
> {}

export const RestoreTable = Binding.Service<RestoreTable>(
  "AWS.Keyspaces.RestoreTable",
);
