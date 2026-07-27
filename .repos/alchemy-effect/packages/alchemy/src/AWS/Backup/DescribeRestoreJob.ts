import type * as backup from "@distilled.cloud/aws/backup";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `DescribeRestoreJob` operation (IAM action
 * `backup:DescribeRestoreJob`).
 *
 * Returns the details of a restore job by its ID — poll a job started with
 * `StartRestoreJob` until it completes. Provide the implementation with
 * `Effect.provide(AWS.Backup.DescribeRestoreJobHttp)`.
 * @binding
 * @section Restoring Recovery Points
 * @example Poll A Restore Job
 * ```typescript
 * const describeRestoreJob = yield* AWS.Backup.DescribeRestoreJob();
 *
 * const job = yield* describeRestoreJob({ RestoreJobId: jobId });
 * if (job.Status === "COMPLETED") {
 *   yield* Effect.log(`restored: ${job.CreatedResourceArn}`);
 * }
 * ```
 */
export interface DescribeRestoreJob extends Binding.Service<
  DescribeRestoreJob,
  "AWS.Backup.DescribeRestoreJob",
  () => Effect.Effect<
    (
      request: backup.DescribeRestoreJobInput,
    ) => Effect.Effect<
      backup.DescribeRestoreJobOutput,
      backup.DescribeRestoreJobError
    >
  >
> {}
export const DescribeRestoreJob = Binding.Service<DescribeRestoreJob>(
  "AWS.Backup.DescribeRestoreJob",
);
