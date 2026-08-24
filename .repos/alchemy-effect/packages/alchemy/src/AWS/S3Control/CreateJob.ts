import type * as s3control from "@distilled.cloud/aws/s3-control";
import type * as sts from "@distilled.cloud/aws/sts";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `s3:CreateJob` (S3 Batch Operations).
 *
 * Submits a large-scale batch job — copy, tag, ACL, restore, or
 * Lambda-invoke — over a manifest of S3 objects, e.g. an ingest Lambda that
 * kicks off a bulk re-tagging run. The binding also grants `iam:PassRole` so
 * the function can hand the service the job's execution role. The account id
 * is resolved once via `sts:GetCallerIdentity`. Provide the implementation
 * with `Effect.provide(AWS.S3Control.CreateJobHttp)`.
 * @binding
 * @section Running Batch Operations Jobs
 * @example Submit a Suspended Tagging Job
 * ```typescript
 * // init — account-level binding, no resource argument
 * const createJob = yield* AWS.S3Control.CreateJob();
 *
 * // runtime
 * const { JobId } = yield* createJob({
 *   ConfirmationRequired: true,
 *   Priority: 1,
 *   RoleArn: batchRoleArn,
 *   Operation: { S3PutObjectTagging: { TagSet: [{ Key: "swept", Value: "true" }] } },
 *   Report: { Enabled: false },
 *   ClientRequestToken: token,
 *   ManifestGenerator: {
 *     S3JobManifestGenerator: {
 *       SourceBucket: bucketArn,
 *       EnableManifestOutput: false,
 *     },
 *   },
 * });
 * ```
 */
export interface CreateJob extends Binding.Service<
  CreateJob,
  "AWS.S3Control.CreateJob",
  () => Effect.Effect<
    (
      request: Omit<s3control.CreateJobRequest, "AccountId">,
    ) => Effect.Effect<
      s3control.CreateJobResult,
      s3control.CreateJobError | sts.GetCallerIdentityError
    >
  >
> {}
export const CreateJob = Binding.Service<CreateJob>("AWS.S3Control.CreateJob");
