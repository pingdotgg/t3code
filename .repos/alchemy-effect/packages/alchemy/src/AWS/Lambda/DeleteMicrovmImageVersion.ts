import type * as microvms from "@distilled.cloud/aws/lambda-microvms";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { MicrovmImage } from "./MicrovmImage.ts";

export interface DeleteMicrovmImageVersionRequest extends Omit<
  microvms.DeleteMicrovmImageVersionInput,
  "imageIdentifier"
> {}

/**
 * Runtime binding for `DeleteMicrovmImageVersion`.
 *
 * Bind it to a {@link MicrovmImage} to delete a specific image version (the
 * `imageIdentifier` is injected). Idempotent.
 * @binding
 * @section Image Versions
 */
export interface DeleteMicrovmImageVersion extends Binding.Service<
  DeleteMicrovmImageVersion,
  "AWS.Lambda.DeleteMicrovmImageVersion",
  (
    image: MicrovmImage,
  ) => Effect.Effect<
    (
      request: DeleteMicrovmImageVersionRequest,
    ) => Effect.Effect<
      microvms.DeleteMicrovmImageVersionOutput,
      microvms.DeleteMicrovmImageVersionError
    >
  >
> {}
export const DeleteMicrovmImageVersion =
  Binding.Service<DeleteMicrovmImageVersion>(
    "AWS.Lambda.DeleteMicrovmImageVersion",
  );
