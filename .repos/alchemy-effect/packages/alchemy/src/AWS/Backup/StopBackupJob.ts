import type * as backup from "@distilled.cloud/aws/backup";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `StopBackupJob` operation (IAM action
 * `backup:StopBackupJob`).
 *
 * Cancels a running backup job. Only jobs for resource types that support
 * cancellation can be stopped. Provide the implementation with
 * `Effect.provide(AWS.Backup.StopBackupJobHttp)`.
 * @binding
 * @section Monitoring Backup Jobs
 * @example Cancel A Backup Job
 * ```typescript
 * const stopBackupJob = yield* AWS.Backup.StopBackupJob();
 *
 * yield* stopBackupJob({ BackupJobId: jobId });
 * ```
 */
export interface StopBackupJob extends Binding.Service<
  StopBackupJob,
  "AWS.Backup.StopBackupJob",
  () => Effect.Effect<
    (
      request: backup.StopBackupJobInput,
    ) => Effect.Effect<backup.StopBackupJobResponse, backup.StopBackupJobError>
  >
> {}
export const StopBackupJob = Binding.Service<StopBackupJob>(
  "AWS.Backup.StopBackupJob",
);
