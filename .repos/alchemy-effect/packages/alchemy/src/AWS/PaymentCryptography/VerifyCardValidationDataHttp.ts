import * as paymentcryptographydata from "@distilled.cloud/aws/payment-cryptography-data";
import * as Layer from "effect/Layer";
import { makePaymentCryptographyKeyHttpBinding } from "./BindingHttp.ts";
import { VerifyCardValidationData } from "./VerifyCardValidationData.ts";

/**
 * HTTP implementation of {@link VerifyCardValidationData} — grants the host
 * Function `payment-cryptography:VerifyCardValidationData` on the CVK and
 * calls the Payment Cryptography Data API at runtime. A mismatch fails with
 * the typed `VerificationFailedException`.
 */
export const VerifyCardValidationDataHttp = Layer.effect(
  VerifyCardValidationData,
  makePaymentCryptographyKeyHttpBinding({
    tag: "AWS.PaymentCryptography.VerifyCardValidationData",
    operation: paymentcryptographydata.verifyCardValidationData,
    actions: ["payment-cryptography:VerifyCardValidationData"],
  }),
);
