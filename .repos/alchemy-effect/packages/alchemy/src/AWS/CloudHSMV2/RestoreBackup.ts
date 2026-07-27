import type * as cloudhsm from "@distilled.cloud/aws/cloudhsm-v2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `RestoreBackup` operation (IAM action
 * `cloudhsm:RestoreBackup`).
 *
 * Recovers a CloudHSM backup in the `PENDING_DELETION` state back to
 * `READY` — the undo for `DeleteBackup`, available for 7 days after the
 * delete. Provide the implementation with
 * `Effect.provide(AWS.CloudHSMV2.RestoreBackupHttp)`.
 * @binding
 * @section Managing Backups
 * @example Undo A Backup Deletion
 * ```typescript
 * const restoreBackup = yield* AWS.CloudHSMV2.RestoreBackup();
 *
 * const restored = yield* restoreBackup({ BackupId: backupId });
 * // restored.Backup?.BackupState === "READY"
 * ```
 */
export interface RestoreBackup extends Binding.Service<
  RestoreBackup,
  "AWS.CloudHSMV2.RestoreBackup",
  () => Effect.Effect<
    (
      request: cloudhsm.RestoreBackupRequest,
    ) => Effect.Effect<
      cloudhsm.RestoreBackupResponse,
      cloudhsm.RestoreBackupError
    >
  >
> {}
export const RestoreBackup = Binding.Service<RestoreBackup>(
  "AWS.CloudHSMV2.RestoreBackup",
);
