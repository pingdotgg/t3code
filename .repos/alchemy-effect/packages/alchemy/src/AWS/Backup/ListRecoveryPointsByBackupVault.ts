import type * as backup from "@distilled.cloud/aws/backup";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { BackupVault } from "./BackupVault.ts";

/**
 * `ListRecoveryPointsByBackupVault` request with `BackupVaultName` injected
 * from the bound {@link BackupVault}.
 */
export interface ListRecoveryPointsByBackupVaultRequest extends Omit<
  backup.ListRecoveryPointsByBackupVaultInput,
  "BackupVaultName"
> {}

/**
 * Runtime binding for the `ListRecoveryPointsByBackupVault` operation (IAM
 * action `backup:ListRecoveryPointsByBackupVault`, scoped to the vault ARN).
 *
 * Lists the recovery points stored in the bound {@link BackupVault}, with
 * optional filters (resource ARN, resource type, plan, time window). Provide
 * the implementation with
 * `Effect.provide(AWS.Backup.ListRecoveryPointsByBackupVaultHttp)`.
 * @binding
 * @section Recovery Points
 * @example List A Vault's Recovery Points
 * ```typescript
 * const listRecoveryPoints =
 *   yield* AWS.Backup.ListRecoveryPointsByBackupVault(vault);
 *
 * const page = yield* listRecoveryPoints({ MaxResults: 25 });
 * ```
 */
export interface ListRecoveryPointsByBackupVault extends Binding.Service<
  ListRecoveryPointsByBackupVault,
  "AWS.Backup.ListRecoveryPointsByBackupVault",
  (
    vault: BackupVault,
  ) => Effect.Effect<
    (
      request?: ListRecoveryPointsByBackupVaultRequest,
    ) => Effect.Effect<
      backup.ListRecoveryPointsByBackupVaultOutput,
      backup.ListRecoveryPointsByBackupVaultError
    >
  >
> {}
export const ListRecoveryPointsByBackupVault =
  Binding.Service<ListRecoveryPointsByBackupVault>(
    "AWS.Backup.ListRecoveryPointsByBackupVault",
  );
