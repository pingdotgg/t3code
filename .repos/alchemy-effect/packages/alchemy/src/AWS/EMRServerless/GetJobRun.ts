import type * as emr from "@distilled.cloud/aws/emr-serverless";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Application } from "./Application.ts";

/**
 * Request accepted by the {@link GetJobRun} runtime callable. The
 * `applicationId` is injected from the bound {@link Application}.
 */
export type GetJobRunInput = Omit<emr.GetJobRunRequest, "applicationId">;

/**
 * Runtime binding for `emr-serverless:GetJobRun`.
 *
 * Reads a job run's full detail on the bound {@link Application} — state,
 * driver, resource utilization, timeout — so a function can poll a submitted
 * job to completion or inspect why it failed. Provide the implementation
 * with `Effect.provide(AWS.EMRServerless.GetJobRunHttp)`.
 * @binding
 * @section Running Jobs
 * @example Poll A Job Run
 * ```typescript
 * // init
 * const getJobRun = yield* AWS.EMRServerless.GetJobRun(app);
 *
 * // runtime
 * const { jobRun } = yield* getJobRun({ jobRunId });
 * yield* Effect.log(`${jobRun.jobRunId} is ${jobRun.state}`);
 * ```
 */
export interface GetJobRun extends Binding.Service<
  GetJobRun,
  "AWS.EMRServerless.GetJobRun",
  (
    application: Application,
  ) => Effect.Effect<
    (
      request: GetJobRunInput,
    ) => Effect.Effect<emr.GetJobRunResponse, emr.GetJobRunError>
  >
> {}
export const GetJobRun = Binding.Service<GetJobRun>(
  "AWS.EMRServerless.GetJobRun",
);
