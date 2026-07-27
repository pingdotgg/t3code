import type * as amplify from "@distilled.cloud/aws/amplify";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { App } from "./App.ts";

export interface ListJobsRequest extends Omit<
  amplify.ListJobsRequest,
  "appId"
> {}

/**
 * Runtime binding for `amplify:ListJobs`.
 *
 * Bind an {@link App} in the function's init phase to get a callable that
 * lists the build jobs of one of the app's branches, newest first. Provide the
 * implementation with `Effect.provide(AWS.Amplify.ListJobsHttp)`.
 * @binding
 * @section Observing Jobs
 * @example Read the Latest Job of a Branch
 * ```typescript
 * // init — bind the operation to the app
 * const listJobs = yield* AWS.Amplify.ListJobs(app);
 *
 * // runtime — the first summary is the most recent job
 * const { jobSummaries } = yield* listJobs({
 *   branchName: "main",
 *   maxResults: 1,
 * });
 * const latest = jobSummaries[0];
 * ```
 */
export interface ListJobs extends Binding.Service<
  ListJobs,
  "AWS.Amplify.ListJobs",
  (
    app: App,
  ) => Effect.Effect<
    (
      request: ListJobsRequest,
    ) => Effect.Effect<amplify.ListJobsResult, amplify.ListJobsError>
  >
> {}

export const ListJobs = Binding.Service<ListJobs>("AWS.Amplify.ListJobs");
