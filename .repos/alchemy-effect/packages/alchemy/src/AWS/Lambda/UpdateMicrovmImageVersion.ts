import type * as microvms from "@distilled.cloud/aws/lambda-microvms";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { MicrovmImage } from "./MicrovmImage.ts";

export interface UpdateMicrovmImageVersionRequest extends Omit<
  microvms.UpdateMicrovmImageVersionRequest,
  "imageIdentifier"
> {}

/**
 * Runtime binding for `UpdateMicrovmImageVersion`.
 *
 * Bind it to a {@link MicrovmImage} to update a version's status (e.g. mark it
 * `ACTIVE`/`INACTIVE`); the `imageIdentifier` is injected.
 * @binding
 * @section Image Versions
 */
export interface UpdateMicrovmImageVersion extends Binding.Service<
  UpdateMicrovmImageVersion,
  "AWS.Lambda.UpdateMicrovmImageVersion",
  (
    image: MicrovmImage,
  ) => Effect.Effect<
    (
      request: UpdateMicrovmImageVersionRequest,
    ) => Effect.Effect<
      microvms.UpdateMicrovmImageVersionResponse,
      microvms.UpdateMicrovmImageVersionError
    >
  >
> {}
export const UpdateMicrovmImageVersion =
  Binding.Service<UpdateMicrovmImageVersion>(
    "AWS.Lambda.UpdateMicrovmImageVersion",
  );
