import type * as fsx from "@distilled.cloud/aws/fsx";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { FileSystem } from "./FileSystem.ts";

/**
 * Runtime binding for the `CreateBackup` operation scoped to one file system
 * (IAM actions `fsx:CreateBackup` and `fsx:TagResource` on the file system
 * ARN and on `arn:aws:fsx:*:*:backup/*` — the new backup's ARN is unknowable
 * at deploy time).
 *
 * Takes a user-initiated backup of the bound {@link FileSystem} — e.g.
 * before a risky data migration, or on an application-defined cadence
 * richer than the daily automatic backup. Pass a `ClientRequestToken` to
 * make the call idempotent. A backup already in progress surfaces the typed
 * `BackupInProgress`. Provide the implementation with
 * `Effect.provide(AWS.FSx.CreateBackupHttp)`.
 * @binding
 * @section Managing Backups at Runtime
 * @example Take a pre-migration backup
 * ```typescript
 * const createBackup = yield* AWS.FSx.CreateBackup(files);
 *
 * const response = yield* createBackup({
 *   ClientRequestToken: `migration-${migrationId}`,
 *   Tags: [{ Key: "reason", Value: "pre-migration" }],
 * });
 * yield* Effect.log(`backup ${response.Backup?.BackupId} started`);
 * ```
 */
export interface CreateBackup extends Binding.Service<
  CreateBackup,
  "AWS.FSx.CreateBackup",
  (
    fileSystem: FileSystem,
  ) => Effect.Effect<
    (
      request?: Omit<fsx.CreateBackupRequest, "FileSystemId">,
    ) => Effect.Effect<fsx.CreateBackupResponse, fsx.CreateBackupError>
  >
> {}
export const CreateBackup = Binding.Service<CreateBackup>(
  "AWS.FSx.CreateBackup",
);
