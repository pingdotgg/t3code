import type * as microvms from "@distilled.cloud/aws/lambda-microvms";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { MicrovmImage } from "./MicrovmImage.ts";

export interface ListMicrovmImageBuildsRequest extends Omit<
  microvms.ListMicrovmImageBuildsInput,
  "imageIdentifier"
> {}

/**
 * Runtime binding for `ListMicrovmImageBuilds`.
 *
 * Bind it to a {@link MicrovmImage} to list builds for an image version,
 * optionally filtered by architecture/chipset (the `imageIdentifier` is
 * injected).
 * @binding
 * @section Image Builds
 */
export interface ListMicrovmImageBuilds extends Binding.Service<
  ListMicrovmImageBuilds,
  "AWS.Lambda.ListMicrovmImageBuilds",
  (
    image: MicrovmImage,
  ) => Effect.Effect<
    (
      request: ListMicrovmImageBuildsRequest,
    ) => Effect.Effect<
      microvms.ListMicrovmImageBuildsOutput,
      microvms.ListMicrovmImageBuildsError
    >
  >
> {}
export const ListMicrovmImageBuilds = Binding.Service<ListMicrovmImageBuilds>(
  "AWS.Lambda.ListMicrovmImageBuilds",
);
