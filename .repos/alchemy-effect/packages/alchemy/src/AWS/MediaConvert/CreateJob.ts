import type * as mediaconvert from "@distilled.cloud/aws/mediaconvert";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `mediaconvert:CreateJob` — submit a transcode job from
 * runtime code, the classic "S3 upload event → Lambda → transcode" workflow.
 * Also grants `iam:PassRole` (conditioned to `mediaconvert.amazonaws.com`)
 * for the S3-access role the job passes to the service.
 *
 * Job ids are server-assigned at runtime, so the binding takes no arguments
 * and grants `mediaconvert:CreateJob` on `*`. Provide the implementation
 * with `Effect.provide(AWS.MediaConvert.CreateJobHttp)`.
 *
 * @binding
 * @section Submitting Jobs
 * @example Transcode an Uploaded File
 * ```typescript
 * // init
 * const createJob = yield* AWS.MediaConvert.CreateJob();
 *
 * // runtime
 * const { Job } = yield* createJob({
 *   Role: roleArn,
 *   JobTemplate: template.jobTemplateName,
 *   Settings: { Inputs: [{ FileInput: `s3://${bucket}/${key}` }] },
 * });
 * ```
 */
export interface CreateJob extends Binding.Service<
  CreateJob,
  "AWS.MediaConvert.CreateJob",
  () => Effect.Effect<
    (
      request: mediaconvert.CreateJobRequest,
    ) => Effect.Effect<
      mediaconvert.CreateJobResponse,
      mediaconvert.CreateJobError
    >
  >
> {}
export const CreateJob = Binding.Service<CreateJob>(
  "AWS.MediaConvert.CreateJob",
);
