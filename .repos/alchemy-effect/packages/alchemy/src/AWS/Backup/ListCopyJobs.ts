import type * as backup from "@distilled.cloud/aws/backup";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for the `ListCopyJobs` operation (IAM action
 * `backup:ListCopyJobs`).
 *
 * Lists the account's copy jobs, with optional filters (state, destination
 * vault, resource type). Provide the implementation with
 * `Effect.provide(AWS.Backup.ListCopyJobsHttp)`.
 * @binding
 * @section Copying Recovery Points
 * @example List Running Copy Jobs
 * ```typescript
 * const listCopyJobs = yield* AWS.Backup.ListCopyJobs();
 *
 * const page = yield* listCopyJobs({ ByState: "RUNNING" });
 * ```
 */
export interface ListCopyJobs extends Binding.Service<
  ListCopyJobs,
  "AWS.Backup.ListCopyJobs",
  () => Effect.Effect<
    (
      request?: backup.ListCopyJobsInput,
    ) => Effect.Effect<backup.ListCopyJobsOutput, backup.ListCopyJobsError>
  >
> {}
export const ListCopyJobs = Binding.Service<ListCopyJobs>(
  "AWS.Backup.ListCopyJobs",
);
