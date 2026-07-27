import type * as comprehend from "@distilled.cloud/aws/comprehend";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Role } from "../IAM/Role.ts";

/**
 * `StartPiiEntitiesDetectionJob` request with `DataAccessRoleArn` defaulting to the role the
 * binding was constructed with.
 */
export interface StartPiiEntitiesDetectionJobRequest extends Omit<
  comprehend.StartPiiEntitiesDetectionJobRequest,
  "DataAccessRoleArn"
> {
  /**
   * IAM role Amazon Comprehend assumes to read the input documents and write
   * the results.
   * @default the data-access role bound via `StartPiiEntitiesDetectionJob(role)`
   */
  DataAccessRoleArn?: string;
}

/**
 * Runtime binding for `comprehend:StartPiiEntitiesDetectionJob` — start an asynchronous
 * PII entity detection job over a collection of documents in S3.
 *
 * The binding is constructed with the **data-access role** (the IAM role
 * Amazon Comprehend assumes to read the input documents and write results;
 * its trust policy must allow `comprehend.amazonaws.com`). The role's ARN is
 * injected as `DataAccessRoleArn` on every runtime request and the host is
 * granted `iam:PassRole` on it alongside the `comprehend:StartPiiEntitiesDetectionJob`
 * action (which has no resource-level IAM). Track the job with
 * {@link DescribePiiEntitiesDetectionJob} and stop it with
 * {@link StopPiiEntitiesDetectionJob}.
 *
 * @binding
 * @section Starting Analysis Jobs
 * @example Start an Asynchronous PiiEntities Detection Job
 * ```typescript
 * // deploy time — bind the Comprehend data-access role
 * const startPiiEntitiesDetectionJob = yield* AWS.Comprehend.StartPiiEntitiesDetectionJob(dataAccessRole);
 *
 * // runtime
 * const job = yield* startPiiEntitiesDetectionJob({
 *   InputDataConfig: { S3Uri: "s3://my-bucket/input/", InputFormat: "ONE_DOC_PER_LINE" },
 *   OutputDataConfig: { S3Uri: "s3://my-bucket/output/" },
 *   LanguageCode: "en",
 * });
 * // job.JobId, job.JobStatus === "SUBMITTED"
 * ```
 */
export interface StartPiiEntitiesDetectionJob extends Binding.Service<
  StartPiiEntitiesDetectionJob,
  "AWS.Comprehend.StartPiiEntitiesDetectionJob",
  <R extends Role>(
    dataAccessRole: R,
  ) => Effect.Effect<
    (
      request: StartPiiEntitiesDetectionJobRequest,
    ) => Effect.Effect<
      comprehend.StartPiiEntitiesDetectionJobResponse,
      comprehend.StartPiiEntitiesDetectionJobError
    >
  >
> {}
export const StartPiiEntitiesDetectionJob =
  Binding.Service<StartPiiEntitiesDetectionJob>(
    "AWS.Comprehend.StartPiiEntitiesDetectionJob",
  );
