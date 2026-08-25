import type * as imagebuilder from "@distilled.cloud/aws/imagebuilder";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `imagebuilder:RetryImage`.
 *
 * Retries a failed image build in place (same build version ARN) — pair it
 * with `consumeImageEvents` to automatically retry transient build failures.
 * The idempotency `clientToken` is generated automatically. Provide the
 * implementation with `Effect.provide(AWS.ImageBuilder.RetryImageHttp)`.
 * @binding
 * @section Running Builds
 * @example Retry a Failed Build
 * ```typescript
 * // init — account-level binding, no resource argument
 * const retryImage = yield* AWS.ImageBuilder.RetryImage();
 *
 * // runtime
 * yield* retryImage({ imageBuildVersionArn });
 * ```
 */
export interface RetryImage extends Binding.Service<
  RetryImage,
  "AWS.ImageBuilder.RetryImage",
  () => Effect.Effect<
    (
      request: Omit<imagebuilder.RetryImageRequest, "clientToken">,
    ) => Effect.Effect<
      imagebuilder.RetryImageResponse,
      imagebuilder.RetryImageError
    >
  >
> {}
export const RetryImage = Binding.Service<RetryImage>(
  "AWS.ImageBuilder.RetryImage",
);
