import type * as backupsearch from "@distilled.cloud/aws/backupsearch";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { SearchJob } from "./SearchJob.ts";

/** `ListSearchJobBackups` request with `SearchJobIdentifier` injected from the bound {@link SearchJob}. */
export interface ListSearchJobBackupsRequest extends Omit<
  backupsearch.ListSearchJobBackupsInput,
  "SearchJobIdentifier"
> {}

/**
 * Runtime binding for `backup-search:ListSearchJobBackups`.
 *
 * Pages through the recovery points included in the bound search job, with
 * each backup's per-job status — including backups skipped because their
 * index is not `ACTIVE` or a permissions issue marked them `FAILED`. Provide
 * the implementation with
 * `Effect.provide(AWS.BackupSearch.ListSearchJobBackupsHttp)`.
 * @binding
 * @section Reading Searched Backups
 * @example List the Search Job's Backups
 * ```typescript
 * // init — bind the operation to the search job
 * const listSearchJobBackups =
 *   yield* AWS.BackupSearch.ListSearchJobBackups(search);
 *
 * // runtime
 * const page = yield* listSearchJobBackups({ MaxResults: 100 });
 * for (const backup of page.Results) {
 *   console.log(backup.BackupResourceArn, backup.Status);
 * }
 * ```
 */
export interface ListSearchJobBackups extends Binding.Service<
  ListSearchJobBackups,
  "AWS.BackupSearch.ListSearchJobBackups",
  (
    searchJob: SearchJob,
  ) => Effect.Effect<
    (
      request?: ListSearchJobBackupsRequest,
    ) => Effect.Effect<
      backupsearch.ListSearchJobBackupsOutput,
      backupsearch.ListSearchJobBackupsError
    >
  >
> {}

export const ListSearchJobBackups = Binding.Service<ListSearchJobBackups>(
  "AWS.BackupSearch.ListSearchJobBackups",
);
