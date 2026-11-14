import type * as microvms from "@distilled.cloud/aws/lambda-microvms";
import * as Binding from "alchemy/Binding";
import type * as Effect from "effect/Effect";
import type { MicrovmImage } from "./MicrovmImage.ts";

export interface GetMicrovmImageBuildRequest extends Omit<
  microvms.GetMicrovmImageBuildInput,
  "imageIdentifier"
> {}

/**
 * Runtime binding for `GetMicrovmImageBuild`.
 *
 * Bind it to a {@link MicrovmImage} to read a per-architecture build's state and
 * snapshot info (the `imageIdentifier` is injected).
 * ### Image Builds
 *
 * @binding
 */
export interface GetMicrovmImageBuild extends Binding.Service<
  GetMicrovmImageBuild,
  "AWS.Lambda.GetMicrovmImageBuild",
  (
    image: MicrovmImage,
  ) => Effect.Effect<
    (
      request: GetMicrovmImageBuildRequest,
    ) => Effect.Effect<microvms.GetMicrovmImageBuildOutput, microvms.GetMicrovmImageBuildError>
  >
> {}
export const GetMicrovmImageBuild = Binding.Service<GetMicrovmImageBuild>(
  "AWS.Lambda.GetMicrovmImageBuild",
);
