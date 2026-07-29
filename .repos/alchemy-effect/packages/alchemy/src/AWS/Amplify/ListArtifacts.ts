import type * as amplify from "@distilled.cloud/aws/amplify";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { App } from "./App.ts";

export interface ListArtifactsRequest extends Omit<
  amplify.ListArtifactsRequest,
  "appId"
> {}

/**
 * Runtime binding for `amplify:ListArtifacts`.
 *
 * Bind an {@link App} in the function's init phase to get a callable that
 * lists the artifacts (e.g. test reports) a build job produced. Fetch an
 * individual artifact with {@link GetArtifactUrl}. Provide the implementation
 * with `Effect.provide(AWS.Amplify.ListArtifactsHttp)`.
 * @binding
 * @section Reading Artifacts
 * @example List a Job's Artifacts
 * ```typescript
 * // init — bind the operation to the app
 * const listArtifacts = yield* AWS.Amplify.ListArtifacts(app);
 *
 * // runtime
 * const { artifacts } = yield* listArtifacts({
 *   branchName: "main",
 *   jobId: "42",
 * });
 * ```
 */
export interface ListArtifacts extends Binding.Service<
  ListArtifacts,
  "AWS.Amplify.ListArtifacts",
  (
    app: App,
  ) => Effect.Effect<
    (
      request: ListArtifactsRequest,
    ) => Effect.Effect<amplify.ListArtifactsResult, amplify.ListArtifactsError>
  >
> {}

export const ListArtifacts = Binding.Service<ListArtifacts>(
  "AWS.Amplify.ListArtifacts",
);
