import type * as signer from "@distilled.cloud/aws/signer";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";

/**
 * Runtime binding for `signer:GetSigningPlatform`.
 *
 * Reads one AWS-managed signing platform by id — its signing configuration
 * (encryption/hash algorithms), image format, size limit, and whether it
 * supports revocation. Account-level operation over the AWS-managed platform
 * catalog, so the binding takes no resource argument. Provide the
 * implementation with `Effect.provide(AWS.Signer.GetSigningPlatformHttp)`.
 * @binding
 * @section Discovering Platforms
 * @example Check Revocation Support
 * ```typescript
 * // init — account-level binding, no resource argument
 * const getSigningPlatform = yield* AWS.Signer.GetSigningPlatform();
 *
 * // runtime
 * const platform = yield* getSigningPlatform({
 *   platformId: "AWSLambda-SHA384-ECDSA",
 * });
 * const canRevoke = platform.revocationSupported === true;
 * ```
 */
export interface GetSigningPlatform extends Binding.Service<
  GetSigningPlatform,
  "AWS.Signer.GetSigningPlatform",
  () => Effect.Effect<
    (
      request: signer.GetSigningPlatformRequest,
    ) => Effect.Effect<
      signer.GetSigningPlatformResponse,
      signer.GetSigningPlatformError
    >
  >
> {}
export const GetSigningPlatform = Binding.Service<GetSigningPlatform>(
  "AWS.Signer.GetSigningPlatform",
);
