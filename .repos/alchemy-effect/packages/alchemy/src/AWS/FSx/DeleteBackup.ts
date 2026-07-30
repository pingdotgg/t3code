import type * as fsx from "@distilled.cloud/aws/fsx";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `DeleteBackup` operation (IAM action
 * `fsx:DeleteBackup` on `*` — runtime-created backups have ARNs unknowable
 * at deploy time).
 *
 * Deletes an FSx backup by id — the teardown half of a runtime backup
 * rotation built with {@link CreateBackup}. Deleting an already-deleted
 * backup surfaces the typed `BackupNotFound`. Provide the implementation
 * with `Effect.provide(AWS.FSx.DeleteBackupHttp)`.
 * @binding
 * @section Managing Backups at Runtime
 * @example Rotate out an expired backup
 * ```typescript
 * const deleteBackup = yield* AWS.FSx.DeleteBackup();
 *
 * yield* deleteBackup({ BackupId: expired.BackupId! }).pipe(
 *   Effect.catchTag("BackupNotFound", () => Effect.void),
 * );
 * ```
 */
export interface DeleteBackup extends Binding.Service<
  DeleteBackup,
  "AWS.FSx.DeleteBackup",
  () => Effect.Effect<
    (
      request: fsx.DeleteBackupRequest,
    ) => Effect.Effect<fsx.DeleteBackupResponse, fsx.DeleteBackupError>
  >
> {}
export const DeleteBackup = Binding.Service<DeleteBackup>(
  "AWS.FSx.DeleteBackup",
);
