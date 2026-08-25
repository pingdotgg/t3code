import type * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Table } from "./Table.ts";

export interface DeleteBackupRequest extends DynamoDB.DeleteBackupInput {}

/**
 * Runtime binding for `dynamodb:DeleteBackup`.
 *
 * Bind this operation to a `Table` inside a function runtime to get a callable
 * that deletes one of the bound table's on-demand backups by ARN. The IAM
 * grant covers every backup of the bound table (`{tableArn}/backup/*`).
 * Provide the `DeleteBackupHttp` layer on the Function to satisfy the binding.
 * @binding
 * @section Backup and Restore
 * @example Delete an Expired Backup
 * ```typescript
 * const deleteBackup = yield* AWS.DynamoDB.DeleteBackup(table);
 *
 * const response = yield* deleteBackup({ BackupArn: backupArn });
 * const status = response.BackupDescription?.BackupDetails?.BackupStatus;
 * ```
 */
export interface DeleteBackup extends Binding.Service<
  DeleteBackup,
  "AWS.DynamoDB.DeleteBackup",
  <T extends Table>(
    table: T,
  ) => Effect.Effect<
    (
      request: DeleteBackupRequest,
    ) => Effect.Effect<DynamoDB.DeleteBackupOutput, DynamoDB.DeleteBackupError>
  >
> {}
export const DeleteBackup = Binding.Service<DeleteBackup>(
  "AWS.DynamoDB.DeleteBackup",
);
