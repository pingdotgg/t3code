import type * as amplify from "@distilled.cloud/aws/amplify";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { App } from "./App.ts";

export interface StopJobRequest extends Omit<amplify.StopJobRequest, "appId"> {}

/**
 * Runtime binding for `amplify:StopJob`.
 *
 * Bind an {@link App} in the function's init phase to get a callable that
 * cancels an in-progress build job on one of the app's branches. Provide the
 * implementation with `Effect.provide(AWS.Amplify.StopJobHttp)`.
 * @binding
 * @section Controlling Jobs
 * @example Cancel a Running Build
 * ```typescript
 * // init — bind the operation to the app
 * const stopJob = yield* AWS.Amplify.StopJob(app);
 *
 * // runtime — cancel the job
 * const { jobSummary } = yield* stopJob({
 *   branchName: "main",
 *   jobId: "42",
 * });
 * ```
 */
export interface StopJob extends Binding.Service<
  StopJob,
  "AWS.Amplify.StopJob",
  (
    app: App,
  ) => Effect.Effect<
    (
      request: StopJobRequest,
    ) => Effect.Effect<amplify.StopJobResult, amplify.StopJobError>
  >
> {}

export const StopJob = Binding.Service<StopJob>("AWS.Amplify.StopJob");
