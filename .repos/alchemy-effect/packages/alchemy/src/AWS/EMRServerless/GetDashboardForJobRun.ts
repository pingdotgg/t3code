import type * as emr from "@distilled.cloud/aws/emr-serverless";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Application } from "./Application.ts";

/**
 * Request accepted by the {@link GetDashboardForJobRun} runtime callable.
 * The `applicationId` is injected from the bound {@link Application}.
 */
export type GetDashboardForJobRunInput = Omit<
  emr.GetDashboardForJobRunRequest,
  "applicationId"
>;

/**
 * Runtime binding for `emr-serverless:GetDashboardForJobRun`.
 *
 * Creates a pre-signed URL to the live Spark/Tez UI (or Spark History
 * Server) for a job run on the bound {@link Application} — hand it to an
 * on-call engineer to debug a slow or failed job without console access.
 * Provide the implementation with
 * `Effect.provide(AWS.EMRServerless.GetDashboardForJobRunHttp)`.
 * @binding
 * @section Dashboards
 * @example Link To A Job's Spark UI
 * ```typescript
 * // init
 * const getDashboardForJobRun =
 *   yield* AWS.EMRServerless.GetDashboardForJobRun(app);
 *
 * // runtime
 * const { url } = yield* getDashboardForJobRun({ jobRunId });
 * ```
 */
export interface GetDashboardForJobRun extends Binding.Service<
  GetDashboardForJobRun,
  "AWS.EMRServerless.GetDashboardForJobRun",
  (
    application: Application,
  ) => Effect.Effect<
    (
      request: GetDashboardForJobRunInput,
    ) => Effect.Effect<
      emr.GetDashboardForJobRunResponse,
      emr.GetDashboardForJobRunError
    >
  >
> {}
export const GetDashboardForJobRun = Binding.Service<GetDashboardForJobRun>(
  "AWS.EMRServerless.GetDashboardForJobRun",
);
