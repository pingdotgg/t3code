import type * as comprehend from "@distilled.cloud/aws/comprehend";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Role } from "../IAM/Role.ts";

/**
 * `StartDocumentClassificationJob` request with `DataAccessRoleArn` defaulting to the role the
 * binding was constructed with.
 */
export interface StartDocumentClassificationJobRequest extends Omit<
  comprehend.StartDocumentClassificationJobRequest,
  "DataAccessRoleArn"
> {
  /**
   * IAM role Amazon Comprehend assumes to read the input documents and write
   * the results.
   * @default the data-access role bound via `StartDocumentClassificationJob(role)`
   */
  DataAccessRoleArn?: string;
}

/**
 * Runtime binding for `comprehend:StartDocumentClassificationJob` — start an asynchronous
 * document classification job over a collection of documents in S3.
 *
 * The binding is constructed with the **data-access role** (the IAM role
 * Amazon Comprehend assumes to read the input documents and write results;
 * its trust policy must allow `comprehend.amazonaws.com`). The role's ARN is
 * injected as `DataAccessRoleArn` on every runtime request and the host is
 * granted `iam:PassRole` on it alongside the `comprehend:StartDocumentClassificationJob`
 * action (which has no resource-level IAM). Track the job with
 * {@link DescribeDocumentClassificationJob}.
 *
 * @binding
 * @section Starting Analysis Jobs
 * @example Start an Asynchronous Document Classification Job
 * ```typescript
 * // deploy time — bind the Comprehend data-access role
 * const startDocumentClassificationJob = yield* AWS.Comprehend.StartDocumentClassificationJob(dataAccessRole);
 *
 * // runtime
 * const job = yield* startDocumentClassificationJob({
 *   DocumentClassifierArn: classifierArn,
 *   InputDataConfig: { S3Uri: "s3://my-bucket/input/", InputFormat: "ONE_DOC_PER_LINE" },
 *   OutputDataConfig: { S3Uri: "s3://my-bucket/output/" },
 * });
 * // job.JobId, job.JobStatus === "SUBMITTED"
 * ```
 */
export interface StartDocumentClassificationJob extends Binding.Service<
  StartDocumentClassificationJob,
  "AWS.Comprehend.StartDocumentClassificationJob",
  <R extends Role>(
    dataAccessRole: R,
  ) => Effect.Effect<
    (
      request: StartDocumentClassificationJobRequest,
    ) => Effect.Effect<
      comprehend.StartDocumentClassificationJobResponse,
      comprehend.StartDocumentClassificationJobError
    >
  >
> {}
export const StartDocumentClassificationJob =
  Binding.Service<StartDocumentClassificationJob>(
    "AWS.Comprehend.StartDocumentClassificationJob",
  );
