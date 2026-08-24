import type * as backup from "@distilled.cloud/aws/backup";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Role } from "../IAM/Role.ts";
import type { BackupVault } from "./BackupVault.ts";

/**
 * `StartCopyJob` request with `SourceBackupVaultName` injected from the
 * bound {@link BackupVault} and `IamRoleArn` defaulting to the bound copy
 * role.
 */
export interface StartCopyJobRequest extends Omit<
  backup.StartCopyJobInput,
  "SourceBackupVaultName" | "IamRoleArn"
> {
  /**
   * IAM role AWS Backup assumes to perform the copy.
   * @default the copy role bound via `StartCopyJob(sourceVault, role)`
   */
  IamRoleArn?: string;
}

/**
 * Runtime binding for the `StartCopyJob` operation (IAM actions
 * `backup:StartCopyJob` + `backup:CopyIntoBackupVault` + `iam:PassRole` on
 * the copy role) — copy a recovery point from the bound source vault to a
 * destination vault (e.g. cross-region or cross-account disaster recovery).
 *
 * The binding is constructed with the **source** {@link BackupVault} and the
 * **copy role** (its trust policy must allow `backup.amazonaws.com`); the
 * destination vault ARN is a runtime request field. Provide the
 * implementation with `Effect.provide(AWS.Backup.StartCopyJobHttp)`.
 * @binding
 * @section Copying Recovery Points
 * @example Copy A Recovery Point To A DR Vault
 * ```typescript
 * const startCopyJob = yield* AWS.Backup.StartCopyJob(vault, backupRole);
 *
 * const job = yield* startCopyJob({
 *   RecoveryPointArn: recoveryPointArn,
 *   DestinationBackupVaultArn: drVaultArn,
 * });
 * yield* Effect.log(`copy job ${job.CopyJobId} started`);
 * ```
 */
export interface StartCopyJob extends Binding.Service<
  StartCopyJob,
  "AWS.Backup.StartCopyJob",
  <R extends Role>(
    sourceVault: BackupVault,
    copyRole: R,
  ) => Effect.Effect<
    (
      request: StartCopyJobRequest,
    ) => Effect.Effect<backup.StartCopyJobOutput, backup.StartCopyJobError>
  >
> {}
export const StartCopyJob = Binding.Service<StartCopyJob>(
  "AWS.Backup.StartCopyJob",
);
