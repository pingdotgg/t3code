import type * as microvms from "@distilled.cloud/aws/lambda-microvms";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { MicrovmImage } from "./MicrovmImage.ts";

export interface SuspendMicrovmRequest extends microvms.SuspendMicrovmRequest {}

/**
 * Runtime binding for `SuspendMicrovm`.
 *
 * Bind it to a {@link MicrovmImage} to get a callable that suspends a running
 * MicroVM (snapshotting memory + disk) by `microvmIdentifier`.
 * @binding
 * @section Lifecycle
 * @example Suspend a MicroVM
 * ```typescript
 * const suspendMicrovm = yield* AWS.Lambda.SuspendMicrovm(Sandbox);
 * yield* suspendMicrovm({ microvmIdentifier: id });
 * ```
 */
export interface SuspendMicrovm extends Binding.Service<
  SuspendMicrovm,
  "AWS.Lambda.SuspendMicrovm",
  (
    image: MicrovmImage,
  ) => Effect.Effect<
    (
      request: SuspendMicrovmRequest,
    ) => Effect.Effect<
      microvms.SuspendMicrovmResponse,
      microvms.SuspendMicrovmError
    >
  >
> {}
export const SuspendMicrovm = Binding.Service<SuspendMicrovm>(
  "AWS.Lambda.SuspendMicrovm",
);
