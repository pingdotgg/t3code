import type * as fsx from "@distilled.cloud/aws/fsx";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `CopyBackup` operation (IAM actions
 * `fsx:CopyBackup` + `fsx:TagResource` on `*` — both the source and the new
 * backup's ARNs are unknowable at deploy time).
 *
 * Copies an FSx backup within a region or from another region — the
 * cross-region disaster-recovery half of a runtime backup rotation built
 * with {@link CreateBackup}. A missing source backup surfaces the typed
 * `BackupNotFound`. Provide the implementation with
 * `Effect.provide(AWS.FSx.CopyBackupHttp)`.
 * @binding
 * @section Managing Backups at Runtime
 * @example Copy a backup from another region for DR
 * ```typescript
 * const copyBackup = yield* AWS.FSx.CopyBackup();
 *
 * const copy = yield* copyBackup({
 *   SourceBackupId: backup.BackupId!,
 *   SourceRegion: "us-east-1",
 * });
 * ```
 */
export interface CopyBackup extends Binding.Service<
  CopyBackup,
  "AWS.FSx.CopyBackup",
  () => Effect.Effect<
    (
      request: fsx.CopyBackupRequest,
    ) => Effect.Effect<fsx.CopyBackupResponse, fsx.CopyBackupError>
  >
> {}
export const CopyBackup = Binding.Service<CopyBackup>("AWS.FSx.CopyBackup");
