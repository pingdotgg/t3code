import type * as microvms from "@distilled.cloud/aws/lambda-microvms";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { MicrovmImage } from "./MicrovmImage.ts";

export interface GetMicrovmImageRequest extends Omit<
  microvms.GetMicrovmImageInput,
  "imageIdentifier"
> {}

/**
 * Runtime binding for `GetMicrovmImage`.
 *
 * Bind it to a {@link MicrovmImage} to read the image's state and versions at
 * runtime (the `imageIdentifier` is injected).
 * @binding
 * @section Image Reads
 * @example Get the image
 * ```typescript
 * const getMicrovmImage = yield* AWS.Lambda.GetMicrovmImage(Sandbox);
 * const image = yield* getMicrovmImage({});
 * ```
 */
export interface GetMicrovmImage extends Binding.Service<
  GetMicrovmImage,
  "AWS.Lambda.GetMicrovmImage",
  (
    image: MicrovmImage,
  ) => Effect.Effect<
    (
      request: GetMicrovmImageRequest,
    ) => Effect.Effect<
      microvms.GetMicrovmImageOutput,
      microvms.GetMicrovmImageError
    >
  >
> {}
export const GetMicrovmImage = Binding.Service<GetMicrovmImage>(
  "AWS.Lambda.GetMicrovmImage",
);
