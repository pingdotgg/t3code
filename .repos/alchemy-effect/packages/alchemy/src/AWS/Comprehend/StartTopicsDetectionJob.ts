import type * as comprehend from "@distilled.cloud/aws/comprehend";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Role } from "../IAM/Role.ts";

/**
 * `StartTopicsDetectionJob` request with `DataAccessRoleArn` defaulting to the role the
 * binding was constructed with.
 */
export interface StartTopicsDetectionJobRequest extends Omit<
  comprehend.StartTopicsDetectionJobRequest,
  "DataAccessRoleArn"
> {
  /**
   * IAM role Amazon Comprehend assumes to read the input documents and write
   * the results.
   * @default the data-access role bound via `StartTopicsDetectionJob(role)`
   */
  DataAccessRoleArn?: string;
}

/**
 * Runtime binding for `comprehend:StartTopicsDetectionJob` — start an asynchronous
 * topic modeling job over a collection of documents in S3.
 *
 * The binding is constructed with the **data-access role** (the IAM role
 * Amazon Comprehend assumes to read the input documents and write results;
 * its trust policy must allow `comprehend.amazonaws.com`). The role's ARN is
 * injected as `DataAccessRoleArn` on every runtime request and the host is
 * granted `iam:PassRole` on it alongside the `comprehend:StartTopicsDetectionJob`
 * action (which has no resource-level IAM). Track the job with
 * {@link DescribeTopicsDetectionJob}.
 *
 * @binding
 * @section Starting Analysis Jobs
 * @example Start a Topic Modeling Job
 * ```typescript
 * // deploy time — bind the Comprehend data-access role
 * const startTopicsDetectionJob = yield* AWS.Comprehend.StartTopicsDetectionJob(dataAccessRole);
 *
 * // runtime
 * const job = yield* startTopicsDetectionJob({
 *   InputDataConfig: { S3Uri: "s3://my-bucket/input/", InputFormat: "ONE_DOC_PER_LINE" },
 *   OutputDataConfig: { S3Uri: "s3://my-bucket/output/" },
 * });
 * // job.JobId, job.JobStatus === "SUBMITTED"
 * ```
 */
export interface StartTopicsDetectionJob extends Binding.Service<
  StartTopicsDetectionJob,
  "AWS.Comprehend.StartTopicsDetectionJob",
  <R extends Role>(
    dataAccessRole: R,
  ) => Effect.Effect<
    (
      request: StartTopicsDetectionJobRequest,
    ) => Effect.Effect<
      comprehend.StartTopicsDetectionJobResponse,
      comprehend.StartTopicsDetectionJobError
    >
  >
> {}
export const StartTopicsDetectionJob = Binding.Service<StartTopicsDetectionJob>(
  "AWS.Comprehend.StartTopicsDetectionJob",
);
