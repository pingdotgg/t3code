import type * as microvms from "@distilled.cloud/aws/lambda-microvms";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { MicrovmImage } from "./MicrovmImage.ts";

export interface GetMicrovmRequest extends microvms.GetMicrovmRequest {}

/**
 * Runtime binding for `GetMicrovm`.
 *
 * Bind it to a {@link MicrovmImage} to get a callable that reads the state,
 * endpoint, and configuration of a running MicroVM by `microvmIdentifier`.
 * @binding
 * @section Inspecting MicroVMs
 * @example Get a MicroVM
 * ```typescript
 * const getMicrovm = yield* AWS.Lambda.GetMicrovm(Sandbox);
 * const vm = yield* getMicrovm({ microvmIdentifier: id });
 * ```
 */
export interface GetMicrovm extends Binding.Service<
  GetMicrovm,
  "AWS.Lambda.GetMicrovm",
  (
    image: MicrovmImage,
  ) => Effect.Effect<
    (
      request: GetMicrovmRequest,
    ) => Effect.Effect<microvms.GetMicrovmResponse, microvms.GetMicrovmError>
  >
> {}
export const GetMicrovm = Binding.Service<GetMicrovm>("AWS.Lambda.GetMicrovm");
