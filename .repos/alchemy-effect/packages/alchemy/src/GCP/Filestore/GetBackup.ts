import type * as file from "@distilled.cloud/gcp/file_v1";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { RuntimeContext } from "../../RuntimeContext.ts";
import type { Backup } from "./Backup.ts";

export interface GetBackupRequest extends Omit<
  file.GetProjectsLocationsBackupsRequest,
  "name"
> {}

/**
 * Runtime binding for Cloud Filestore `backups.get`.
 *
 * Bind this operation to a {@link Backup} in a Function/Action init
 * phase. Provide {@link GetBackupHttp}.
 *
 * ### Observing Backups
 * **Example:** Read the bound backup
 * ```typescript
 * const getBackup = yield* GCP.Filestore.GetBackup(backup);
 * const live = yield* getBackup();
 * ```
 *
 * @binding
 * @category Filestore
 */
export interface GetBackup extends Binding.Service<
  GetBackup,
  "GCP.Filestore.GetBackup",
  (
    backup: Backup,
  ) => Effect.Effect<
    (
      request?: GetBackupRequest,
    ) => Effect.Effect<
      file.Backup,
      file.GetProjectsLocationsBackupsError,
      RuntimeContext
    >
  >
> {}

export const GetBackup = Binding.Service<GetBackup>("GCP.Filestore.GetBackup");
