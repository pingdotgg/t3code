import type * as backup from "@distilled.cloud/aws/backup";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Role } from "../IAM/Role.ts";
import type { BackupVault } from "./BackupVault.ts";

/**
 * `StartBackupJob` request with `BackupVaultName` injected from the bound
 * {@link BackupVault} and `IamRoleArn` defaulting to the bound backup role.
 */
export interface StartBackupJobRequest extends Omit<
  backup.StartBackupJobInput,
  "BackupVaultName" | "IamRoleArn"
> {
  /**
   * IAM role AWS Backup assumes to create the backup.
   * @default the backup role bound via `StartBackupJob(vault, role)`
   */
  IamRoleArn?: string;
}

/**
 * Runtime binding for the `StartBackupJob` operation (IAM actions
 * `backup:StartBackupJob` on the vault ARN + `iam:PassRole` on the backup
 * role) — take an on-demand backup of any supported resource from a deployed
 * Function.
 *
 * The binding is constructed with the target {@link BackupVault} and the
 * **backup role** (the IAM role AWS Backup assumes to read the resource and
 * write the recovery point; its trust policy must allow
 * `backup.amazonaws.com`). Both are injected into every runtime request.
 * Provide the implementation with
 * `Effect.provide(AWS.Backup.StartBackupJobHttp)`.
 * @binding
 * @section Starting Backups
 * @example On-Demand Backup Of A DynamoDB Table
 * ```typescript
 * // deploy time — bind the vault and the backup role
 * const startBackupJob = yield* AWS.Backup.StartBackupJob(vault, backupRole);
 *
 * // runtime — snapshot the table before a risky migration
 * const tableArn = yield* table.tableArn;
 * const job = yield* startBackupJob({
 *   ResourceArn: tableArn,
 *   Lifecycle: { DeleteAfterDays: 7 },
 * });
 * yield* Effect.log(`backup job ${job.BackupJobId} started`);
 * ```
 */
export interface StartBackupJob extends Binding.Service<
  StartBackupJob,
  "AWS.Backup.StartBackupJob",
  <R extends Role>(
    vault: BackupVault,
    backupRole: R,
  ) => Effect.Effect<
    (
      request: StartBackupJobRequest,
    ) => Effect.Effect<backup.StartBackupJobOutput, backup.StartBackupJobError>
  >
> {}
export const StartBackupJob = Binding.Service<StartBackupJob>(
  "AWS.Backup.StartBackupJob",
);
