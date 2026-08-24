import type * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Table } from "./Table.ts";

export interface RestoreTableFromBackupRequest extends Omit<
  DynamoDB.RestoreTableFromBackupInput,
  "TargetTableName"
> {}

/**
 * Runtime binding for `dynamodb:RestoreTableFromBackup`.
 *
 * Bind this operation to a source and a target `Table` inside a function
 * runtime to get a callable that restores one of the source table's on-demand
 * backups (by `BackupArn`) into the target, automatically injecting the
 * target table name. Provide the `RestoreTableFromBackupHttp` layer on the
 * Function to satisfy the binding.
 * @binding
 * @section Backup and Restore
 * @example Restore a Backup into the Target Table
 * ```typescript
 * const restoreTableFromBackup = yield* AWS.DynamoDB.RestoreTableFromBackup(
 *   sourceTable,
 *   restoreTargetTable,
 * );
 *
 * const response = yield* restoreTableFromBackup({ BackupArn: backupArn });
 * const status = response.TableDescription?.TableStatus;
 * ```
 */
export interface RestoreTableFromBackup extends Binding.Service<
  RestoreTableFromBackup,
  "AWS.DynamoDB.RestoreTableFromBackup",
  <From extends Table, To extends Table>(
    from: From,
    to: To,
  ) => Effect.Effect<
    (
      request: RestoreTableFromBackupRequest,
    ) => Effect.Effect<
      DynamoDB.RestoreTableFromBackupOutput,
      DynamoDB.RestoreTableFromBackupError
    >
  >
> {}
export const RestoreTableFromBackup = Binding.Service<RestoreTableFromBackup>(
  "AWS.DynamoDB.RestoreTableFromBackup",
);
