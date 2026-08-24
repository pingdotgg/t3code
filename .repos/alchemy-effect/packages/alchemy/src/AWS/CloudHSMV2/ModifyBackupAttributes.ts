import type * as cloudhsm from "@distilled.cloud/aws/cloudhsm-v2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `ModifyBackupAttributes` operation (IAM action
 * `cloudhsm:ModifyBackupAttributes`).
 *
 * Toggles a backup's `NeverExpires` attribute — pin a golden backup so the
 * cluster's retention policy never deletes it, or unpin it again. Provide
 * the implementation with
 * `Effect.provide(AWS.CloudHSMV2.ModifyBackupAttributesHttp)`.
 * @binding
 * @section Managing Backups
 * @example Pin A Backup Forever
 * ```typescript
 * const modifyBackupAttributes =
 *   yield* AWS.CloudHSMV2.ModifyBackupAttributes();
 *
 * yield* modifyBackupAttributes({ BackupId: backupId, NeverExpires: true });
 * ```
 */
export interface ModifyBackupAttributes extends Binding.Service<
  ModifyBackupAttributes,
  "AWS.CloudHSMV2.ModifyBackupAttributes",
  () => Effect.Effect<
    (
      request: cloudhsm.ModifyBackupAttributesRequest,
    ) => Effect.Effect<
      cloudhsm.ModifyBackupAttributesResponse,
      cloudhsm.ModifyBackupAttributesError
    >
  >
> {}
export const ModifyBackupAttributes = Binding.Service<ModifyBackupAttributes>(
  "AWS.CloudHSMV2.ModifyBackupAttributes",
);
