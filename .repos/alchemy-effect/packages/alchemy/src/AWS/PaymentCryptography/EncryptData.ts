import type * as paymentcryptographydata from "@distilled.cloud/aws/payment-cryptography-data";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Key } from "./Key.ts";

export interface EncryptDataRequest extends Omit<
  paymentcryptographydata.EncryptDataInput,
  "KeyIdentifier"
> {}

/**
 * Runtime binding for `payment-cryptography:EncryptData` — encrypts
 * hex-encoded plaintext under a {@link Key}. Provide `EncryptDataHttp` on
 * the Function to satisfy this service.
 * @binding
 * @section Encrypting Data
 * @example Encrypt hex-encoded plaintext
 * ```typescript
 * // init
 * const encrypt = yield* PaymentCryptography.EncryptData(key);
 *
 * // runtime
 * const result = yield* encrypt({
 *   PlainText: "31323334353637383930313233343536",
 *   EncryptionAttributes: {
 *     Symmetric: { Mode: "CBC", InitializationVector: "00000000000000000000000000000000" },
 *   },
 * });
 * ```
 */
export interface EncryptData extends Binding.Service<
  EncryptData,
  "AWS.PaymentCryptography.EncryptData",
  <K extends Key>(
    key: K,
  ) => Effect.Effect<
    (
      request: EncryptDataRequest,
    ) => Effect.Effect<
      paymentcryptographydata.EncryptDataOutput,
      paymentcryptographydata.EncryptDataError
    >
  >
> {}

export const EncryptData = Binding.Service<EncryptData>(
  "AWS.PaymentCryptography.EncryptData",
);
