import type * as backup from "@distilled.cloud/aws/backup";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `ListBackupJobs` operation (IAM action
 * `backup:ListBackupJobs`).
 *
 * Lists the account's backup jobs from the last 30 days, with optional
 * filters (state, vault, resource type, time window). Provide the
 * implementation with `Effect.provide(AWS.Backup.ListBackupJobsHttp)`.
 * @binding
 * @section Monitoring Backup Jobs
 * @example List Running Backup Jobs
 * ```typescript
 * const listBackupJobs = yield* AWS.Backup.ListBackupJobs();
 *
 * const page = yield* listBackupJobs({ ByState: "RUNNING", MaxResults: 25 });
 * ```
 */
export interface ListBackupJobs extends Binding.Service<
  ListBackupJobs,
  "AWS.Backup.ListBackupJobs",
  () => Effect.Effect<
    (
      request?: backup.ListBackupJobsInput,
    ) => Effect.Effect<backup.ListBackupJobsOutput, backup.ListBackupJobsError>
  >
> {}
export const ListBackupJobs = Binding.Service<ListBackupJobs>(
  "AWS.Backup.ListBackupJobs",
);
