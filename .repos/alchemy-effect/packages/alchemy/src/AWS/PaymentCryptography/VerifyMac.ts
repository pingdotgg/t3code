import type * as paymentcryptographydata from "@distilled.cloud/aws/payment-cryptography-data";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Key } from "./Key.ts";

export interface VerifyMacRequest extends Omit<
  paymentcryptographydata.VerifyMacInput,
  "KeyIdentifier"
> {}

/**
 * Runtime binding for `payment-cryptography:VerifyMac` — verifies a Message
 * Authentication Code against hex-encoded message data under a {@link Key}.
 * A mismatched MAC fails with the typed `VerificationFailedException`.
 * Provide `VerifyMacHttp` on the Function to satisfy this service.
 * @binding
 * @section Verifying MACs
 * @example Verify an HMAC
 * ```typescript
 * // init
 * const verifyMac = yield* PaymentCryptography.VerifyMac(macKey);
 *
 * // runtime — MessageData and Mac are hex-encoded
 * yield* verifyMac({
 *   MessageData: "31323334353637383930313233343536",
 *   Mac: mac,
 *   VerificationAttributes: { Algorithm: "HMAC" },
 * });
 * ```
 */
export interface VerifyMac extends Binding.Service<
  VerifyMac,
  "AWS.PaymentCryptography.VerifyMac",
  <K extends Key>(
    key: K,
  ) => Effect.Effect<
    (
      request: VerifyMacRequest,
    ) => Effect.Effect<
      paymentcryptographydata.VerifyMacOutput,
      paymentcryptographydata.VerifyMacError
    >
  >
> {}

export const VerifyMac = Binding.Service<VerifyMac>(
  "AWS.PaymentCryptography.VerifyMac",
);
