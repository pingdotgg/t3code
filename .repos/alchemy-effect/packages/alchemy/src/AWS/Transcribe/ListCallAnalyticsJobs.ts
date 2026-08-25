import type * as transcribe from "@distilled.cloud/aws/transcribe";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `transcribe:ListCallAnalyticsJobs` — list the Call Analytics jobs in the account.
 *
 * Amazon Transcribe batch actions have no resource-level IAM; the host is
 * granted `transcribe:ListCallAnalyticsJobs` on `*`.
 *
 * @binding
 * @section Call Analytics Jobs
 * @example List Call Analytics Jobs
 * ```typescript
 * // init
 * const listCallAnalyticsJobs = yield* AWS.Transcribe.ListCallAnalyticsJobs();
 *
 * // runtime
 * const { CallAnalyticsJobSummaries } = yield* listCallAnalyticsJobs({ MaxResults: 10 });
 * ```
 */
export interface ListCallAnalyticsJobs extends Binding.Service<
  ListCallAnalyticsJobs,
  "AWS.Transcribe.ListCallAnalyticsJobs",
  () => Effect.Effect<
    (
      request?: transcribe.ListCallAnalyticsJobsRequest,
    ) => Effect.Effect<
      transcribe.ListCallAnalyticsJobsResponse,
      transcribe.ListCallAnalyticsJobsError
    >
  >
> {}
export const ListCallAnalyticsJobs = Binding.Service<ListCallAnalyticsJobs>(
  "AWS.Transcribe.ListCallAnalyticsJobs",
);
