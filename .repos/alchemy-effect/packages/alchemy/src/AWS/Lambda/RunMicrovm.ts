import type * as microvms from "@distilled.cloud/aws/lambda-microvms";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { MicrovmImage } from "./MicrovmImage.ts";

export interface RunMicrovmRequest extends Omit<
  microvms.RunMicrovmRequest,
  "imageIdentifier"
> {}

/**
 * Runtime binding for `RunMicrovm`.
 *
 * Bind it to a {@link MicrovmImage} inside a Lambda Function to get a callable
 * that launches a MicroVM from that image (the `imageIdentifier` is injected).
 * The response carries the MicroVM `endpoint`; connect to it with an
 * `X-aws-proxy-auth` token from {@link CreateAuthToken}.
 *
 * @binding
 * @section Running MicroVMs
 * @example Run a MicroVM
 * ```typescript
 * const runMicrovm = yield* AWS.Lambda.RunMicrovm(Sandbox);
 *
 * const vm = yield* runMicrovm({
 *   idlePolicy: {
 *     maxIdleDurationSeconds: 900,
 *     suspendedDurationSeconds: 300,
 *     autoResumeEnabled: true,
 *   },
 * });
 * ```
 */
export interface RunMicrovm extends Binding.Service<
  RunMicrovm,
  "AWS.Lambda.RunMicrovm",
  (
    image: MicrovmImage,
  ) => Effect.Effect<
    (
      request: RunMicrovmRequest,
    ) => Effect.Effect<microvms.RunMicrovmResponse, microvms.RunMicrovmError>
  >
> {}
export const RunMicrovm = Binding.Service<RunMicrovm>("AWS.Lambda.RunMicrovm");
