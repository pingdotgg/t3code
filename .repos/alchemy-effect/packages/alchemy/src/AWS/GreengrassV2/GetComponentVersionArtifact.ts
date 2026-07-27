import type * as greengrassv2 from "@distilled.cloud/aws/greengrassv2";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { ComponentVersion } from "./ComponentVersion.ts";

/**
 * Runtime binding for `greengrass:GetComponentVersionArtifact`.
 *
 * Mints a pre-signed download URL for one of the bound
 * {@link ComponentVersion}'s artifacts (the same API core devices use to
 * fetch artifacts during installation). The component version ARN is
 * injected from the binding; the caller names the artifact. Provide the
 * implementation with
 * `Effect.provide(AWS.GreengrassV2.GetComponentVersionArtifactHttp)`.
 * @binding
 * @section Reading Components
 * @example Mint An Artifact Download URL
 * ```typescript
 * // init — bind the operation to the component version
 * const getArtifact = yield* AWS.GreengrassV2.GetComponentVersionArtifact(component);
 *
 * // runtime
 * const { preSignedUrl } = yield* getArtifact({ artifactName: "installer.zip" });
 * ```
 */
export interface GetComponentVersionArtifact extends Binding.Service<
  GetComponentVersionArtifact,
  "AWS.GreengrassV2.GetComponentVersionArtifact",
  (
    component: ComponentVersion,
  ) => Effect.Effect<
    (
      request: Omit<greengrassv2.GetComponentVersionArtifactRequest, "arn">,
    ) => Effect.Effect<
      greengrassv2.GetComponentVersionArtifactResponse,
      greengrassv2.GetComponentVersionArtifactError
    >
  >
> {}
export const GetComponentVersionArtifact =
  Binding.Service<GetComponentVersionArtifact>(
    "AWS.GreengrassV2.GetComponentVersionArtifact",
  );
