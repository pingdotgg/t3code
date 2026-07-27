import type * as amplify from "@distilled.cloud/aws/amplify";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { App } from "./App.ts";

export interface GetArtifactUrlRequest extends amplify.GetArtifactUrlRequest {}

/**
 * Runtime binding for `amplify:GetArtifactUrl`.
 *
 * Bind an {@link App} in the function's init phase to get a callable that
 * resolves a pre-signed download URL for a build artifact discovered via
 * {@link ListArtifacts}. Provide the implementation with
 * `Effect.provide(AWS.Amplify.GetArtifactUrlHttp)`.
 * @binding
 * @section Reading Artifacts
 * @example Download a Job Artifact
 * ```typescript
 * // init — bind the operation to the app
 * const listArtifacts = yield* AWS.Amplify.ListArtifacts(app);
 * const getArtifactUrl = yield* AWS.Amplify.GetArtifactUrl(app);
 *
 * // runtime — resolve a pre-signed URL for the first artifact
 * const { artifacts } = yield* listArtifacts({
 *   branchName: "main",
 *   jobId: "42",
 * });
 * const { artifactUrl } = yield* getArtifactUrl({
 *   artifactId: artifacts[0].artifactId,
 * });
 * ```
 */
export interface GetArtifactUrl extends Binding.Service<
  GetArtifactUrl,
  "AWS.Amplify.GetArtifactUrl",
  (
    app: App,
  ) => Effect.Effect<
    (
      request: GetArtifactUrlRequest,
    ) => Effect.Effect<
      amplify.GetArtifactUrlResult,
      amplify.GetArtifactUrlError
    >
  >
> {}

export const GetArtifactUrl = Binding.Service<GetArtifactUrl>(
  "AWS.Amplify.GetArtifactUrl",
);
