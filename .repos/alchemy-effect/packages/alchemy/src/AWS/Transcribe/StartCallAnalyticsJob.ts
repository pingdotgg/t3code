import type * as transcribe from "@distilled.cloud/aws/transcribe";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Role } from "../IAM/Role.ts";

/**
 * `StartCallAnalyticsJob` request with `DataAccessRoleArn` defaulting to the role the
 * binding was constructed with.
 */
export interface StartCallAnalyticsJobRequest extends Omit<
  transcribe.StartCallAnalyticsJobRequest,
  "DataAccessRoleArn"
> {
  /**
   * IAM role Amazon Transcribe assumes to access your Amazon S3 data.
   * @default the data-access role bound via `StartCallAnalyticsJob(role)`
   */
  DataAccessRoleArn?: string;
}

/**
 * Runtime binding for `transcribe:StartCallAnalyticsJob` — start an asynchronous Call Analytics job (transcription plus call characteristics, sentiment, and category matching) over a call recording in S3.
 *
 * The binding is constructed with the **data-access role** (the IAM role
 * Amazon Transcribe assumes to read your Amazon S3 data and write results;
 * its trust policy must allow `transcribe.amazonaws.com`). The role's ARN
 * is injected as `DataAccessRoleArn` on every runtime request and the host
 * is granted `iam:PassRole` on it alongside `transcribe:StartCallAnalyticsJob`
 * (which has no resource-level IAM).
 *
 * @binding
 * @section Call Analytics Jobs
 * @example Start a Call Analytics Job
 * ```typescript
 * // init — bind the Transcribe data-access role
 * const startCallAnalyticsJob = yield* AWS.Transcribe.StartCallAnalyticsJob(dataAccessRole);
 *
 * // runtime
 * const { CallAnalyticsJob } = yield* startCallAnalyticsJob({
 *   CallAnalyticsJobName: "my-call",
 *   Media: { MediaFileUri: "s3://my-bucket/calls/call.wav" },
 * });
 * ```
 */
export interface StartCallAnalyticsJob extends Binding.Service<
  StartCallAnalyticsJob,
  "AWS.Transcribe.StartCallAnalyticsJob",
  <R extends Role>(
    dataAccessRole: R,
  ) => Effect.Effect<
    (
      request: StartCallAnalyticsJobRequest,
    ) => Effect.Effect<
      transcribe.StartCallAnalyticsJobResponse,
      transcribe.StartCallAnalyticsJobError
    >
  >
> {}
export const StartCallAnalyticsJob = Binding.Service<StartCallAnalyticsJob>(
  "AWS.Transcribe.StartCallAnalyticsJob",
);
