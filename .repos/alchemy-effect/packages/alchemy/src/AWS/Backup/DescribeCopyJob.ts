import type * as backup from "@distilled.cloud/aws/backup";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `DescribeCopyJob` operation (IAM action
 * `backup:DescribeCopyJob`).
 *
 * Returns the details of a copy job by its ID — poll a job started with
 * `StartCopyJob` until it completes. Provide the implementation with
 * `Effect.provide(AWS.Backup.DescribeCopyJobHttp)`.
 * @binding
 * @section Copying Recovery Points
 * @example Poll A Copy Job
 * ```typescript
 * const describeCopyJob = yield* AWS.Backup.DescribeCopyJob();
 *
 * const { CopyJob } = yield* describeCopyJob({ CopyJobId: jobId });
 * ```
 */
export interface DescribeCopyJob extends Binding.Service<
  DescribeCopyJob,
  "AWS.Backup.DescribeCopyJob",
  () => Effect.Effect<
    (
      request: backup.DescribeCopyJobInput,
    ) => Effect.Effect<
      backup.DescribeCopyJobOutput,
      backup.DescribeCopyJobError
    >
  >
> {}
export const DescribeCopyJob = Binding.Service<DescribeCopyJob>(
  "AWS.Backup.DescribeCopyJob",
);
