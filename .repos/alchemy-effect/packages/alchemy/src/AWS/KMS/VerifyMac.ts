import type * as kms from "@distilled.cloud/aws/kms";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { AliasName } from "./Alias.ts";
import type { Key } from "./Key.ts";

export interface VerifyMacRequest extends Omit<kms.VerifyMacRequest, "KeyId"> {}

/**
 * Runtime binding for `kms:VerifyMac`.
 *
 * Bind this operation to an HMAC KMS {@link Key} (or the `alias/...` name of
 * a pre-existing key) to get a callable that automatically injects the
 * `KeyId`. A mismatched MAC surfaces as the typed
 * `KMSInvalidMacException` — a valid MAC returns `MacValid: true`.
 *
 * @binding
 * @section Message Authentication
 * @example Verify an HMAC
 * ```typescript
 * const verifyMac = yield* AWS.KMS.VerifyMac(hmacKey);
 *
 * const { MacValid } = yield* verifyMac({
 *   Message: new TextEncoder().encode("session-token-payload"),
 *   Mac: mac,
 *   MacAlgorithm: "HMAC_SHA_256",
 * });
 * ```
 *
 * @example Treat a Bad MAC as a Value
 * ```typescript
 * const valid = yield* verifyMac({ Message, Mac, MacAlgorithm }).pipe(
 *   Effect.map(() => true),
 *   Effect.catchTag("KMSInvalidMacException", () => Effect.succeed(false)),
 * );
 * ```
 */
export interface VerifyMac extends Binding.Service<
  VerifyMac,
  "AWS.KMS.VerifyMac",
  (
    key: Key | AliasName,
  ) => Effect.Effect<
    (
      request: VerifyMacRequest,
    ) => Effect.Effect<kms.VerifyMacResponse, kms.VerifyMacError>
  >
> {}

export const VerifyMac = Binding.Service<VerifyMac>("AWS.KMS.VerifyMac");
