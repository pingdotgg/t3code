import * as paymentcryptographydata from "@distilled.cloud/aws/payment-cryptography-data";
import * as Layer from "effect/Layer";
import { makePaymentCryptographyKeyPairHttpBinding } from "./BindingHttp.ts";
import { ReEncryptData } from "./ReEncryptData.ts";

/**
 * HTTP implementation of {@link ReEncryptData} — grants the host Function
 * `payment-cryptography:ReEncryptData` on both the incoming and outgoing
 * keys and calls the Payment Cryptography Data API at runtime.
 */
export const ReEncryptDataHttp = Layer.effect(
  ReEncryptData,
  makePaymentCryptographyKeyPairHttpBinding({
    tag: "AWS.PaymentCryptography.ReEncryptData",
    operation: paymentcryptographydata.reEncryptData,
    actions: ["payment-cryptography:ReEncryptData"],
    keyFields: ["IncomingKeyIdentifier", "OutgoingKeyIdentifier"],
  }),
);
