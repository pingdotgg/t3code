import type * as amplify from "@distilled.cloud/aws/amplify";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { App } from "./App.ts";

export interface CreateDeploymentRequest extends Omit<
  amplify.CreateDeploymentRequest,
  "appId"
> {}

/**
 * Runtime binding for `amplify:CreateDeployment`.
 *
 * Bind an {@link App} in the function's init phase to get a callable that
 * creates a manual deployment for a branch of an app with no connected
 * repository. The result carries pre-signed upload URLs (`zipUploadUrl`, or
 * per-file `fileUploadUrls` when a `fileMap` of MD5 hashes is supplied);
 * upload the content there, then release it with {@link StartDeployment}.
 * Provide the implementation with
 * `Effect.provide(AWS.Amplify.CreateDeploymentHttp)`.
 * @binding
 * @section Manual Deployments
 * @example Stage a Zip Deployment
 * ```typescript
 * // init — bind the operation to the app
 * const createDeployment = yield* AWS.Amplify.CreateDeployment(app);
 *
 * // runtime — obtain the upload URL for the deployment artifact
 * const { jobId, zipUploadUrl } = yield* createDeployment({
 *   branchName: "main",
 * });
 * // PUT the site zip to `zipUploadUrl`, then start the deployment with jobId
 * ```
 */
export interface CreateDeployment extends Binding.Service<
  CreateDeployment,
  "AWS.Amplify.CreateDeployment",
  (
    app: App,
  ) => Effect.Effect<
    (
      request: CreateDeploymentRequest,
    ) => Effect.Effect<
      amplify.CreateDeploymentResult,
      amplify.CreateDeploymentError
    >
  >
> {}

export const CreateDeployment = Binding.Service<CreateDeployment>(
  "AWS.Amplify.CreateDeployment",
);
