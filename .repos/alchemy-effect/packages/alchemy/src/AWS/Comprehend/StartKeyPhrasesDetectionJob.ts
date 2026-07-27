import type * as comprehend from "@distilled.cloud/aws/comprehend";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Role } from "../IAM/Role.ts";

/**
 * `StartKeyPhrasesDetectionJob` request with `DataAccessRoleArn` defaulting to the role the
 * binding was constructed with.
 */
export interface StartKeyPhrasesDetectionJobRequest extends Omit<
  comprehend.StartKeyPhrasesDetectionJobRequest,
  "DataAccessRoleArn"
> {
  /**
   * IAM role Amazon Comprehend assumes to read the input documents and write
   * the results.
   * @default the data-access role bound via `StartKeyPhrasesDetectionJob(role)`
   */
  DataAccessRoleArn?: string;
}

/**
 * Runtime binding for `comprehend:StartKeyPhrasesDetectionJob` — start an asynchronous
 * key-phrase detection job over a collection of documents in S3.
 *
 * The binding is constructed with the **data-access role** (the IAM role
 * Amazon Comprehend assumes to read the input documents and write results;
 * its trust policy must allow `comprehend.amazonaws.com`). The role's ARN is
 * injected as `DataAccessRoleArn` on every runtime request and the host is
 * granted `iam:PassRole` on it alongside the `comprehend:StartKeyPhrasesDetectionJob`
 * action (which has no resource-level IAM). Track the job with
 * {@link DescribeKeyPhrasesDetectionJob} and stop it with
 * {@link StopKeyPhrasesDetectionJob}.
 *
 * @binding
 * @section Starting Analysis Jobs
 * @example Start an Asynchronous KeyPhrases Detection Job
 * ```typescript
 * // deploy time — bind the Comprehend data-access role
 * const startKeyPhrasesDetectionJob = yield* AWS.Comprehend.StartKeyPhrasesDetectionJob(dataAccessRole);
 *
 * // runtime
 * const job = yield* startKeyPhrasesDetectionJob({
 *   InputDataConfig: { S3Uri: "s3://my-bucket/input/", InputFormat: "ONE_DOC_PER_LINE" },
 *   OutputDataConfig: { S3Uri: "s3://my-bucket/output/" },
 *   LanguageCode: "en",
 * });
 * // job.JobId, job.JobStatus === "SUBMITTED"
 * ```
 */
export interface StartKeyPhrasesDetectionJob extends Binding.Service<
  StartKeyPhrasesDetectionJob,
  "AWS.Comprehend.StartKeyPhrasesDetectionJob",
  <R extends Role>(
    dataAccessRole: R,
  ) => Effect.Effect<
    (
      request: StartKeyPhrasesDetectionJobRequest,
    ) => Effect.Effect<
      comprehend.StartKeyPhrasesDetectionJobResponse,
      comprehend.StartKeyPhrasesDetectionJobError
    >
  >
> {}
export const StartKeyPhrasesDetectionJob =
  Binding.Service<StartKeyPhrasesDetectionJob>(
    "AWS.Comprehend.StartKeyPhrasesDetectionJob",
  );
