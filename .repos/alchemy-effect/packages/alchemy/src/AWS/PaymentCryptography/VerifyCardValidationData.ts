import type * as paymentcryptographydata from "@distilled.cloud/aws/payment-cryptography-data";
import type * as Effect from "effect/Effect";
import * as Binding from "../../Binding.ts";
import type { Key } from "./Key.ts";

export interface VerifyCardValidationDataRequest extends Omit<
  paymentcryptographydata.VerifyCardValidationDataInput,
  "KeyIdentifier"
> {}

/**
 * Runtime binding for `payment-cryptography:VerifyCardValidationData` —
 * verifies card validation values (CVV/CVV2, dCVV, CSC) under the same Card
 * Verification Key (CVK) {@link Key} used to generate them. A mismatch fails
 * with the typed `VerificationFailedException`. Provide
 * `VerifyCardValidationDataHttp` on the Function to satisfy this service.
 * @binding
 * @section Card Validation Data
 * @example Verify a CVV2 presented in a transaction
 * ```typescript
 * // init
 * const verifyCvv2 = yield* PaymentCryptography.VerifyCardValidationData(cvk);
 *
 * // runtime
 * const outcome = yield* verifyCvv2({
 *   PrimaryAccountNumber: "9123456789012345",
 *   VerificationAttributes: {
 *     CardVerificationValue2: { CardExpiryDate: "0130" },
 *   },
 *   ValidationData: cvv2,
 * }).pipe(
 *   Effect.map(() => "valid"),
 *   Effect.catchTag("VerificationFailedException", () =>
 *     Effect.succeed("invalid"),
 *   ),
 * );
 * ```
 */
export interface VerifyCardValidationData extends Binding.Service<
  VerifyCardValidationData,
  "AWS.PaymentCryptography.VerifyCardValidationData",
  <K extends Key>(
    key: K,
  ) => Effect.Effect<
    (
      request: VerifyCardValidationDataRequest,
    ) => Effect.Effect<
      paymentcryptographydata.VerifyCardValidationDataOutput,
      paymentcryptographydata.VerifyCardValidationDataError
    >
  >
> {}

export const VerifyCardValidationData =
  Binding.Service<VerifyCardValidationData>(
    "AWS.PaymentCryptography.VerifyCardValidationData",
  );
