import type * as backup from "@distilled.cloud/aws/backup";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { BackupVault } from "./BackupVault.ts";

/**
 * `GetRecoveryPointRestoreMetadata` request with `BackupVaultName` injected
 * from the bound {@link BackupVault}.
 */
export interface GetRecoveryPointRestoreMetadataRequest extends Omit<
  backup.GetRecoveryPointRestoreMetadataInput,
  "BackupVaultName"
> {}

/**
 * Runtime binding for the `GetRecoveryPointRestoreMetadata` operation (IAM
 * action `backup:GetRecoveryPointRestoreMetadata`).
 *
 * Returns the restore metadata for a recovery point in the bound
 * {@link BackupVault} — the key/value set passed to `StartRestoreJob` as its
 * `Metadata`. Provide the implementation with
 * `Effect.provide(AWS.Backup.GetRecoveryPointRestoreMetadataHttp)`.
 * @binding
 * @section Restoring Recovery Points
 * @example Fetch Restore Metadata Then Restore
 * ```typescript
 * const getRestoreMetadata =
 *   yield* AWS.Backup.GetRecoveryPointRestoreMetadata(vault);
 * const startRestoreJob = yield* AWS.Backup.StartRestoreJob(role);
 *
 * const { RestoreMetadata } = yield* getRestoreMetadata({
 *   RecoveryPointArn: recoveryPointArn,
 * });
 * yield* startRestoreJob({
 *   RecoveryPointArn: recoveryPointArn,
 *   Metadata: RestoreMetadata!,
 * });
 * ```
 */
export interface GetRecoveryPointRestoreMetadata extends Binding.Service<
  GetRecoveryPointRestoreMetadata,
  "AWS.Backup.GetRecoveryPointRestoreMetadata",
  (
    vault: BackupVault,
  ) => Effect.Effect<
    (
      request: GetRecoveryPointRestoreMetadataRequest,
    ) => Effect.Effect<
      backup.GetRecoveryPointRestoreMetadataOutput,
      backup.GetRecoveryPointRestoreMetadataError
    >
  >
> {}
export const GetRecoveryPointRestoreMetadata =
  Binding.Service<GetRecoveryPointRestoreMetadata>(
    "AWS.Backup.GetRecoveryPointRestoreMetadata",
  );
