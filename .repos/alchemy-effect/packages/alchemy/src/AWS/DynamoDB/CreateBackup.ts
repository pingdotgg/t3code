import type * as DynamoDB from "@distilled.cloud/aws/dynamodb";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Table } from "./Table.ts";

export interface CreateBackupRequest extends Omit<
  DynamoDB.CreateBackupInput,
  "TableName"
> {}

/**
 * Runtime binding for `dynamodb:CreateBackup`.
 *
 * Bind this operation to a `Table` inside a function runtime to get a callable
 * that creates an on-demand backup of the bound table, automatically injecting
 * the table name. Provide the `CreateBackupHttp` layer on the Function to
 * satisfy the binding.
 * @binding
 * @section Backup and Restore
 * @example Create an On-Demand Backup
 * ```typescript
 * const createBackup = yield* AWS.DynamoDB.CreateBackup(table);
 *
 * const response = yield* createBackup({ BackupName: "nightly" });
 * const backupArn = response.BackupDetails?.BackupArn;
 * ```
 */
export interface CreateBackup extends Binding.Service<
  CreateBackup,
  "AWS.DynamoDB.CreateBackup",
  <T extends Table>(
    table: T,
  ) => Effect.Effect<
    (
      request: CreateBackupRequest,
    ) => Effect.Effect<DynamoDB.CreateBackupOutput, DynamoDB.CreateBackupError>
  >
> {}
export const CreateBackup = Binding.Service<CreateBackup>(
  "AWS.DynamoDB.CreateBackup",
);
