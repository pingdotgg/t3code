import type * as paymentcryptographydata from "@distilled.cloud/aws/payment-cryptography-data";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Key } from "./Key.ts";

export interface GenerateMacEmvPinChangeRequest extends Omit<
  paymentcryptographydata.GenerateMacEmvPinChangeInput,
  | "NewPinPekIdentifier"
  | "SecureMessagingIntegrityKeyIdentifier"
  | "SecureMessagingConfidentialityKeyIdentifier"
> {}

/**
 * Runtime binding for `payment-cryptography:GenerateMacEmvPinChange` —
 * generates the issuer-script MAC (and re-encrypted PIN block) for an EMV
 * PIN change command. Binds three {@link Key}s: the new PIN encryption key
 * (PEK) the changed PIN is encrypted under, and the secure-messaging
 * integrity and confidentiality issuer master keys. Provide
 * `GenerateMacEmvPinChangeHttp` on the Function to satisfy this service.
 * @binding
 * @section EMV PIN Change
 * @example Generate the issuer-script MAC for a PIN change
 * ```typescript
 * // init
 * const generatePinChangeMac = yield* PaymentCryptography.GenerateMacEmvPinChange(
 *   newPinPek,
 *   secureMessagingIntegrityKey,
 *   secureMessagingConfidentialityKey,
 * );
 *
 * // runtime
 * const result = yield* generatePinChangeMac({
 *   NewEncryptedPinBlock: newEncryptedPinBlock,
 *   PinBlockFormat: "ISO_FORMAT_0",
 *   MessageData: messageDataHex,
 *   DerivationMethodAttributes: { Emv2000: { ... } },
 * });
 * ```
 */
export interface GenerateMacEmvPinChange extends Binding.Service<
  GenerateMacEmvPinChange,
  "AWS.PaymentCryptography.GenerateMacEmvPinChange",
  <P extends Key, I extends Key, C extends Key>(
    newPinPek: P,
    secureMessagingIntegrityKey: I,
    secureMessagingConfidentialityKey: C,
  ) => Effect.Effect<
    (
      request: GenerateMacEmvPinChangeRequest,
    ) => Effect.Effect<
      paymentcryptographydata.GenerateMacEmvPinChangeOutput,
      paymentcryptographydata.GenerateMacEmvPinChangeError
    >
  >
> {}

export const GenerateMacEmvPinChange = Binding.Service<GenerateMacEmvPinChange>(
  "AWS.PaymentCryptography.GenerateMacEmvPinChange",
);
