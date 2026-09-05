import type * as signer from "@distilled.cloud/aws/signer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { SigningProfile } from "./SigningProfile.ts";

/**
 * Runtime binding for `signer:StartSigningJob`.
 *
 * Starts an asynchronous code-signing job with the bound
 * {@link SigningProfile} — Signer reads the (versioned) source object from
 * S3, signs it with the profile's platform and material, and writes the
 * signed artifact to the destination bucket. The profile name is injected
 * from the binding; the caller's credentials are used for the S3 access, so
 * also bind `S3.GetObject` on the source bucket and `S3.PutObject` on the
 * destination. Returns the `jobId` for use with `DescribeSigningJob` /
 * `RevokeSignature`. Provide the implementation with
 * `Effect.provide(AWS.Signer.StartSigningJobHttp)`.
 * @binding
 * @section Signing Code
 * @example Sign an S3 Object
 * ```typescript
 * // init — bind the operation to the profile
 * const startSigningJob = yield* AWS.Signer.StartSigningJob(profile);
 *
 * // runtime
 * const { jobId } = yield* startSigningJob({
 *   source: { s3: { bucketName: "src", key: "code.zip", version: versionId } },
 *   destination: { s3: { bucketName: "dst", prefix: "signed/" } },
 * });
 * ```
 */
export interface StartSigningJob extends Binding.Service<
  StartSigningJob,
  "AWS.Signer.StartSigningJob",
  (
    profile: SigningProfile,
  ) => Effect.Effect<
    (
      request: Omit<signer.StartSigningJobRequest, "profileName">,
    ) => Effect.Effect<
      signer.StartSigningJobResponse,
      signer.StartSigningJobError
    >
  >
> {}
export const StartSigningJob = Binding.Service<StartSigningJob>(
  "AWS.Signer.StartSigningJob",
);
