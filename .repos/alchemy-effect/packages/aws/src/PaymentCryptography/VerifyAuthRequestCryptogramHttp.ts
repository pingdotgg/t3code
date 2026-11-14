import * as paymentcryptographydata from "@distilled.cloud/aws/payment-cryptography-data";
import * as Layer from "effect/Layer";
import { makePaymentCryptographyKeyHttpBinding } from "./BindingHttp.ts";
import { VerifyAuthRequestCryptogram } from "./VerifyAuthRequestCryptogram.ts";

/**
 * HTTP implementation of {@link VerifyAuthRequestCryptogram} — grants the
 * host Function `payment-cryptography:VerifyAuthRequestCryptogram` on the
 * issuer master key and calls the Payment Cryptography Data API at runtime.
 * A cryptogram mismatch fails with the typed `VerificationFailedException`.
 */
export const VerifyAuthRequestCryptogramHttp = Layer.effect(
  VerifyAuthRequestCryptogram,
  makePaymentCryptographyKeyHttpBinding({
    tag: "AWS.PaymentCryptography.VerifyAuthRequestCryptogram",
    operation: paymentcryptographydata.verifyAuthRequestCryptogram,
    actions: ["payment-cryptography:VerifyAuthRequestCryptogram"],
  }),
);
