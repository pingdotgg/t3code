import type * as paymentcryptographydata from "@distilled.cloud/aws/payment-cryptography-data";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Key } from "./Key.ts";

export interface VerifyAuthRequestCryptogramRequest extends Omit<
  paymentcryptographydata.VerifyAuthRequestCryptogramInput,
  "KeyIdentifier"
> {}

/**
 * Runtime binding for `payment-cryptography:VerifyAuthRequestCryptogram` —
 * verifies an Authorization Request Cryptogram (ARQC) during EMV transaction
 * processing under an issuer master {@link Key}, optionally producing the
 * Authorization Response Cryptogram (ARPC). A mismatch fails with the typed
 * `VerificationFailedException`. Provide `VerifyAuthRequestCryptogramHttp`
 * on the Function to satisfy this service.
 * @binding
 * @section EMV Cryptograms
 * @example Verify an ARQC and produce the ARPC
 * ```typescript
 * // init
 * const verifyArqc =
 *   yield* PaymentCryptography.VerifyAuthRequestCryptogram(issuerMasterKey);
 *
 * // runtime
 * const verified = yield* verifyArqc({
 *   TransactionData: transactionDataHex,
 *   AuthRequestCryptogram: arqc,
 *   MajorKeyDerivationMode: "EMV_OPTION_A",
 *   SessionKeyDerivationAttributes: {
 *     EmvCommon: { PrimaryAccountNumber: pan, PanSequenceNumber: "00", ApplicationTransactionCounter: "0001" },
 *   },
 *   AuthResponseAttributes: { ArqcMethod1: { AuthResponseCode: "0000" } },
 * });
 * ```
 */
export interface VerifyAuthRequestCryptogram extends Binding.Service<
  VerifyAuthRequestCryptogram,
  "AWS.PaymentCryptography.VerifyAuthRequestCryptogram",
  <K extends Key>(
    key: K,
  ) => Effect.Effect<
    (
      request: VerifyAuthRequestCryptogramRequest,
    ) => Effect.Effect<
      paymentcryptographydata.VerifyAuthRequestCryptogramOutput,
      paymentcryptographydata.VerifyAuthRequestCryptogramError
    >
  >
> {}

export const VerifyAuthRequestCryptogram =
  Binding.Service<VerifyAuthRequestCryptogram>(
    "AWS.PaymentCryptography.VerifyAuthRequestCryptogram",
  );
