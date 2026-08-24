import type * as microvms from "@distilled.cloud/aws/lambda-microvms";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { MicrovmImage } from "./MicrovmImage.ts";

export interface ListMicrovmsRequest extends Omit<
  microvms.ListMicrovmsRequest,
  "imageIdentifier"
> {}

/**
 * Runtime binding for `ListMicrovms`.
 *
 * Bind it to a {@link MicrovmImage} to get a callable that lists the MicroVMs
 * launched from that image (the `imageIdentifier` filter is injected).
 * @binding
 * @section Inspecting MicroVMs
 * @example List MicroVMs
 * ```typescript
 * const listMicrovms = yield* AWS.Lambda.ListMicrovms(Sandbox);
 * const { items } = yield* listMicrovms({});
 * ```
 */
export interface ListMicrovms extends Binding.Service<
  ListMicrovms,
  "AWS.Lambda.ListMicrovms",
  (
    image: MicrovmImage,
  ) => Effect.Effect<
    (
      request: ListMicrovmsRequest,
    ) => Effect.Effect<
      microvms.ListMicrovmsResponse,
      microvms.ListMicrovmsError
    >
  >
> {}
export const ListMicrovms = Binding.Service<ListMicrovms>(
  "AWS.Lambda.ListMicrovms",
);
