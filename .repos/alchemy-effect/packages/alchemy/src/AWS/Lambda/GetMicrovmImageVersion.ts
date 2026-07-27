import type * as microvms from "@distilled.cloud/aws/lambda-microvms";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { MicrovmImage } from "./MicrovmImage.ts";

export interface GetMicrovmImageVersionRequest extends Omit<
  microvms.GetMicrovmImageVersionInput,
  "imageIdentifier"
> {}

/**
 * Runtime binding for `GetMicrovmImageVersion`.
 *
 * Bind it to a {@link MicrovmImage} to read the configuration and state of a
 * specific image version (the `imageIdentifier` is injected).
 * @binding
 * @section Image Reads
 */
export interface GetMicrovmImageVersion extends Binding.Service<
  GetMicrovmImageVersion,
  "AWS.Lambda.GetMicrovmImageVersion",
  (
    image: MicrovmImage,
  ) => Effect.Effect<
    (
      request: GetMicrovmImageVersionRequest,
    ) => Effect.Effect<
      microvms.GetMicrovmImageVersionOutput,
      microvms.GetMicrovmImageVersionError
    >
  >
> {}
export const GetMicrovmImageVersion = Binding.Service<GetMicrovmImageVersion>(
  "AWS.Lambda.GetMicrovmImageVersion",
);
