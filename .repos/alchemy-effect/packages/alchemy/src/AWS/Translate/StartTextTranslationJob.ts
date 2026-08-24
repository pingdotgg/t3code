import type * as translate from "@distilled.cloud/aws/translate";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Role } from "../IAM/Role.ts";

/**
 * `StartTextTranslationJob` request with `DataAccessRoleArn` defaulting to
 * the role the binding was constructed with.
 */
export interface StartTextTranslationJobRequest extends Omit<
  translate.StartTextTranslationJobRequest,
  "DataAccessRoleArn" | "ClientToken"
> {
  /**
   * IAM role Amazon Translate assumes to read the input documents from S3
   * and write the translated results.
   * @default the data-access role bound via `StartTextTranslationJob(role)`
   */
  DataAccessRoleArn?: string;
  /**
   * Idempotency token for the job.
   * @default an auto-generated token
   */
  ClientToken?: string;
}

/**
 * Runtime binding for `translate:StartTextTranslationJob` — start an
 * asynchronous batch translation job over a collection of documents in S3.
 *
 * The binding is constructed with the **data-access role** (the IAM role
 * Amazon Translate assumes to read the input documents and write results;
 * its trust policy must allow `translate.amazonaws.com`). The role's ARN is
 * injected as `DataAccessRoleArn` on every runtime request and the host is
 * granted `iam:PassRole` on it alongside
 * `translate:StartTextTranslationJob` (which has no resource-level IAM).
 * Track the job with {@link DescribeTextTranslationJob} and stop it with
 * {@link StopTextTranslationJob}.
 *
 * @binding
 * @section Batch Translation Jobs
 * @example Start a batch translation job
 * ```typescript
 * // deploy time — bind the Translate data-access role
 * const startJob = yield* AWS.Translate.StartTextTranslationJob(dataAccessRole);
 *
 * // runtime
 * const job = yield* startJob({
 *   InputDataConfig: { S3Uri: "s3://my-bucket/input/", ContentType: "text/plain" },
 *   OutputDataConfig: { S3Uri: "s3://my-bucket/output/" },
 *   SourceLanguageCode: "en",
 *   TargetLanguageCodes: ["es"],
 * });
 * // job.JobId, job.JobStatus === "SUBMITTED"
 * ```
 */
export interface StartTextTranslationJob extends Binding.Service<
  StartTextTranslationJob,
  "AWS.Translate.StartTextTranslationJob",
  <R extends Role>(
    dataAccessRole: R,
  ) => Effect.Effect<
    (
      request: StartTextTranslationJobRequest,
    ) => Effect.Effect<
      translate.StartTextTranslationJobResponse,
      translate.StartTextTranslationJobError
    >
  >
> {}
export const StartTextTranslationJob = Binding.Service<StartTextTranslationJob>(
  "AWS.Translate.StartTextTranslationJob",
);
