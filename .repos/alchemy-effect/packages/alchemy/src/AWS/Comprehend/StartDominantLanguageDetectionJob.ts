import type * as comprehend from "@distilled.cloud/aws/comprehend";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Role } from "../IAM/Role.ts";

/**
 * `StartDominantLanguageDetectionJob` request with `DataAccessRoleArn` defaulting to the role the
 * binding was constructed with.
 */
export interface StartDominantLanguageDetectionJobRequest extends Omit<
  comprehend.StartDominantLanguageDetectionJobRequest,
  "DataAccessRoleArn"
> {
  /**
   * IAM role Amazon Comprehend assumes to read the input documents and write
   * the results.
   * @default the data-access role bound via `StartDominantLanguageDetectionJob(role)`
   */
  DataAccessRoleArn?: string;
}

/**
 * Runtime binding for `comprehend:StartDominantLanguageDetectionJob` — start an asynchronous
 * dominant-language detection job over a collection of documents in S3.
 *
 * The binding is constructed with the **data-access role** (the IAM role
 * Amazon Comprehend assumes to read the input documents and write results;
 * its trust policy must allow `comprehend.amazonaws.com`). The role's ARN is
 * injected as `DataAccessRoleArn` on every runtime request and the host is
 * granted `iam:PassRole` on it alongside the `comprehend:StartDominantLanguageDetectionJob`
 * action (which has no resource-level IAM). Track the job with
 * {@link DescribeDominantLanguageDetectionJob} and stop it with
 * {@link StopDominantLanguageDetectionJob}.
 *
 * @binding
 * @section Starting Analysis Jobs
 * @example Start an Asynchronous DominantLanguage Detection Job
 * ```typescript
 * // deploy time — bind the Comprehend data-access role
 * const startDominantLanguageDetectionJob = yield* AWS.Comprehend.StartDominantLanguageDetectionJob(dataAccessRole);
 *
 * // runtime
 * const job = yield* startDominantLanguageDetectionJob({
 *   InputDataConfig: { S3Uri: "s3://my-bucket/input/", InputFormat: "ONE_DOC_PER_LINE" },
 *   OutputDataConfig: { S3Uri: "s3://my-bucket/output/" },
 *   LanguageCode: "en",
 * });
 * // job.JobId, job.JobStatus === "SUBMITTED"
 * ```
 */
export interface StartDominantLanguageDetectionJob extends Binding.Service<
  StartDominantLanguageDetectionJob,
  "AWS.Comprehend.StartDominantLanguageDetectionJob",
  <R extends Role>(
    dataAccessRole: R,
  ) => Effect.Effect<
    (
      request: StartDominantLanguageDetectionJobRequest,
    ) => Effect.Effect<
      comprehend.StartDominantLanguageDetectionJobResponse,
      comprehend.StartDominantLanguageDetectionJobError
    >
  >
> {}
export const StartDominantLanguageDetectionJob =
  Binding.Service<StartDominantLanguageDetectionJob>(
    "AWS.Comprehend.StartDominantLanguageDetectionJob",
  );
