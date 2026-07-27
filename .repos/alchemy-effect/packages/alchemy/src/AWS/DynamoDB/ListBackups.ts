import type * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Table } from "./Table.ts";

export interface ListBackupsRequest extends Omit<
  DynamoDB.ListBackupsInput,
  "TableName"
> {}

/**
 * Runtime binding for `dynamodb:ListBackups`.
 *
 * Bind this operation to a `Table` inside a function runtime to get a callable
 * that lists the bound table's on-demand backups, automatically injecting the
 * table name. Provide the `ListBackupsHttp` layer on the Function to satisfy
 * the binding.
 * @binding
 * @section Backup and Restore
 * @example List the Bound Table's Backups
 * ```typescript
 * const listBackups = yield* AWS.DynamoDB.ListBackups(table);
 *
 * const response = yield* listBackups();
 * const backups = response.BackupSummaries;
 * ```
 */
export interface ListBackups extends Binding.Service<
  ListBackups,
  "AWS.DynamoDB.ListBackups",
  <T extends Table>(
    table: T,
  ) => Effect.Effect<
    (
      request?: ListBackupsRequest,
    ) => Effect.Effect<DynamoDB.ListBackupsOutput, DynamoDB.ListBackupsError>
  >
> {}
export const ListBackups = Binding.Service<ListBackups>(
  "AWS.DynamoDB.ListBackups",
);
