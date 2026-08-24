import type * as backup from "@distilled.cloud/aws/backup";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `ListRestoreJobs` operation (IAM action
 * `backup:ListRestoreJobs`).
 *
 * Lists the account's restore jobs, with optional filters (status, account,
 * time window). Provide the implementation with
 * `Effect.provide(AWS.Backup.ListRestoreJobsHttp)`.
 * @binding
 * @section Restoring Recovery Points
 * @example List Running Restore Jobs
 * ```typescript
 * const listRestoreJobs = yield* AWS.Backup.ListRestoreJobs();
 *
 * const page = yield* listRestoreJobs({ ByStatus: "RUNNING" });
 * ```
 */
export interface ListRestoreJobs extends Binding.Service<
  ListRestoreJobs,
  "AWS.Backup.ListRestoreJobs",
  () => Effect.Effect<
    (
      request?: backup.ListRestoreJobsInput,
    ) => Effect.Effect<
      backup.ListRestoreJobsOutput,
      backup.ListRestoreJobsError
    >
  >
> {}
export const ListRestoreJobs = Binding.Service<ListRestoreJobs>(
  "AWS.Backup.ListRestoreJobs",
);
