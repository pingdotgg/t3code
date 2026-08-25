import type * as microvms from "@distilled.cloud/aws/lambda-microvms";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { MicrovmImage } from "./MicrovmImage.ts";

export interface ListMicrovmImageVersionsRequest extends Omit<
  microvms.ListMicrovmImageVersionsInput,
  "imageIdentifier"
> {}

/**
 * Runtime binding for `ListMicrovmImageVersions`.
 *
 * Bind it to a {@link MicrovmImage} to list the image's versions (the
 * `imageIdentifier` is injected).
 * @binding
 * @section Image Reads
 */
export interface ListMicrovmImageVersions extends Binding.Service<
  ListMicrovmImageVersions,
  "AWS.Lambda.ListMicrovmImageVersions",
  (
    image: MicrovmImage,
  ) => Effect.Effect<
    (
      request: ListMicrovmImageVersionsRequest,
    ) => Effect.Effect<
      microvms.ListMicrovmImageVersionsOutput,
      microvms.ListMicrovmImageVersionsError
    >
  >
> {}
export const ListMicrovmImageVersions =
  Binding.Service<ListMicrovmImageVersions>(
    "AWS.Lambda.ListMicrovmImageVersions",
  );
