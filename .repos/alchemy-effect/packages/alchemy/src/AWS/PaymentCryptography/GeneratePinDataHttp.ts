import * as paymentcryptographydata from "@distilled.cloud/aws/payment-cryptography-data";
import * as Layer from "effect/Layer";
import { makePaymentCryptographyKeyPairHttpBinding } from "./BindingHttp.ts";
import { GeneratePinData } from "./GeneratePinData.ts";

/**
 * HTTP implementation of {@link GeneratePinData} — grants the host Function
 * `payment-cryptography:GeneratePinData` on both the generation key (PVK)
 * and the encryption key (PEK) and calls the Payment Cryptography Data API
 * at runtime.
 */
export const GeneratePinDataHttp = Layer.effect(
  GeneratePinData,
  makePaymentCryptographyKeyPairHttpBinding({
    tag: "AWS.PaymentCryptography.GeneratePinData",
    operation: paymentcryptographydata.generatePinData,
    actions: ["payment-cryptography:GeneratePinData"],
    keyFields: ["GenerationKeyIdentifier", "EncryptionKeyIdentifier"],
  }),
);
