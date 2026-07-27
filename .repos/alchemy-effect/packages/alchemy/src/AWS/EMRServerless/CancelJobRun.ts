import type * as emr from "@distilled.cloud/aws/emr-serverless";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Application } from "./Application.ts";

/**
 * Request accepted by the {@link CancelJobRun} runtime callable. The
 * `applicationId` is injected from the bound {@link Application}.
 */
export type CancelJobRunInput = Omit<emr.CancelJobRunRequest, "applicationId">;

/**
 * Runtime binding for `emr-serverless:CancelJobRun`.
 *
 * Cancels a running or queued job run on the bound {@link Application} — the
 * kill switch for a runaway or superseded job. Provide the implementation
 * with `Effect.provide(AWS.EMRServerless.CancelJobRunHttp)`.
 * @binding
 * @section Running Jobs
 * @example Cancel A Job Run
 * ```typescript
 * // init
 * const cancelJobRun = yield* AWS.EMRServerless.CancelJobRun(app);
 *
 * // runtime
 * yield* cancelJobRun({ jobRunId });
 * ```
 */
export interface CancelJobRun extends Binding.Service<
  CancelJobRun,
  "AWS.EMRServerless.CancelJobRun",
  (
    application: Application,
  ) => Effect.Effect<
    (
      request: CancelJobRunInput,
    ) => Effect.Effect<emr.CancelJobRunResponse, emr.CancelJobRunError>
  >
> {}
export const CancelJobRun = Binding.Service<CancelJobRun>(
  "AWS.EMRServerless.CancelJobRun",
);
