import type * as comprehend from "@distilled.cloud/aws/comprehend";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Role } from "../IAM/Role.ts";

/**
 * `StartSentimentDetectionJob` request with `DataAccessRoleArn` defaulting to the role the
 * binding was constructed with.
 */
export interface StartSentimentDetectionJobRequest extends Omit<
  comprehend.StartSentimentDetectionJobRequest,
  "DataAccessRoleArn"
> {
  /**
   * IAM role Amazon Comprehend assumes to read the input documents and write
   * the results.
   * @default the data-access role bound via `StartSentimentDetectionJob(role)`
   */
  DataAccessRoleArn?: string;
}

/**
 * Runtime binding for `comprehend:StartSentimentDetectionJob` — start an asynchronous
 * sentiment detection job over a collection of documents in S3.
 *
 * The binding is constructed with the **data-access role** (the IAM role
 * Amazon Comprehend assumes to read the input documents and write results;
 * its trust policy must allow `comprehend.amazonaws.com`). The role's ARN is
 * injected as `DataAccessRoleArn` on every runtime request and the host is
 * granted `iam:PassRole` on it alongside the `comprehend:StartSentimentDetectionJob`
 * action (which has no resource-level IAM). Track the job with
 * {@link DescribeSentimentDetectionJob} and stop it with
 * {@link StopSentimentDetectionJob}.
 *
 * @binding
 * @section Starting Analysis Jobs
 * @example Start an Asynchronous Sentiment Detection Job
 * ```typescript
 * // deploy time — bind the Comprehend data-access role
 * const startSentimentDetectionJob = yield* AWS.Comprehend.StartSentimentDetectionJob(dataAccessRole);
 *
 * // runtime
 * const job = yield* startSentimentDetectionJob({
 *   InputDataConfig: { S3Uri: "s3://my-bucket/input/", InputFormat: "ONE_DOC_PER_LINE" },
 *   OutputDataConfig: { S3Uri: "s3://my-bucket/output/" },
 *   LanguageCode: "en",
 * });
 * // job.JobId, job.JobStatus === "SUBMITTED"
 * ```
 */
export interface StartSentimentDetectionJob extends Binding.Service<
  StartSentimentDetectionJob,
  "AWS.Comprehend.StartSentimentDetectionJob",
  <R extends Role>(
    dataAccessRole: R,
  ) => Effect.Effect<
    (
      request: StartSentimentDetectionJobRequest,
    ) => Effect.Effect<
      comprehend.StartSentimentDetectionJobResponse,
      comprehend.StartSentimentDetectionJobError
    >
  >
> {}
export const StartSentimentDetectionJob =
  Binding.Service<StartSentimentDetectionJob>(
    "AWS.Comprehend.StartSentimentDetectionJob",
  );
