import type * as emr from "@distilled.cloud/aws/emr-serverless";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Application } from "./Application.ts";

/**
 * Request accepted by the {@link StartJobRun} runtime callable. The
 * `applicationId` is injected from the bound {@link Application}; the
 * idempotency `clientToken` is auto-generated when omitted.
 */
export type StartJobRunInput = Omit<
  emr.StartJobRunRequest,
  "applicationId" | "clientToken"
> & {
  /**
   * Idempotency token deduplicating retried submissions.
   * @default a generated UUID per call
   */
  clientToken?: string;
};

/**
 * Runtime binding for `emr-serverless:StartJobRun`.
 *
 * Submits a Spark or Hive job to the bound {@link Application} — the
 * serverless equivalent of `spark-submit`. The application id is injected
 * from the binding; the caller supplies the job driver, the execution role
 * the job assumes, and optional configuration overrides. Grants
 * `iam:PassRole` (conditioned to `emr-serverless.amazonaws.com`) so the
 * function can hand the service the execution role. Provide the
 * implementation with `Effect.provide(AWS.EMRServerless.StartJobRunHttp)`.
 * @binding
 * @section Running Jobs
 * @example Submit A Spark Job
 * ```typescript
 * // init — bind the operation to the application
 * const startJobRun = yield* AWS.EMRServerless.StartJobRun(app);
 *
 * // runtime
 * const run = yield* startJobRun({
 *   executionRoleArn: jobRoleArn,
 *   jobDriver: {
 *     sparkSubmit: {
 *       entryPoint: "s3://my-scripts/etl.py",
 *       entryPointArguments: ["--date", "2026-07-14"],
 *     },
 *   },
 *   executionTimeoutMinutes: 60,
 * });
 * yield* Effect.log(`started ${run.jobRunId}`);
 * ```
 */
export interface StartJobRun extends Binding.Service<
  StartJobRun,
  "AWS.EMRServerless.StartJobRun",
  (
    application: Application,
  ) => Effect.Effect<
    (
      request: StartJobRunInput,
    ) => Effect.Effect<emr.StartJobRunResponse, emr.StartJobRunError>
  >
> {}
export const StartJobRun = Binding.Service<StartJobRun>(
  "AWS.EMRServerless.StartJobRun",
);
