import type * as imagebuilder from "@distilled.cloud/aws/imagebuilder";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `imagebuilder:ListImagePackages`.
 *
 * Lists the OS packages that Systems Manager Inventory recorded inside an
 * image at build time (only available once the build is `AVAILABLE`). Build
 * versions are created dynamically by pipeline runs, so this is an
 * account-level binding. Provide the implementation with
 * `Effect.provide(AWS.ImageBuilder.ListImagePackagesHttp)`.
 * @binding
 * @section Observing Builds
 * @example List the Packages Inside a Built Image
 * ```typescript
 * // init — account-level binding, no resource argument
 * const listImagePackages = yield* AWS.ImageBuilder.ListImagePackages();
 *
 * // runtime
 * const { imagePackageList } = yield* listImagePackages({
 *   imageBuildVersionArn,
 * });
 * ```
 */
export interface ListImagePackages extends Binding.Service<
  ListImagePackages,
  "AWS.ImageBuilder.ListImagePackages",
  () => Effect.Effect<
    (
      request: imagebuilder.ListImagePackagesRequest,
    ) => Effect.Effect<
      imagebuilder.ListImagePackagesResponse,
      imagebuilder.ListImagePackagesError
    >
  >
> {}
export const ListImagePackages = Binding.Service<ListImagePackages>(
  "AWS.ImageBuilder.ListImagePackages",
);
