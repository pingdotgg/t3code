import type * as cloudhsm from "@distilled.cloud/aws/cloudhsm-v2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `CopyBackupToRegion` operation (IAM action
 * `cloudhsm:CopyBackupToRegion`; the grant includes
 * `cloudhsm:TagResource` so user tags on the source backup can be copied to
 * the destination backup).
 *
 * Copies a CloudHSM cluster backup into another region — the building block
 * of cross-region disaster-recovery automation. Provide the implementation
 * with `Effect.provide(AWS.CloudHSMV2.CopyBackupToRegionHttp)`.
 * @binding
 * @section Managing Backups
 * @example Copy A Backup For Disaster Recovery
 * ```typescript
 * const copyBackupToRegion = yield* AWS.CloudHSMV2.CopyBackupToRegion();
 *
 * const copy = yield* copyBackupToRegion({
 *   DestinationRegion: "us-east-1",
 *   BackupId: backupId,
 * });
 * // copy.DestinationBackup?.SourceBackup === backupId
 * ```
 */
export interface CopyBackupToRegion extends Binding.Service<
  CopyBackupToRegion,
  "AWS.CloudHSMV2.CopyBackupToRegion",
  () => Effect.Effect<
    (
      request: cloudhsm.CopyBackupToRegionRequest,
    ) => Effect.Effect<
      cloudhsm.CopyBackupToRegionResponse,
      cloudhsm.CopyBackupToRegionError
    >
  >
> {}
export const CopyBackupToRegion = Binding.Service<CopyBackupToRegion>(
  "AWS.CloudHSMV2.CopyBackupToRegion",
);
