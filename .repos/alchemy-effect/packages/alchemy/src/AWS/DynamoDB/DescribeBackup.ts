import type * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Table } from "./Table.ts";

export interface DescribeBackupRequest extends DynamoDB.DescribeBackupInput {}

/**
 * Runtime binding for `dynamodb:DescribeBackup`.
 *
 * Bind this operation to a `Table` inside a function runtime to get a callable
 * that reads the status and details of one of the bound table's backups by
 * ARN. The IAM grant covers every backup of the bound table
 * (`{tableArn}/backup/*`). Provide the `DescribeBackupHttp` layer on the
 * Function to satisfy the binding.
 * @binding
 * @section Backup and Restore
 * @example Poll a Backup Until It Is Available
 * ```typescript
 * const describeBackup = yield* AWS.DynamoDB.DescribeBackup(table);
 *
 * const response = yield* describeBackup({ BackupArn: backupArn });
 * const status = response.BackupDescription?.BackupDetails?.BackupStatus;
 * ```
 */
export interface DescribeBackup extends Binding.Service<
  DescribeBackup,
  "AWS.DynamoDB.DescribeBackup",
  <T extends Table>(
    table: T,
  ) => Effect.Effect<
    (
      request: DescribeBackupRequest,
    ) => Effect.Effect<
      DynamoDB.DescribeBackupOutput,
      DynamoDB.DescribeBackupError
    >
  >
> {}
export const DescribeBackup = Binding.Service<DescribeBackup>(
  "AWS.DynamoDB.DescribeBackup",
);
