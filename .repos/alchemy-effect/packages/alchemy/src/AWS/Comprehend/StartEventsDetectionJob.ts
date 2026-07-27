import type * as comprehend from "@distilled.cloud/aws/comprehend";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Role } from "../IAM/Role.ts";

/**
 * `StartEventsDetectionJob` request with `DataAccessRoleArn` defaulting to the role the
 * binding was constructed with.
 */
export interface StartEventsDetectionJobRequest extends Omit<
  comprehend.StartEventsDetectionJobRequest,
  "DataAccessRoleArn"
> {
  /**
   * IAM role Amazon Comprehend assumes to read the input documents and write
   * the results.
   * @default the data-access role bound via `StartEventsDetectionJob(role)`
   */
  DataAccessRoleArn?: string;
}

/**
 * Runtime binding for `comprehend:StartEventsDetectionJob` — start an asynchronous
 * event detection job over a collection of documents in S3.
 *
 * The binding is constructed with the **data-access role** (the IAM role
 * Amazon Comprehend assumes to read the input documents and write results;
 * its trust policy must allow `comprehend.amazonaws.com`). The role's ARN is
 * injected as `DataAccessRoleArn` on every runtime request and the host is
 * granted `iam:PassRole` on it alongside the `comprehend:StartEventsDetectionJob`
 * action (which has no resource-level IAM). Track the job with
 * {@link DescribeEventsDetectionJob} and stop it with
 * {@link StopEventsDetectionJob}.
 *
 * @binding
 * @section Starting Analysis Jobs
 * @example Start an Asynchronous Events Detection Job
 * ```typescript
 * // deploy time — bind the Comprehend data-access role
 * const startEventsDetectionJob = yield* AWS.Comprehend.StartEventsDetectionJob(dataAccessRole);
 *
 * // runtime
 * const job = yield* startEventsDetectionJob({
 *   TargetEventTypes: ["BANKRUPTCY", "EMPLOYMENT"],
 *   InputDataConfig: { S3Uri: "s3://my-bucket/input/", InputFormat: "ONE_DOC_PER_LINE" },
 *   OutputDataConfig: { S3Uri: "s3://my-bucket/output/" },
 *   LanguageCode: "en",
 * });
 * // job.JobId, job.JobStatus === "SUBMITTED"
 * ```
 */
export interface StartEventsDetectionJob extends Binding.Service<
  StartEventsDetectionJob,
  "AWS.Comprehend.StartEventsDetectionJob",
  <R extends Role>(
    dataAccessRole: R,
  ) => Effect.Effect<
    (
      request: StartEventsDetectionJobRequest,
    ) => Effect.Effect<
      comprehend.StartEventsDetectionJobResponse,
      comprehend.StartEventsDetectionJobError
    >
  >
> {}
export const StartEventsDetectionJob = Binding.Service<StartEventsDetectionJob>(
  "AWS.Comprehend.StartEventsDetectionJob",
);
