import type * as paymentcryptographydata from "@distilled.cloud/aws/payment-cryptography-data";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Key } from "./Key.ts";

export interface GenerateMacRequest extends Omit<
  paymentcryptographydata.GenerateMacInput,
  "KeyIdentifier"
> {}

/**
 * Runtime binding for `payment-cryptography:GenerateMac` — computes a
 * Message Authentication Code over hex-encoded message data under a
 * {@link Key}. Provide `GenerateMacHttp` on the Function to satisfy this
 * service.
 * @binding
 * @section Generating MACs
 * @example Generate an HMAC over message data
 * ```typescript
 * // init
 * const generateMac = yield* PaymentCryptography.GenerateMac(macKey);
 *
 * // runtime — MessageData is hex-encoded
 * const result = yield* generateMac({
 *   MessageData: "31323334353637383930313233343536",
 *   GenerationAttributes: { Algorithm: "HMAC" },
 * });
 * ```
 */
export interface GenerateMac extends Binding.Service<
  GenerateMac,
  "AWS.PaymentCryptography.GenerateMac",
  <K extends Key>(
    key: K,
  ) => Effect.Effect<
    (
      request: GenerateMacRequest,
    ) => Effect.Effect<
      paymentcryptographydata.GenerateMacOutput,
      paymentcryptographydata.GenerateMacError
    >
  >
> {}

export const GenerateMac = Binding.Service<GenerateMac>(
  "AWS.PaymentCryptography.GenerateMac",
);
