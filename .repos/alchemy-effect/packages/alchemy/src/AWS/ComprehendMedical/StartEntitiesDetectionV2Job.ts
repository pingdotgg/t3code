import type * as comprehendmedical from "@distilled.cloud/aws/comprehendmedical";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `comprehendmedical:StartEntitiesDetectionV2Job` — start an asynchronous medical entity detection job over a collection of documents in S3. Also grants `iam:PassRole` (conditioned to `comprehendmedical.amazonaws.com`) for the job's data-access role.
 *
 * Comprehend Medical has no resource-level IAM, so the binding takes no
 * arguments and grants `comprehendmedical:StartEntitiesDetectionV2Job` on `*`. Provide the
 * implementation with `Effect.provide(AWS.ComprehendMedical.StartEntitiesDetectionV2JobHttp)`.
 *
 * @binding
 * @section Batch Entity Detection Jobs
 * @example Start a Batch Job
 * ```typescript
 * // init
 * const startEntitiesDetectionV2Job = yield* AWS.ComprehendMedical.StartEntitiesDetectionV2Job();
 *
 * // runtime
 * const job = yield* startEntitiesDetectionV2Job({
 *   InputDataConfig: { S3Bucket: "my-input-bucket", S3Key: "notes/" },
 *   OutputDataConfig: { S3Bucket: "my-output-bucket" },
 *   DataAccessRoleArn: dataAccessRole.roleArn,
 *   LanguageCode: "en",
 * });
 * ```
 */
export interface StartEntitiesDetectionV2Job extends Binding.Service<
  StartEntitiesDetectionV2Job,
  "AWS.ComprehendMedical.StartEntitiesDetectionV2Job",
  () => Effect.Effect<
    (
      request: comprehendmedical.StartEntitiesDetectionV2JobRequest,
    ) => Effect.Effect<
      comprehendmedical.StartEntitiesDetectionV2JobResponse,
      comprehendmedical.StartEntitiesDetectionV2JobError
    >
  >
> {}
export const StartEntitiesDetectionV2Job =
  Binding.Service<StartEntitiesDetectionV2Job>(
    "AWS.ComprehendMedical.StartEntitiesDetectionV2Job",
  );
