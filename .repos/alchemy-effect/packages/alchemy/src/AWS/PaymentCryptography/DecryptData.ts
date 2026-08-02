import type * as paymentcryptographydata from "@distilled.cloud/aws/payment-cryptography-data";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Key } from "./Key.ts";

export interface DecryptDataRequest extends Omit<
  paymentcryptographydata.DecryptDataInput,
  "KeyIdentifier"
> {}

/**
 * Runtime binding for `payment-cryptography:DecryptData` — decrypts
 * ciphertext under a {@link Key}. Provide `DecryptDataHttp` on the Function
 * to satisfy this service.
 * @binding
 * @section Decrypting Data
 * @example Decrypt ciphertext
 * ```typescript
 * // init
 * const decrypt = yield* PaymentCryptography.DecryptData(key);
 *
 * // runtime
 * const result = yield* decrypt({
 *   CipherText: cipherText,
 *   DecryptionAttributes: {
 *     Symmetric: { Mode: "CBC", InitializationVector: "00000000000000000000000000000000" },
 *   },
 * });
 * ```
 */
export interface DecryptData extends Binding.Service<
  DecryptData,
  "AWS.PaymentCryptography.DecryptData",
  <K extends Key>(
    key: K,
  ) => Effect.Effect<
    (
      request: DecryptDataRequest,
    ) => Effect.Effect<
      paymentcryptographydata.DecryptDataOutput,
      paymentcryptographydata.DecryptDataError
    >
  >
> {}

export const DecryptData = Binding.Service<DecryptData>(
  "AWS.PaymentCryptography.DecryptData",
);
