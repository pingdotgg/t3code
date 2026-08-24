import type * as paymentcryptographydata from "@distilled.cloud/aws/payment-cryptography-data";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Key } from "./Key.ts";

export interface TranslatePinDataRequest extends Omit<
  paymentcryptographydata.TranslatePinDataInput,
  "IncomingKeyIdentifier" | "OutgoingKeyIdentifier"
> {}

/**
 * Runtime binding for `payment-cryptography:TranslatePinData` — translates
 * an encrypted PIN block from one PIN encryption {@link Key} (and ISO 9564
 * format) to another without the PIN ever leaving the service. This is the
 * core acquirer operation for forwarding PIN blocks between networks.
 * Provide `TranslatePinDataHttp` on the Function to satisfy this service.
 * @binding
 * @section PIN Data
 * @example Translate a PIN block between two PEKs
 * ```typescript
 * // init
 * const translatePin = yield* PaymentCryptography.TranslatePinData(pek, partnerPek);
 *
 * // runtime
 * const translated = yield* translatePin({
 *   IncomingTranslationAttributes: {
 *     IsoFormat0: { PrimaryAccountNumber: pan },
 *   },
 *   OutgoingTranslationAttributes: {
 *     IsoFormat0: { PrimaryAccountNumber: pan },
 *   },
 *   EncryptedPinBlock: encryptedPinBlock,
 * });
 * ```
 */
export interface TranslatePinData extends Binding.Service<
  TranslatePinData,
  "AWS.PaymentCryptography.TranslatePinData",
  <In extends Key, Out extends Key>(
    incomingKey: In,
    outgoingKey: Out,
  ) => Effect.Effect<
    (
      request: TranslatePinDataRequest,
    ) => Effect.Effect<
      paymentcryptographydata.TranslatePinDataOutput,
      paymentcryptographydata.TranslatePinDataError
    >
  >
> {}

export const TranslatePinData = Binding.Service<TranslatePinData>(
  "AWS.PaymentCryptography.TranslatePinData",
);
