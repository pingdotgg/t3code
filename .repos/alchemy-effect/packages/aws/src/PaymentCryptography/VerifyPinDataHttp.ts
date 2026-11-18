import * as paymentcryptographydata from "@distilled.cloud/aws/payment-cryptography-data";
import * as Layer from "effect/Layer";
import { makePaymentCryptographyKeyPairHttpBinding } from "./BindingHttp.ts";
import { VerifyPinData } from "./VerifyPinData.ts";

/**
 * HTTP implementation of {@link VerifyPinData} — grants the host Function
 * `payment-cryptography:VerifyPinData` on both the verification key (PVK)
 * and the encryption key (PEK) and calls the Payment Cryptography Data API
 * at runtime. A PIN mismatch fails with the typed
 * `VerificationFailedException`.
 */
export const VerifyPinDataHttp = Layer.effect(
  VerifyPinData,
  makePaymentCryptographyKeyPairHttpBinding({
    tag: "AWS.PaymentCryptography.VerifyPinData",
    operation: paymentcryptographydata.verifyPinData,
    actions: ["payment-cryptography:VerifyPinData"],
    keyFields: ["VerificationKeyIdentifier", "EncryptionKeyIdentifier"],
  }),
);
