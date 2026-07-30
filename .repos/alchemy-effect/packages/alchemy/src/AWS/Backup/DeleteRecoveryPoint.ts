import type * as backup from "@distilled.cloud/aws/backup";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { BackupVault } from "./BackupVault.ts";

/**
 * `DeleteRecoveryPoint` request with `BackupVaultName` injected from the
 * bound {@link BackupVault}.
 */
export interface DeleteRecoveryPointRequest extends Omit<
  backup.DeleteRecoveryPointInput,
  "BackupVaultName"
> {}

/**
 * Runtime binding for the `DeleteRecoveryPoint` operation (IAM action
 * `backup:DeleteRecoveryPoint`).
 *
 * Deletes a recovery point from the bound {@link BackupVault} — e.g. a
 * retention janitor pruning on-demand backups. Provide the implementation
 * with `Effect.provide(AWS.Backup.DeleteRecoveryPointHttp)`.
 * @binding
 * @section Recovery Points
 * @example Prune A Recovery Point
 * ```typescript
 * const deleteRecoveryPoint = yield* AWS.Backup.DeleteRecoveryPoint(vault);
 *
 * yield* deleteRecoveryPoint({ RecoveryPointArn: recoveryPointArn });
 * ```
 */
export interface DeleteRecoveryPoint extends Binding.Service<
  DeleteRecoveryPoint,
  "AWS.Backup.DeleteRecoveryPoint",
  (
    vault: BackupVault,
  ) => Effect.Effect<
    (
      request: DeleteRecoveryPointRequest,
    ) => Effect.Effect<
      backup.DeleteRecoveryPointResponse,
      backup.DeleteRecoveryPointError
    >
  >
> {}
export const DeleteRecoveryPoint = Binding.Service<DeleteRecoveryPoint>(
  "AWS.Backup.DeleteRecoveryPoint",
);
