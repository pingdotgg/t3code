import type * as imagebuilder from "@distilled.cloud/aws/imagebuilder";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `imagebuilder:ListImageBuildVersions`.
 *
 * Lists the build versions of an image version (`…:image/{name}/{version}`),
 * newest first — each entry reports its state, so a function can find the
 * latest `AVAILABLE` build of an image. Image versions are created
 * dynamically by pipeline runs, so this is an account-level binding.
 * Provide the implementation with
 * `Effect.provide(AWS.ImageBuilder.ListImageBuildVersionsHttp)`.
 * @binding
 * @section Observing Builds
 * @example List the Builds of an Image Version
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listImageBuildVersions =
 *   yield* AWS.ImageBuilder.ListImageBuildVersions();
 *
 * // runtime
 * const { imageSummaryList } = yield* listImageBuildVersions({
 *   imageVersionArn,
 * });
 * ```
 */
export interface ListImageBuildVersions extends Binding.Service<
  ListImageBuildVersions,
  "AWS.ImageBuilder.ListImageBuildVersions",
  () => Effect.Effect<
    (
      request: imagebuilder.ListImageBuildVersionsRequest,
    ) => Effect.Effect<
      imagebuilder.ListImageBuildVersionsResponse,
      imagebuilder.ListImageBuildVersionsError
    >
  >
> {}
export const ListImageBuildVersions = Binding.Service<ListImageBuildVersions>(
  "AWS.ImageBuilder.ListImageBuildVersions",
);
