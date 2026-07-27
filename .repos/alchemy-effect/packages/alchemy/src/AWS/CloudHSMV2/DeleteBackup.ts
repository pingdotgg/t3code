import type * as cloudhsm from "@distilled.cloud/aws/cloudhsm-v2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `DeleteBackup` operation (IAM action
 * `cloudhsm:DeleteBackup`).
 *
 * Marks a CloudHSM backup for deletion — it enters `PENDING_DELETION` and
 * can still be recovered with `RestoreBackup` for 7 days. Pair with
 * `DescribeBackups` to build a backup-pruning job. Provide the
 * implementation with `Effect.provide(AWS.CloudHSMV2.DeleteBackupHttp)`.
 * @binding
 * @section Managing Backups
 * @example Prune A Backup
 * ```typescript
 * const deleteBackup = yield* AWS.CloudHSMV2.DeleteBackup();
 *
 * const deleted = yield* deleteBackup({ BackupId: backupId });
 * // deleted.Backup?.BackupState === "PENDING_DELETION"
 * ```
 */
export interface DeleteBackup extends Binding.Service<
  DeleteBackup,
  "AWS.CloudHSMV2.DeleteBackup",
  () => Effect.Effect<
    (
      request: cloudhsm.DeleteBackupRequest,
    ) => Effect.Effect<
      cloudhsm.DeleteBackupResponse,
      cloudhsm.DeleteBackupError
    >
  >
> {}
export const DeleteBackup = Binding.Service<DeleteBackup>(
  "AWS.CloudHSMV2.DeleteBackup",
);
