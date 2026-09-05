import type * as paymentcryptographydata from "@distilled.cloud/aws/payment-cryptography-data";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Key } from "./Key.ts";

export interface VerifyPinDataRequest extends Omit<
  paymentcryptographydata.VerifyPinDataInput,
  "VerificationKeyIdentifier" | "EncryptionKeyIdentifier"
> {}

/**
 * Runtime binding for `payment-cryptography:VerifyPinData` — verifies an
 * encrypted PIN block against PIN verification data (e.g. a Visa PVV) using
 * a PIN verification {@link Key} (PVK) and the PIN encryption {@link Key}
 * (PEK) the block is encrypted under. A mismatch fails with the typed
 * `VerificationFailedException`. Provide `VerifyPinDataHttp` on the Function
 * to satisfy this service.
 * @binding
 * @section PIN Data
 * @example Verify a cardholder PIN with a Visa PVV
 * ```typescript
 * // init
 * const verifyPin = yield* PaymentCryptography.VerifyPinData(pvk, pek);
 *
 * // runtime
 * const outcome = yield* verifyPin({
 *   VerificationAttributes: {
 *     VisaPin: { PinVerificationKeyIndex: 1, VerificationValue: pvv },
 *   },
 *   EncryptedPinBlock: encryptedPinBlock,
 *   PrimaryAccountNumber: "9123456789012345",
 *   PinBlockFormat: "ISO_FORMAT_0",
 * }).pipe(
 *   Effect.map(() => "valid"),
 *   Effect.catchTag("VerificationFailedException", () =>
 *     Effect.succeed("invalid"),
 *   ),
 * );
 * ```
 */
export interface VerifyPinData extends Binding.Service<
  VerifyPinData,
  "AWS.PaymentCryptography.VerifyPinData",
  <V extends Key, E extends Key>(
    verificationKey: V,
    encryptionKey: E,
  ) => Effect.Effect<
    (
      request: VerifyPinDataRequest,
    ) => Effect.Effect<
      paymentcryptographydata.VerifyPinDataOutput,
      paymentcryptographydata.VerifyPinDataError
    >
  >
> {}

export const VerifyPinData = Binding.Service<VerifyPinData>(
  "AWS.PaymentCryptography.VerifyPinData",
);
