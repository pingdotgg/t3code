import type * as imagebuilder from "@distilled.cloud/aws/imagebuilder";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `imagebuilder:CancelImageCreation`.
 *
 * Cancels an in-flight image build (only valid for builds in a non-terminal
 * state). Build versions are created dynamically by pipeline runs, so this
 * is an account-level binding: pass the `imageBuildVersionArn` returned by
 * `StartImagePipelineExecution`. The idempotency `clientToken` is generated
 * automatically. Provide the implementation with
 * `Effect.provide(AWS.ImageBuilder.CancelImageCreationHttp)`.
 * @binding
 * @section Running Builds
 * @example Cancel an In-Flight Build
 * ```typescript
 * // init — account-level binding, no resource argument
 * const cancelBuild = yield* AWS.ImageBuilder.CancelImageCreation();
 *
 * // runtime
 * yield* cancelBuild({ imageBuildVersionArn });
 * ```
 */
export interface CancelImageCreation extends Binding.Service<
  CancelImageCreation,
  "AWS.ImageBuilder.CancelImageCreation",
  () => Effect.Effect<
    (
      request: Omit<imagebuilder.CancelImageCreationRequest, "clientToken">,
    ) => Effect.Effect<
      imagebuilder.CancelImageCreationResponse,
      imagebuilder.CancelImageCreationError
    >
  >
> {}
export const CancelImageCreation = Binding.Service<CancelImageCreation>(
  "AWS.ImageBuilder.CancelImageCreation",
);
