import type * as paymentcryptographydata from "@distilled.cloud/aws/payment-cryptography-data";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Key } from "./Key.ts";

export interface GeneratePinDataRequest extends Omit<
  paymentcryptographydata.GeneratePinDataInput,
  "GenerationKeyIdentifier" | "EncryptionKeyIdentifier"
> {}

/**
 * Runtime binding for `payment-cryptography:GeneratePinData` — generates
 * PIN-related data (PIN, PVV, PIN block) under a PIN generation {@link Key}
 * (e.g. a Visa PVK) and returns the PIN block encrypted under a PIN
 * encryption {@link Key} (PEK). Provide `GeneratePinDataHttp` on the
 * Function to satisfy this service.
 * @binding
 * @section PIN Data
 * @example Generate a Visa PIN + PVV
 * ```typescript
 * // init
 * const generatePin = yield* PaymentCryptography.GeneratePinData(pvk, pek);
 *
 * // runtime
 * const generated = yield* generatePin({
 *   GenerationAttributes: { VisaPin: { PinVerificationKeyIndex: 1 } },
 *   PrimaryAccountNumber: "9123456789012345",
 *   PinBlockFormat: "ISO_FORMAT_0",
 * });
 * // generated.EncryptedPinBlock + generated.PinData.VerificationValue
 * ```
 */
export interface GeneratePinData extends Binding.Service<
  GeneratePinData,
  "AWS.PaymentCryptography.GeneratePinData",
  <G extends Key, E extends Key>(
    generationKey: G,
    encryptionKey: E,
  ) => Effect.Effect<
    (
      request: GeneratePinDataRequest,
    ) => Effect.Effect<
      paymentcryptographydata.GeneratePinDataOutput,
      paymentcryptographydata.GeneratePinDataError
    >
  >
> {}

export const GeneratePinData = Binding.Service<GeneratePinData>(
  "AWS.PaymentCryptography.GeneratePinData",
);
