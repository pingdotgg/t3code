import type * as paymentcryptographydata from "@distilled.cloud/aws/payment-cryptography-data";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Key } from "./Key.ts";

export interface GenerateCardValidationDataRequest extends Omit<
  paymentcryptographydata.GenerateCardValidationDataInput,
  "KeyIdentifier"
> {}

/**
 * Runtime binding for `payment-cryptography:GenerateCardValidationData` —
 * generates card validation values (CVV/CVV2, dCVV, CSC) under a Card
 * Verification Key (CVK) {@link Key}. Provide
 * `GenerateCardValidationDataHttp` on the Function to satisfy this service.
 * @binding
 * @section Card Validation Data
 * @example Generate a CVV2 for a card
 * ```typescript
 * // init
 * const generateCvv2 = yield* PaymentCryptography.GenerateCardValidationData(cvk);
 *
 * // runtime
 * const generated = yield* generateCvv2({
 *   PrimaryAccountNumber: "9123456789012345",
 *   GenerationAttributes: {
 *     CardVerificationValue2: { CardExpiryDate: "0130" },
 *   },
 * });
 * ```
 */
export interface GenerateCardValidationData extends Binding.Service<
  GenerateCardValidationData,
  "AWS.PaymentCryptography.GenerateCardValidationData",
  <K extends Key>(
    key: K,
  ) => Effect.Effect<
    (
      request: GenerateCardValidationDataRequest,
    ) => Effect.Effect<
      paymentcryptographydata.GenerateCardValidationDataOutput,
      paymentcryptographydata.GenerateCardValidationDataError
    >
  >
> {}

export const GenerateCardValidationData =
  Binding.Service<GenerateCardValidationData>(
    "AWS.PaymentCryptography.GenerateCardValidationData",
  );
