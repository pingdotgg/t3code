import type * as amplify from "@distilled.cloud/aws/amplify";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { App } from "./App.ts";

export interface StartDeploymentRequest extends Omit<
  amplify.StartDeploymentRequest,
  "appId"
> {}

/**
 * Runtime binding for `amplify:StartDeployment`.
 *
 * Bind an {@link App} in the function's init phase to get a callable that
 * releases a manual deployment on a branch of an app with no connected
 * repository — either a deployment staged with {@link CreateDeployment}
 * (`jobId`) or content fetched from a public `sourceUrl` (zip URL or S3
 * prefix). Provide the implementation with
 * `Effect.provide(AWS.Amplify.StartDeploymentHttp)`.
 * @binding
 * @section Manual Deployments
 * @example Release a Staged Deployment
 * ```typescript
 * // init — bind the operation to the app
 * const startDeployment = yield* AWS.Amplify.StartDeployment(app);
 *
 * // runtime — release the artifact uploaded via CreateDeployment
 * const { jobSummary } = yield* startDeployment({
 *   branchName: "main",
 *   jobId,
 * });
 * ```
 *
 * @example Deploy Directly from an S3 Prefix
 * ```typescript
 * const { jobSummary } = yield* startDeployment({
 *   branchName: "main",
 *   sourceUrl: "s3://my-site-artifacts/latest/",
 *   sourceUrlType: "BUCKET_PREFIX",
 * });
 * ```
 */
export interface StartDeployment extends Binding.Service<
  StartDeployment,
  "AWS.Amplify.StartDeployment",
  (
    app: App,
  ) => Effect.Effect<
    (
      request: StartDeploymentRequest,
    ) => Effect.Effect<
      amplify.StartDeploymentResult,
      amplify.StartDeploymentError
    >
  >
> {}

export const StartDeployment = Binding.Service<StartDeployment>(
  "AWS.Amplify.StartDeployment",
);
