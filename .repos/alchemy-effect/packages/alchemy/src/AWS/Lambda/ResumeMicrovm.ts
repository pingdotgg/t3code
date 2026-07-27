import type * as microvms from "@distilled.cloud/aws/lambda-microvms";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { MicrovmImage } from "./MicrovmImage.ts";

export interface ResumeMicrovmRequest extends microvms.ResumeMicrovmRequest {}

/**
 * Runtime binding for `ResumeMicrovm`.
 *
 * Bind it to a {@link MicrovmImage} to get a callable that resumes a suspended
 * MicroVM by `microvmIdentifier`, restoring it to `RUNNING`.
 * @binding
 * @section Lifecycle
 * @example Resume a MicroVM
 * ```typescript
 * const resumeMicrovm = yield* AWS.Lambda.ResumeMicrovm(Sandbox);
 * yield* resumeMicrovm({ microvmIdentifier: id });
 * ```
 */
export interface ResumeMicrovm extends Binding.Service<
  ResumeMicrovm,
  "AWS.Lambda.ResumeMicrovm",
  (
    image: MicrovmImage,
  ) => Effect.Effect<
    (
      request: ResumeMicrovmRequest,
    ) => Effect.Effect<
      microvms.ResumeMicrovmResponse,
      microvms.ResumeMicrovmError
    >
  >
> {}
export const ResumeMicrovm = Binding.Service<ResumeMicrovm>(
  "AWS.Lambda.ResumeMicrovm",
);
