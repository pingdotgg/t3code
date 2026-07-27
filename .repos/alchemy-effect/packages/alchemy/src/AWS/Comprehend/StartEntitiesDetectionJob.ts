import type * as comprehend from "@distilled.cloud/aws/comprehend";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Role } from "../IAM/Role.ts";

/**
 * `StartEntitiesDetectionJob` request with `DataAccessRoleArn` defaulting to the role the
 * binding was constructed with.
 */
export interface StartEntitiesDetectionJobRequest extends Omit<
  comprehend.StartEntitiesDetectionJobRequest,
  "DataAccessRoleArn"
> {
  /**
   * IAM role Amazon Comprehend assumes to read the input documents and write
   * the results.
   * @default the data-access role bound via `StartEntitiesDetectionJob(role)`
   */
  DataAccessRoleArn?: string;
}

/**
 * Runtime binding for `comprehend:StartEntitiesDetectionJob` — start an asynchronous
 * entity detection job over a collection of documents in S3.
 *
 * The binding is constructed with the **data-access role** (the IAM role
 * Amazon Comprehend assumes to read the input documents and write results;
 * its trust policy must allow `comprehend.amazonaws.com`). The role's ARN is
 * injected as `DataAccessRoleArn` on every runtime request and the host is
 * granted `iam:PassRole` on it alongside the `comprehend:StartEntitiesDetectionJob`
 * action (which has no resource-level IAM). Track the job with
 * {@link DescribeEntitiesDetectionJob} and stop it with
 * {@link StopEntitiesDetectionJob}.
 *
 * @binding
 * @section Starting Analysis Jobs
 * @example Start an Asynchronous Entities Detection Job
 * ```typescript
 * // deploy time — bind the Comprehend data-access role
 * const startEntitiesDetectionJob = yield* AWS.Comprehend.StartEntitiesDetectionJob(dataAccessRole);
 *
 * // runtime
 * const job = yield* startEntitiesDetectionJob({
 *   InputDataConfig: { S3Uri: "s3://my-bucket/input/", InputFormat: "ONE_DOC_PER_LINE" },
 *   OutputDataConfig: { S3Uri: "s3://my-bucket/output/" },
 *   LanguageCode: "en",
 * });
 * // job.JobId, job.JobStatus === "SUBMITTED"
 * ```
 */
export interface StartEntitiesDetectionJob extends Binding.Service<
  StartEntitiesDetectionJob,
  "AWS.Comprehend.StartEntitiesDetectionJob",
  <R extends Role>(
    dataAccessRole: R,
  ) => Effect.Effect<
    (
      request: StartEntitiesDetectionJobRequest,
    ) => Effect.Effect<
      comprehend.StartEntitiesDetectionJobResponse,
      comprehend.StartEntitiesDetectionJobError
    >
  >
> {}
export const StartEntitiesDetectionJob =
  Binding.Service<StartEntitiesDetectionJob>(
    "AWS.Comprehend.StartEntitiesDetectionJob",
  );
