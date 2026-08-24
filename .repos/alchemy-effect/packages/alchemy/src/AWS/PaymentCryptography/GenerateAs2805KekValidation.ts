import type * as paymentcryptographydata from "@distilled.cloud/aws/payment-cryptography-data";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Key } from "./Key.ts";

export interface GenerateAs2805KekValidationRequest extends Omit<
  paymentcryptographydata.GenerateAs2805KekValidationInput,
  "KeyIdentifier"
> {}

/**
 * Runtime binding for `payment-cryptography:GenerateAs2805KekValidation` —
 * generates AS2805 Key Encryption Key (KEK) validation data (random key
 * send/receive components) under a KEK {@link Key}, used during AS2805 node
 * key establishment in Australian payment networks. Provide
 * `GenerateAs2805KekValidationHttp` on the Function to satisfy this service.
 * @binding
 * @section AS2805 Key Establishment
 * @example Generate KEK validation data
 * ```typescript
 * // init
 * const generateKekValidation =
 *   yield* PaymentCryptography.GenerateAs2805KekValidation(kek);
 *
 * // runtime
 * const validation = yield* generateKekValidation({
 *   KekValidationType: "KEKS",
 *   RandomKeySendVariantMask: mask,
 * });
 * ```
 */
export interface GenerateAs2805KekValidation extends Binding.Service<
  GenerateAs2805KekValidation,
  "AWS.PaymentCryptography.GenerateAs2805KekValidation",
  <K extends Key>(
    key: K,
  ) => Effect.Effect<
    (
      request: GenerateAs2805KekValidationRequest,
    ) => Effect.Effect<
      paymentcryptographydata.GenerateAs2805KekValidationOutput,
      paymentcryptographydata.GenerateAs2805KekValidationError
    >
  >
> {}

export const GenerateAs2805KekValidation =
  Binding.Service<GenerateAs2805KekValidation>(
    "AWS.PaymentCryptography.GenerateAs2805KekValidation",
  );
