import type * as backupsearch from "@distilled.cloud/aws/backupsearch";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { SearchJob } from "./SearchJob.ts";

/** `ListSearchJobResults` request with `SearchJobIdentifier` injected from the bound {@link SearchJob}. */
export interface ListSearchJobResultsRequest extends Omit<
  backupsearch.ListSearchJobResultsInput,
  "SearchJobIdentifier"
> {}

/**
 * Runtime binding for `backup-search:ListSearchJobResults`.
 *
 * Pages through the search results (matched S3 objects / EBS files) of the
 * bound search job. Results stream in while the job is `RUNNING` and are
 * retained for seven days after it completes. Provide the implementation
 * with `Effect.provide(AWS.BackupSearch.ListSearchJobResultsHttp)`.
 * @binding
 * @section Reading Search Results
 * @example List the Search Job's Results
 * ```typescript
 * // init — bind the operation to the search job
 * const listSearchJobResults =
 *   yield* AWS.BackupSearch.ListSearchJobResults(search);
 *
 * // runtime
 * const page = yield* listSearchJobResults({ MaxResults: 100 });
 * for (const item of page.Results) {
 *   if (item.S3ResultItem) console.log(item.S3ResultItem.BackupVaultName);
 * }
 * ```
 */
export interface ListSearchJobResults extends Binding.Service<
  ListSearchJobResults,
  "AWS.BackupSearch.ListSearchJobResults",
  (
    searchJob: SearchJob,
  ) => Effect.Effect<
    (
      request?: ListSearchJobResultsRequest,
    ) => Effect.Effect<
      backupsearch.ListSearchJobResultsOutput,
      backupsearch.ListSearchJobResultsError
    >
  >
> {}

export const ListSearchJobResults = Binding.Service<ListSearchJobResults>(
  "AWS.BackupSearch.ListSearchJobResults",
);
