import type * as microvms from "@distilled.cloud/aws/lambda-microvms";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { MicrovmImage } from "./MicrovmImage.ts";

export interface TerminateMicrovmRequest
  extends microvms.TerminateMicrovmRequest {}

/**
 * Runtime binding for `TerminateMicrovm`.
 *
 * Bind it to a {@link MicrovmImage} to get a callable that terminates a running
 * MicroVM by `microvmIdentifier`. Idempotent.
 * @binding
 * @section Lifecycle
 * @example Terminate a MicroVM
 * ```typescript
 * const terminateMicrovm = yield* AWS.Lambda.TerminateMicrovm(Sandbox);
 * yield* terminateMicrovm({ microvmIdentifier: id });
 * ```
 */
export interface TerminateMicrovm extends Binding.Service<
  TerminateMicrovm,
  "AWS.Lambda.TerminateMicrovm",
  (
    image: MicrovmImage,
  ) => Effect.Effect<
    (
      request: TerminateMicrovmRequest,
    ) => Effect.Effect<
      microvms.TerminateMicrovmResponse,
      microvms.TerminateMicrovmError
    >
  >
> {}
export const TerminateMicrovm = Binding.Service<TerminateMicrovm>(
  "AWS.Lambda.TerminateMicrovm",
);
