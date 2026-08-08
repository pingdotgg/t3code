import type * as backupsearch from "@distilled.cloud/aws/backupsearch";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { SearchJob } from "./SearchJob.ts";

/**
 * Runtime binding for `backup-search:GetSearchJob`.
 *
 * Retrieves the bound search job's metadata and progress — its `Status`
 * (`RUNNING`, `COMPLETED`, `STOPPED`, `FAILED`), item/backup counts, and
 * completion time. BackupSearch emits no EventBridge events, so polling this
 * operation until `Status` is terminal is how a consumer knows the results
 * returned by `ListSearchJobResults` are final. Provide the implementation
 * with `Effect.provide(AWS.BackupSearch.GetSearchJobHttp)`.
 * @binding
 * @section Polling Search Progress
 * @example Wait for the Search Job to Complete
 * ```typescript
 * // init — bind the operation to the search job
 * const getSearchJob = yield* AWS.BackupSearch.GetSearchJob(search);
 *
 * // runtime — poll until the job reaches a terminal status
 * const job = yield* getSearchJob().pipe(
 *   Effect.repeat({
 *     schedule: Schedule.spaced("5 seconds"),
 *     until: (j) => j.Status !== "RUNNING",
 *     times: 24,
 *   }),
 * );
 * console.log(job.Status, job.SearchProgress?.ItemsMatchedCount);
 * ```
 */
export interface GetSearchJob extends Binding.Service<
  GetSearchJob,
  "AWS.BackupSearch.GetSearchJob",
  (
    searchJob: SearchJob,
  ) => Effect.Effect<
    () => Effect.Effect<
      backupsearch.GetSearchJobOutput,
      backupsearch.GetSearchJobError
    >
  >
> {}

export const GetSearchJob = Binding.Service<GetSearchJob>(
  "AWS.BackupSearch.GetSearchJob",
);
