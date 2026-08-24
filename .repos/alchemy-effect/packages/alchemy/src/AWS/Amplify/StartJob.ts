import type * as amplify from "@distilled.cloud/aws/amplify";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { App } from "./App.ts";

export interface StartJobRequest extends Omit<
  amplify.StartJobRequest,
  "appId"
> {}

/**
 * Runtime binding for `amplify:StartJob`.
 *
 * Bind an {@link App} in the function's init phase to get a callable that
 * starts a build/deploy job for one of the app's branches — the app id is
 * injected automatically and `amplify:StartJob` is granted on the app's jobs.
 * Provide the implementation with `Effect.provide(AWS.Amplify.StartJobHttp)`.
 *
 * The canonical use is a webhook Lambda that rebuilds the site when upstream
 * content changes (a CMS publish, a data refresh, etc.).
 * @binding
 * @section Starting Jobs
 * @example Rebuild a Branch on Content Change
 * ```typescript
 * // init — bind the operation to the app
 * const startJob = yield* AWS.Amplify.StartJob(app);
 *
 * // runtime — kick off a release of the main branch
 * const { jobSummary } = yield* startJob({
 *   branchName: "main",
 *   jobType: "RELEASE",
 *   jobReason: "CMS content published",
 * });
 * ```
 */
export interface StartJob extends Binding.Service<
  StartJob,
  "AWS.Amplify.StartJob",
  (
    app: App,
  ) => Effect.Effect<
    (
      request: StartJobRequest,
    ) => Effect.Effect<amplify.StartJobResult, amplify.StartJobError>
  >
> {}

export const StartJob = Binding.Service<StartJob>("AWS.Amplify.StartJob");
