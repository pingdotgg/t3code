import type * as transcribe from "@distilled.cloud/aws/transcribe";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `transcribe:GetCallAnalyticsJob` — read a Call Analytics job's status and, once complete, the transcript location.
 *
 * Amazon Transcribe batch actions have no resource-level IAM; the host is
 * granted `transcribe:GetCallAnalyticsJob` on `*`.
 *
 * @binding
 * @section Call Analytics Jobs
 * @example Poll a Call Analytics Job
 * ```typescript
 * // init
 * const getCallAnalyticsJob = yield* AWS.Transcribe.GetCallAnalyticsJob();
 *
 * // runtime
 * const { CallAnalyticsJob } = yield* getCallAnalyticsJob({
 *   CallAnalyticsJobName: "my-call",
 * });
 * ```
 */
export interface GetCallAnalyticsJob extends Binding.Service<
  GetCallAnalyticsJob,
  "AWS.Transcribe.GetCallAnalyticsJob",
  () => Effect.Effect<
    (
      request: transcribe.GetCallAnalyticsJobRequest,
    ) => Effect.Effect<
      transcribe.GetCallAnalyticsJobResponse,
      transcribe.GetCallAnalyticsJobError
    >
  >
> {}
export const GetCallAnalyticsJob = Binding.Service<GetCallAnalyticsJob>(
  "AWS.Transcribe.GetCallAnalyticsJob",
);
