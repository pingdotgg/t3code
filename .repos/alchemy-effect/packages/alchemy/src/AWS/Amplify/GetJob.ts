import type * as amplify from "@distilled.cloud/aws/amplify";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { App } from "./App.ts";

export interface GetJobRequest extends Omit<amplify.GetJobRequest, "appId"> {}

/**
 * Runtime binding for `amplify:GetJob`.
 *
 * Bind an {@link App} in the function's init phase to get a callable that
 * reads a build job — its summary and per-step logs/status — for one of the
 * app's branches. Provide the implementation with
 * `Effect.provide(AWS.Amplify.GetJobHttp)`.
 * @binding
 * @section Observing Jobs
 * @example Poll a Job Until It Settles
 * ```typescript
 * // init — bind the operation to the app
 * const getJob = yield* AWS.Amplify.GetJob(app);
 *
 * // runtime — read the job's current status
 * const { job } = yield* getJob({ branchName: "main", jobId: "42" });
 * if (job.summary.status === "FAILED") {
 *   yield* Effect.log(`build failed: ${job.summary.jobId}`);
 * }
 * ```
 */
export interface GetJob extends Binding.Service<
  GetJob,
  "AWS.Amplify.GetJob",
  (
    app: App,
  ) => Effect.Effect<
    (
      request: GetJobRequest,
    ) => Effect.Effect<amplify.GetJobResult, amplify.GetJobError>
  >
> {}

export const GetJob = Binding.Service<GetJob>("AWS.Amplify.GetJob");
