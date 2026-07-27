import type * as backup from "@distilled.cloud/aws/backup";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `DescribeBackupJob` operation (IAM action
 * `backup:DescribeBackupJob`).
 *
 * Returns the details of a backup job by its ID — poll a job started with
 * `StartBackupJob` until it completes. Provide the implementation with
 * `Effect.provide(AWS.Backup.DescribeBackupJobHttp)`.
 * @binding
 * @section Monitoring Backup Jobs
 * @example Poll A Backup Job
 * ```typescript
 * const describeBackupJob = yield* AWS.Backup.DescribeBackupJob();
 *
 * const job = yield* describeBackupJob({ BackupJobId: jobId });
 * if (job.State === "COMPLETED") {
 *   yield* Effect.log(`recovery point: ${job.RecoveryPointArn}`);
 * }
 * ```
 */
export interface DescribeBackupJob extends Binding.Service<
  DescribeBackupJob,
  "AWS.Backup.DescribeBackupJob",
  () => Effect.Effect<
    (
      request: backup.DescribeBackupJobInput,
    ) => Effect.Effect<
      backup.DescribeBackupJobOutput,
      backup.DescribeBackupJobError
    >
  >
> {}
export const DescribeBackupJob = Binding.Service<DescribeBackupJob>(
  "AWS.Backup.DescribeBackupJob",
);
