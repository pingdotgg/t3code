import type * as transcribe from "@distilled.cloud/aws/transcribe";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `transcribe:DeleteCallAnalyticsJob` — delete a Call Analytics job.
 *
 * Amazon Transcribe batch actions have no resource-level IAM; the host is
 * granted `transcribe:DeleteCallAnalyticsJob` on `*`.
 *
 * @binding
 * @section Call Analytics Jobs
 * @example Delete a Call Analytics Job
 * ```typescript
 * // init
 * const deleteCallAnalyticsJob = yield* AWS.Transcribe.DeleteCallAnalyticsJob();
 *
 * // runtime
 * yield* deleteCallAnalyticsJob({ CallAnalyticsJobName: "my-call" });
 * ```
 */
export interface DeleteCallAnalyticsJob extends Binding.Service<
  DeleteCallAnalyticsJob,
  "AWS.Transcribe.DeleteCallAnalyticsJob",
  () => Effect.Effect<
    (
      request: transcribe.DeleteCallAnalyticsJobRequest,
    ) => Effect.Effect<
      transcribe.DeleteCallAnalyticsJobResponse,
      transcribe.DeleteCallAnalyticsJobError
    >
  >
> {}
export const DeleteCallAnalyticsJob = Binding.Service<DeleteCallAnalyticsJob>(
  "AWS.Transcribe.DeleteCallAnalyticsJob",
);
